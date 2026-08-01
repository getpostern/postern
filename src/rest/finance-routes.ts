// Finance banks-by-institution view (#33, ADR 0021 cluster). A finance-specific, read-only Console
// surface over the #34b deduped data + the existing connector/credential rows. The generic
// GET /api/connectors returns one row per CONNECTOR, so a Plaid credential with N per-Item connectors +
// a SimpleFIN credential render as opaque "configured" rows; this route instead serves ONE row per
// connected institution (grouped by the SAME dedup key as #34b — canonicalInstitution(org_domain,name)
// + last-4 mask), each carrying provider provenance, per-Item health, last_synced_at, and the LIVE
// (deduped) account count. A cross-provider-overlapped bank therefore shows ONCE with both provenances.
//
// Operator-loopback-only (resolveLocal — the seeded operator, all sectors) and wired behind `localOnly`
// (the loopback Host-allowlist) by the composition root, exactly like the other admin reads. NO bearer.
// It WRITES nothing and CHANGES no dedup state — it consumes finance_accounts + connectors +
// provider_credentials read-only (Plaid item_status is consumed as-is; plaid-routes.ts is NOT touched).

import { sendJson, type RouteContext } from "./router.js";
import { resolveLocal } from "../auth/resolve.js";
import { pool } from "../db.js";
import {
  canonicalInstitution,
  classesConflict,
  classifyAccount,
  confirmDedupPair,
  listDedupCandidates,
  listDedupConfirmations,
  unconfirmDedupPair,
  PROVIDER_RANK,
  type CandidatePair,
  type DedupConfirmationSummary,
  type DedupRef,
} from "../core/finance-dedup.js";
import { QueryValidationError } from "../core/query.js";

/** A single provider's contribution to a bank (one per distinct connector under the institution). */
export interface FinanceBankProvider {
  provider: "plaid" | "simplefin" | string;
  connectionId: string;
  itemStatus: string | null; // Plaid /item/get health; null for SimpleFIN (and other providers)
  lastSyncedAt: string | null;
}

/** The wire shape — one row per connected institution (matches apps/web FinanceBankSummary). */
export interface FinanceBankSummary {
  institution: string; // canonical display name (the merged identity)
  /**
   * The stored `finance_accounts.org_domain` for this card, VERBATIM (#89 item 3) — the identifier the
   * dedup engine already keys on server-side (canonicalInstitution's primary signal), served instead of
   * dropped before the wire. A client keys an institution mark off THIS by exact match; it must never
   * fold a human display name onto a brand ("First National Bank of Discovery" is not Discover).
   *
   * `null` = this gateway has no domain for the card (neither connector reported one, or it is a
   * zero-account placeholder) — a stated absence, and the correct cue for the monogram default branch.
   */
  orgDomain: string | null;
  mask: string | null; // last-4, null when unresolved
  /** Stable opaque per-card key (the grouping key). `possibleDuplicate.otherBankKey` and the
   *  dedup-candidates route's `aBankKey`/`bBankKey` reference it, so the Console joins cards to
   *  confirmable pairs by served-key EQUALITY — zero FE dedup logic (dedup-trust-batch, child C). */
  bankKey: string;
  dedupGroupId: string | null; // from #34b (the merged-bank anchor); null = single-provider bank
  providers: FinanceBankProvider[];
  accountCount: number; // live (deduped) accounts under this institution
  health: "ok" | "action_required" | "error" | "unknown";
  unmergedDuplicate: boolean; // same mask, disagreeing canonical institution -> flagged un-merged pair
  classConflict: boolean; // same-key live pair the #34b class guard deliberately refused to merge
  /** SERVER-computed (listDedupCandidates): this card and `otherBankKey`'s card look like the same
   *  account (same canonical institution, compatible currency/class) but lack mask proof, so the
   *  engine will never auto-merge them — the operator may confirm the merge (ground truth). */
  possibleDuplicate?: { otherBankKey: string; confirmable: true };
  /** This card is a merge the operator confirmed (state 'applied'); reversible via the id. */
  confirmedMerge?: { confirmationId: string };
  /** A stored confirmation covers this card's account(s) but a currency/class conflict developed —
   *  the engine refuses the merge FAIL-OPEN (reals serve; the confirmation is kept, never honored). */
  confirmationSuspended?: { confirmationId: string; reason: "currency" | "class" };
}

/** The dedup annotations input — child A's served candidate/confirmation state (see summarizeBanks). */
export interface BankDedupInputs {
  candidates: CandidatePair[];
  confirmations: DedupConfirmationSummary[];
}

type Health = FinanceBankSummary["health"];

/** Severity order for the worst-wins health rollup. */
const HEALTH_RANK: Record<Health, number> = { ok: 0, unknown: 1, action_required: 2, error: 3 };

/** Map a Plaid /item/get item_status (ok | action_required | transient | dead) to the view's health. */
function plaidHealthFromItemStatus(s: string | null): Health {
  switch (s) {
    case "ok":
      return "ok";
    case "action_required":
      return "action_required";
    case "transient":
    case "dead":
      return "error";
    default:
      return "unknown";
  }
}

/**
 * One provider entry's health contribution. For Plaid the per-Item item_status drives it (so an
 * action_required Item surfaces as action_required even if the connector is also flagged 'error');
 * only an unknown item_status falls back to the connector status. For non-Plaid providers there is no
 * per-Item health, so the connector status drives it ('ok' when active).
 */
function providerHealth(provider: string, itemStatus: string | null, connectorStatus: string): Health {
  if (provider === "plaid") {
    const h = plaidHealthFromItemStatus(itemStatus);
    if (h !== "unknown") return h;
    if (connectorStatus === "error" || connectorStatus === "revoked") return "error";
    return "unknown";
  }
  if (connectorStatus === "error" || connectorStatus === "revoked") return "error";
  if (connectorStatus === "paused") return "unknown";
  return "ok";
}

/** Lower provider-rank first (plaid < simplefin < unknown), then connectionId — a stable order. */
function rankOf(provider: string): number {
  return Object.hasOwn(PROVIDER_RANK, provider) ? PROVIDER_RANK[provider] : 99;
}

/** One loaded finance_accounts row joined to its connector + credential. */
export interface AccountRow {
  id: string;
  connection_id: string;
  mask: string | null;
  institution_name: string | null;
  org_domain: string | null;
  currency: string | null;
  account_type: string | null; // classifyAccount input (the #33 class-conflict flag)
  name: string | null; // classifyAccount input
  raw: unknown; // classifyAccount input (holdings presence); null on the synthetic winner
  dedup_status: string | null;
  dedup_group_id: string | null;
  shadowed_by_id: string | null;
  source_object_id: string | null;
  provider: string;
  connector_status: string;
  last_synced_at: string | null;
  item_status: string | null;
}

/**
 * A finance CONNECTOR (connectors × its credential), independent of whether it has cached any accounts.
 * Used to surface EVERY finance connector — a never-synced / mid-onboarding / errored connector with zero
 * served accounts has no AccountRow, so without this it would vanish from the banks view AND (since the
 * Console pulls finance out of the generic table) become unmanageable. One zero-account card per such row.
 */
export interface FinanceConnectorRow {
  connection_id: string;
  provider: string;
  connector_status: string;
  last_synced_at: string | null;
  item_status: string | null;
  external_item_id: string | null;
}

/** A row is the SYNTHETIC enriched-union winner (not a real provider account). */
function isSynthetic(r: AccountRow): boolean {
  return r.dedup_status === "winner" || (r.source_object_id?.startsWith("union:") ?? false);
}

interface Group {
  key: string;
  canonical: string | null; // the canonical institution (for the unmerged-duplicate cross-check)
  mask: string | null;
  rows: AccountRow[];
}

/** Display label for a finance connector that has cached ZERO accounts (no institution_name yet). */
function connectorPlaceholderLabel(c: FinanceConnectorRow): string {
  if (c.provider === "plaid") return c.external_item_id ? "Plaid" : "Plaid (connecting…)";
  if (c.provider === "simplefin") return "SimpleFIN";
  const titled = c.provider
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return titled || "Unknown institution";
}

/**
 * Group loaded account rows into bank cards. Grouping aligns to #34b's AUTHORITATIVE decisions: a row
 * that already carries a dedup_group_id is grouped EXACTLY by that anchor (matching the engine's merge),
 * so accounts the engine deliberately kept separate never collapse here. A row WITHOUT a group is keyed
 * by canonical institution + mask + currency (the #34b key minus the engine-internal class guard). A row
 * missing canonical or mask stays its OWN group (fail-open: an unkeyed account still shows, one row
 * each) keyed by its id. The group key doubles as the served `bankKey` (stable across calls: dedup
 * group ids, canonical+mask+currency, and account row ids are all stable identifiers).
 */
function groupRows(rows: AccountRow[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const canonical = canonicalInstitution(r.org_domain, r.institution_name);
    const mask = typeof r.mask === "string" && r.mask !== "" ? r.mask : null;
    let key: string;
    let groupCanonical: string | null;
    if (r.dedup_group_id != null) {
      key = `gid:${r.dedup_group_id}`;
      groupCanonical = canonical;
    } else {
      const currency = typeof r.currency === "string" && r.currency !== "" ? r.currency : null;
      const keyed = Boolean(canonical && mask);
      key = keyed ? `cm:${canonical}|${mask}|${currency ?? ""}` : `__unkeyed__:${r.id}`;
      groupCanonical = keyed ? canonical : null;
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, canonical: groupCanonical, mask, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  return groups;
}

/**
 * The `(connection_id|source_object_id) → bankKey` join map over the SAME grouping the banks view
 * serves — used by the dedup-candidates route to stamp `aBankKey`/`bBankKey` on each pair, so the
 * Console matches a confirmable pair to its two cards by key equality (never by re-deriving dedup).
 */
export function bankKeysByRef(rows: AccountRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groupRows(rows).values()) {
    for (const r of g.rows) {
      if (r.source_object_id != null) out.set(`${r.connection_id}|${r.source_object_id}`, g.key);
    }
  }
  return out;
}

/**
 * Compute the banks-by-institution summary for a loaded account set, plus a zero-account card for every
 * finance connector that served no accounts (so any finance connector is always visible + manageable).
 * Pure over its input (the SQL is the only I/O), so it is straightforward to unit-test against fixtures.
 * When `dedup` (child A's candidate/confirmation state) is supplied, each card additionally carries the
 * server-computed `possibleDuplicate` / `confirmedMerge` / `confirmationSuspended` flags — the Console
 * renders served booleans and never re-derives dedup logic.
 */
export function summarizeBanks(
  rows: AccountRow[],
  connectors: FinanceConnectorRow[] = [],
  dedup?: BankDedupInputs,
): FinanceBankSummary[] {
  const groups = groupRows(rows);

  // Cross-group mask collision: a mask mapping to >=2 DISTINCT canonical institutions is the alias-gap
  // the stress-test flagged — surface every group sharing that mask as an un-merged duplicate (flagged,
  // never hidden). Only keyed groups (a real canonical + mask) participate.
  const maskToCanon = new Map<string, Set<string>>();
  for (const g of groups.values()) {
    if (g.canonical && g.mask) {
      let s = maskToCanon.get(g.mask);
      if (!s) {
        s = new Set();
        maskToCanon.set(g.mask, s);
      }
      s.add(g.canonical);
    }
  }

  const out: FinanceBankSummary[] = [];
  // `(conn|soid) → summary` over every grouped row (shadowed reals included, so an APPLIED
  // confirmation's members resolve to their merged card) — the annotation join, built as cards emit.
  const byRef = new Map<string, FinanceBankSummary>();
  for (const g of groups.values()) {
    const reals = g.rows.filter((r) => !isSynthetic(r));

    // providers: one entry per DISTINCT real connector (a synthetic's connection_id is the winner's
    // real connector, already present among the reals, so reals alone are complete).
    const byConn = new Map<string, AccountRow>();
    for (const r of reals) if (!byConn.has(r.connection_id)) byConn.set(r.connection_id, r);
    const providers: FinanceBankProvider[] = [...byConn.values()]
      .sort((a, b) => rankOf(a.provider) - rankOf(b.provider) || (a.connection_id < b.connection_id ? -1 : 1))
      .map((r) => ({
        provider: r.provider,
        connectionId: r.connection_id,
        itemStatus: r.provider === "plaid" ? r.item_status : null,
        lastSyncedAt: r.last_synced_at,
      }));

    // accountCount: the LIVE deduped accounts = rows served by query() (shadowed_by_id is null). For a
    // cross-provider group that is the single synthetic winner; for a single-provider bank it's its
    // unique reals. The shadowed reals are excluded (counted once via the winner).
    const liveRows = g.rows.filter((r) => r.shadowed_by_id == null);
    const accountCount = liveRows.length;

    // classConflict: a non-null-mask group whose LIVE rows span >=2 distinct connections carries a pair
    // the #34b class guard confidently refused to merge (e.g. a depository vs a "Loan (1234)" sharing the
    // last-4) — computed with the ENGINE'S OWN classifier so the display never second-guesses the merge
    // semantics. A merged group's only live row is the synthetic winner (one connection) → stays false.
    // Exactly-4-digit gate: the engine only forms dedup candidates on 4-digit masks, so a group with a
    // non-4-digit mask was refused for the invalid KEY, not the class guard — don't misattribute.
    let classConflict = false;
    if (g.mask != null && /^\d{4}$/.test(g.mask) && new Set(liveRows.map((r) => r.connection_id)).size >= 2) {
      const classes = liveRows.map((r) => classifyAccount(r));
      for (let i = 0; i < classes.length && !classConflict; i++) {
        for (let j = i + 1; j < classes.length && !classConflict; j++) {
          if (classesConflict(classes[i], classes[j])) classConflict = true;
        }
      }
    }

    // dedupGroupId: the #34b anchor shared by the reals + the synthetic; null for a single-provider bank.
    const dedupGroupId = g.rows.find((r) => r.dedup_group_id != null)?.dedup_group_id ?? null;

    // health: worst over the provider entries' per-Item contributions.
    let health: Health = "ok";
    for (const r of byConn.values()) {
      const h = providerHealth(r.provider, r.provider === "plaid" ? r.item_status : null, r.connector_status);
      if (HEALTH_RANK[h] > HEALTH_RANK[health]) health = h;
    }
    if (byConn.size === 0) health = "unknown";

    // institution display name (deterministic): prefer the synthetic winner's institution_name (the
    // best-per-field composite #34b already chose), else the first non-null name in the group (stable
    // because loadAccountRows orders the rows), else the canonical fold, else a neutral placeholder.
    const winnerName = g.rows.find((r) => isSynthetic(r) && r.institution_name)?.institution_name ?? null;
    const institution =
      winnerName ??
      g.rows.find((r) => r.institution_name != null && r.institution_name !== "")?.institution_name ??
      g.canonical ??
      "Unknown institution";

    const unmergedDuplicate = Boolean(g.canonical && g.mask && (maskToCanon.get(g.mask)?.size ?? 0) >= 2);

    // orgDomain (#89 item 3): the SAME deterministic pick the institution label uses — the synthetic
    // winner's value (the best-per-field composite #34b already chose) first, else the first non-empty
    // in the group (stable because loadAccountRows is deterministically ordered), else null. Never
    // derived from the display name: a name-derived value would smuggle the guessing this field exists
    // to delete back in under a domain-shaped field name.
    const orgDomain =
      g.rows.find((r) => isSynthetic(r) && r.org_domain != null && r.org_domain !== "")?.org_domain ??
      g.rows.find((r) => r.org_domain != null && r.org_domain !== "")?.org_domain ??
      null;

    const summary: FinanceBankSummary = {
      institution,
      orgDomain,
      mask: g.mask,
      bankKey: g.key,
      dedupGroupId,
      providers,
      accountCount,
      health,
      unmergedDuplicate,
      classConflict,
    };
    out.push(summary);
    for (const r of g.rows) {
      if (r.source_object_id != null) byRef.set(`${r.connection_id}|${r.source_object_id}`, summary);
    }
  }

  // Surface EVERY finance connector that served no accounts (mid-onboarding / errored / never-synced).
  // A connector already represented among the account-derived banks' providers is NOT re-added.
  const represented = new Set<string>();
  for (const b of out) for (const p of b.providers) represented.add(p.connectionId);
  for (const c of connectors) {
    if (represented.has(c.connection_id)) continue;
    const itemStatus = c.provider === "plaid" ? c.item_status : null;
    out.push({
      institution: connectorPlaceholderLabel(c),
      // A connector that has cached no accounts has no org_domain to report — a stated absence.
      orgDomain: null,
      mask: null,
      bankKey: `conn:${c.connection_id}`,
      dedupGroupId: null,
      providers: [{ provider: c.provider, connectionId: c.connection_id, itemStatus, lastSyncedAt: c.last_synced_at }],
      accountCount: 0,
      health: providerHealth(c.provider, itemStatus, c.connector_status),
      unmergedDuplicate: false,
      classConflict: false,
    });
  }

  // Dedup-trust annotations (child C over child A's served state): pure joins by (conn|soid) —
  // every decision (candidate detection, applied/suspended standing) was made by the engine's own
  // exported fns; this only PLACES the served facts onto the cards they belong to.
  if (dedup) {
    const refOf = (r: DedupRef): string => `${r.connectionId}|${r.sourceObjectId}`;
    for (const p of dedup.candidates) {
      const sa = byRef.get(refOf(p.a));
      const sb = byRef.get(refOf(p.b));
      if (!sa || !sb || sa === sb) continue; // a pair folded onto one card carries nothing to confirm
      if (!sa.possibleDuplicate) sa.possibleDuplicate = { otherBankKey: sb.bankKey, confirmable: true };
      if (!sb.possibleDuplicate) sb.possibleDuplicate = { otherBankKey: sa.bankKey, confirmable: true };
    }
    for (const c of dedup.confirmations) {
      const members = new Set([byRef.get(refOf(c.a)), byRef.get(refOf(c.b))]);
      if (c.state === "applied") {
        // Both members are shadowed into ONE merged card — stamp its operator provenance.
        for (const s of members) if (s && !s.confirmedMerge) s.confirmedMerge = { confirmationId: c.id };
      } else if (c.state === "suspended" && c.suspendedReason != null) {
        // Fail-open refusal: the reals serve (one or two cards) — each carries the suspension.
        for (const s of members) if (s && !s.confirmationSuspended) s.confirmationSuspended = { confirmationId: c.id, reason: c.suspendedReason };
      }
      // 'inactive' (a member missing/tombstoned or the pair contested) serves nothing — no flag.
    }
  }

  // Stable display order: institution name, then mask.
  out.sort(
    (a, b) => a.institution.localeCompare(b.institution) || (a.mask ?? "").localeCompare(b.mask ?? ""),
  );
  return out;
}

/**
 * Load the live finance accounts joined to their connector + credential (read-only). DETERMINISTICALLY
 * ordered (provider-rank → source_object_id → id) so the per-group display picks (institution name,
 * dedup_group_id) are stable run-to-run — an unordered set let labels/ids flake (#33 FIX 2).
 */
async function loadAccountRows(userId: string): Promise<AccountRow[]> {
  const res = await pool.query(
    `select a.id, a.connection_id, a.mask, a.institution_name, a.org_domain, a.currency,
            a.account_type, a.name, a.raw,
            a.dedup_status, a.dedup_group_id, a.shadowed_by_id, a.source_object_id,
            c.provider, c.status as connector_status, c.last_synced_at,
            pc.item_status
       from finance_accounts a
       join connectors c on c.id = a.connection_id
       left join provider_credentials pc on pc.id = c.credential_id
      where a.user_id = $1 and a.deleted_at is null
      order by case c.provider when 'plaid' then 0 when 'simplefin' then 1 else 99 end,
               a.source_object_id, a.id`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    connection_id: r.connection_id as string,
    mask: (r.mask as string | null) ?? null,
    institution_name: (r.institution_name as string | null) ?? null,
    org_domain: (r.org_domain as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    account_type: (r.account_type as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    raw: r.raw ?? null,
    dedup_status: (r.dedup_status as string | null) ?? null,
    dedup_group_id: (r.dedup_group_id as string | null) ?? null,
    shadowed_by_id: (r.shadowed_by_id as string | null) ?? null,
    source_object_id: (r.source_object_id as string | null) ?? null,
    provider: r.provider as string,
    connector_status: r.connector_status as string,
    last_synced_at: r.last_synced_at ? new Date(r.last_synced_at as string).toISOString() : null,
    item_status: (r.item_status as string | null) ?? null,
  }));
}

/** Load EVERY finance connector (read-only) so a zero-account connector still surfaces + is manageable. */
async function loadFinanceConnectors(userId: string): Promise<FinanceConnectorRow[]> {
  const res = await pool.query(
    `select c.id as connection_id, c.provider, c.status as connector_status, c.last_synced_at,
            pc.item_status, pc.external_item_id
       from connectors c
       left join provider_credentials pc on pc.id = c.credential_id
      where c.user_id = $1 and c.sector = 'finance'
      order by c.created_at, c.id`,
    [userId],
  );
  return res.rows.map((r) => ({
    connection_id: r.connection_id as string,
    provider: r.provider as string,
    connector_status: r.connector_status as string,
    last_synced_at: r.last_synced_at ? new Date(r.last_synced_at as string).toISOString() : null,
    item_status: (r.item_status as string | null) ?? null,
    external_item_id: (r.external_item_id as string | null) ?? null,
  }));
}

/**
 * GET /api/finance/banks — the banks-by-institution summary. Operator-scoped (resolveLocal); wired
 * behind localOnly (loopback Host-allowlist) by the composition root. Returns FinanceBankSummary[],
 * each card carrying the server-computed possibleDuplicate / confirmedMerge / confirmationSuspended
 * state (dedup-trust-batch child C) — the Console renders served facts, never re-derives dedup.
 */
export async function financeBanksRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  const [rows, connectors, candidates, confirmations] = await Promise.all([
    loadAccountRows(auth.userId),
    loadFinanceConnectors(auth.userId),
    listDedupCandidates(auth.userId),
    listDedupConfirmations(auth.userId),
  ]);
  sendJson(ctx.res, 200, summarizeBanks(rows, connectors, { candidates, confirmations }));
}

/** The dedup-candidates wire shape: child A's CandidatePair + the two cards it spans (bank keys). */
export interface FinanceDedupCandidateWire extends CandidatePair {
  aBankKey: string | null;
  bBankKey: string | null;
}

/**
 * GET /api/finance/dedup-candidates — every maskless possibly-the-same pair the engine cannot prove
 * (child A's listDedupCandidates verbatim), each stamped with `aBankKey`/`bBankKey` so the Console
 * joins a Confirm click back to a pair by served-key equality. Operator-loopback (localOnly at the
 * composition root); read-only.
 */
export async function financeDedupCandidatesRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  const [rows, candidates] = await Promise.all([loadAccountRows(auth.userId), listDedupCandidates(auth.userId)]);
  const keys = bankKeysByRef(rows);
  const wire: FinanceDedupCandidateWire[] = candidates.map((p) => ({
    ...p,
    aBankKey: keys.get(`${p.a.connectionId}|${p.a.sourceObjectId}`) ?? null,
    bBankKey: keys.get(`${p.b.connectionId}|${p.b.sourceObjectId}`) ?? null,
  }));
  sendJson(ctx.res, 200, wire);
}

/**
 * POST /api/finance/dedup-confirmations — body `{ a: { connectionId, sourceObjectId }, b: { … } }`.
 * Thin wrapper: child A's confirmDedupPair owns validation (typed 400s naming the field), ownership
 * (both connections must be the operator's), the audit line, and the reconcile that applies the merge.
 * Returns the persisted DedupConfirmation (idempotent on re-confirm). Operator-loopback (localOnly).
 */
export async function financeDedupConfirmRoute(ctx: RouteContext, body: unknown): Promise<void> {
  const auth = await resolveLocal();
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new QueryValidationError("body must be { a: { connectionId, sourceObjectId }, b: { connectionId, sourceObjectId } }");
  }
  const { a, b } = body as { a?: unknown; b?: unknown };
  const confirmation = await confirmDedupPair(auth.userId, a as DedupRef, b as DedupRef);
  sendJson(ctx.res, 200, confirmation);
}

/**
 * DELETE /api/finance/dedup-confirmations/:id — reverse a confirmed merge. Thin wrapper: child A's
 * unconfirmDedupPair owns ownership + audit + the dissolving reconcile (synthetic dropped, reals
 * un-shadowed). 404 on an unknown/foreign id. No confirm-token — the action is reversible (tokens
 * are for destructive verbs). Operator-loopback (localOnly at the composition root).
 */
export async function financeDedupUnconfirmRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  await unconfirmDedupPair(auth.userId, ctx.params.id ?? "");
  sendJson(ctx.res, 200, { ok: true });
}
