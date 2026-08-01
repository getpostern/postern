// Cross-provider deterministic finance dedup — the 3-row synthetic-union engine (#34b, ADR 0021).
//
// The same real-world account/card connected via TWO providers (e.g. Amex via Plaid + SimpleFIN) is
// deduped DETERMINISTICALLY within finance (no LLM, no fuzzy, within-sector only — DISTINCT from the
// deferred chapter-2 cross-domain semantic entity resolution). For each cross-provider dedup group the
// store holds THREE rows:
//   • both provider rows kept PRISTINE (each a faithful normalize() of its OWN raw, fully drillable,
//     never mutated) and SHADOWED — dedup_status='shadow', shadowed_by_id → the synthetic winner;
//   • ONE explicitly-SYNTHETIC winner row (source_object_id='union:…', raw=null, dedup_status='winner')
//     whose normalized columns are the best-per-field composite over the group.
// query() serves the synthetic winner + every single-provider unique row, and HIDES both the shadows and
// the now-shadowed reals with ONE reversible `shadowed_by_id is null` predicate (folded into the partial
// indexes). getRecord/fetchLive stay UNFILTERED so both real rows drill verbatim.
//
// reconcileFinance(userId) recomputes from the current LIVE set each run — diff-only CREATE/RECOMPUTE/DROP
// of the synthetic rows — in ONE transaction under a per-user advisory lock (idempotent: a converged state
// writes nothing). It is wired as the final awaited step of every finance sync/ingest AND inside
// disconnect/revoke/erase, so a removed provider immediately drops/recomputes the synthetic and a sole
// survivor un-shadows. It imports NO connector code (pure set-ops over Postgres).
//
// Three passes: accounts (mask + canonical institution) → transactions (±1-day count-reconcile within
// credit+depository groups) → holdings (#36: symbol-keyed within ANY account group — see reconcileHoldings).
//
// Confirmed merges (finance-dedup-trust-batch): when two accounts look like the same one but lack
// proof (≥1 side maskless), the OPERATOR can confirm the pair once (confirmDedupPair). Confirmations
// persist in their own table (finance_dedup_confirmations — they survive recompute and row churn) and
// are consumed HERE, inside reconcileAccounts' transaction: a confirmed pair whose members both exist
// live forms a group under key 'confirmed:<pairhash>', bypassing ONLY the mask gate — the currency,
// class-guard, and intra-item refusals still apply, and a refusal SUSPENDS the confirmation fail-open
// (group not formed, row kept — never honored, never silently deleted). Ground truth, never fuzzy.

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { audit, type AuditTool } from "../audit/index.js";
import { QueryValidationError } from "./query.js";
import { NotFoundError } from "./context.js";

// ── Single-source-of-truth policy constants (the comparator's only knobs) ─────────────────────────

/** Lower wins the provider-rank tiebreak (rule 3). An unknown provider sorts last. */
export const PROVIDER_RANK: Record<string, number> = { plaid: 0, simplefin: 1 };

/**
 * Whether a provider's `balance_at` is NATIVELY synthetic (rule 1: real beats synthetic). Plaid reports
 * no balance timestamp (we stamp ingest time), SimpleFIN reports a real balance-date. Drives the
 * balance-tuple co-selection so the synthetic serves SimpleFIN's (balance, real as-of) together.
 */
export const BALANCE_TIME_NATIVELY_SYNTHETIC: Record<string, boolean> = { plaid: true, simplefin: false };

/**
 * The materialized normalized columns per object — the SINGLE source the synthetic-INSERT column list AND
 * the RECOMPUTE diff are BOTH derived from (the lockstep invariant; a test asserts the computed winner's
 * key set is exactly this). Identity/marker columns (id, source_object_id, dedup_status, shadowed_by_id,
 * dedup_group_id, account_source_id) are NOT comparator outputs — reconcile sets them.
 */
export const ENRICHED_COLUMNS: {
  account: readonly string[];
  transaction: readonly string[];
  holding: readonly string[];
} = {
  account: [
    "name",
    "account_type",
    "currency",
    "current_balance",
    "available_balance",
    "balance_at",
    "balance_at_is_synthetic",
    "institution_name",
    "org_domain",
    "mask",
  ],
  transaction: [
    "posted_at",
    "amount",
    "currency",
    "description",
    "merchant",
    "pending",
    "category",
    "payment_channel",
    "authorized_at",
    "location_city",
    "location_region",
  ],
  holding: [
    "symbol",
    "name",
    "security_type",
    "quantity",
    "market_value",
    "cost_basis",
    "currency",
    "as_of",
  ],
};

export interface ReconcileResult {
  accountGroups: number; // cross-provider account dedup groups found (>=2 connections sharing the key)
  syntheticAccounts: number; // synthetic account winners present after this run
  syntheticTxns: number; // synthetic txn winners present after this run
  syntheticHoldings: number; // synthetic holding winners present after this run (#36)
  accountsShadowed: number; // real account rows pointed at a synthetic
  txnsShadowed: number;
  holdingsShadowed: number; // real holding rows pointed at a synthetic (#36)
  ambiguous: number; // rows left LIVE + flagged (count-conflict / class / mask / symbol collision); never dropped
  created: number; // synthetic rows created this run (diff-only)
  recomputed: number; // synthetic rows whose columns changed this run (diff-only)
  dropped: number; // synthetic rows removed this run (group fell below 2 providers) + tombstoned-dissolved synths GC'd (#37)
}

// ── Institution canonicalization (deterministic, NEVER fuzzy) ─────────────────────────────────────

/** A tiny DETERMINISTIC alias map applied to the name-fold (domain-absent fallback). NEVER fuzzy. */
const INSTITUTION_ALIAS: Record<string, string> = {
  amex: "americanexpress",
  americanexpressco: "americanexpress",
};

/** Domain-primary: the registrable second-level label, lowercased + punctuation-stripped. */
function canonFromDomain(orgDomain: string | null | undefined): string | null {
  if (typeof orgDomain !== "string" || orgDomain === "") return null;
  let host = orgDomain.toLowerCase().trim();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length === 0) return null;
  const sld = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  const folded = sld.replace(/[^a-z0-9]/g, "");
  return folded || null;
}

/** Name-fold: lowercase, drop the (dddd) mask suffix + "(updated monthly)", strip non-alnum, alias-map. */
function canonFromName(name: string | null | undefined): string | null {
  if (typeof name !== "string" || name === "") return null;
  let s = name.toLowerCase();
  s = s.replace(/\(updated monthly\)/g, " ");
  s = s.replace(/\(\s*\d{4}\s*\)/g, " "); // strip the last-4 (dddd) suffix when it's on the institution name
  s = s.replace(/[^a-z0-9]+/g, "");
  s = INSTITUTION_ALIAS[s] ?? s;
  return s || null;
}

/**
 * Canonical institution key — `org.domain` PRIMARY (far more stable than the display name), with a
 * deterministic alias-map + name-fold FALLBACK when the domain is absent. NEVER fuzzy: an unknown
 * disagreement stays a visible dupe (fail-open). Exported for #33's banks-by-institution grouping.
 */
export function canonicalInstitution(
  orgDomain: string | null | undefined,
  name: string | null | undefined,
): string | null {
  return canonFromDomain(orgDomain) ?? canonFromName(name);
}

// ── Internal helpers ──────────────────────────────────────────────────────────────────────────────

/** Coarse account class (exported for the #33 class-conflict display; the engine's exact semantics). */
export type AcctClass = "asset" | "liability" | "investment" | "ambiguous";

/** A loaded provider (real) row — accounts + txns share the index-signature shape for the comparator.
 *  The three classifier inputs are declared (still `unknown`, same as the index signature) so Member
 *  satisfies the exported classifyAccount's structural parameter type. */
type Member = Record<string, unknown> & {
  id: string;
  provider: string;
  source_object_id: string;
  account_type?: unknown;
  name?: unknown;
  raw?: unknown;
};

const EXACTLY_FOUR_DIGITS = /^\d{4}$/;

/** A deterministic (stable-across-runs) uuid-v5-shaped id from a seed (the dedup-group anchor). */
function deterministicUuid(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function rankOf(provider: string): number {
  return Object.hasOwn(PROVIDER_RANK, provider) ? PROVIDER_RANK[provider] : 99;
}

/** Provider-rank → source_object_id → id total order (the absolute-final deterministic tiebreak). */
function cmpMembers(a: Member, b: Member): number {
  const ra = rankOf(a.provider);
  const rb = rankOf(b.provider);
  if (ra !== rb) return ra - rb;
  if (a.source_object_id !== b.source_object_id) return a.source_object_id < b.source_object_id ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** General per-field rule: NON-NULL-over-NULL, then provider-rank → source_object_id → id. */
function selectBest(members: Member[], col: string): unknown {
  const sorted = [...members].sort((x, y) => {
    const xn = x[col] == null ? 1 : 0;
    const yn = y[col] == null ? 1 : 0;
    if (xn !== yn) return xn - yn;
    return cmpMembers(x, y);
  });
  return sorted[0]?.[col] ?? null;
}

/** The provider-rank winner of a group — its connection_id anchors the synthetic. */
function winnerMember(members: Member[]): Member {
  return [...members].sort(cmpMembers)[0];
}

/** Coarse account class — a GUARD, never a key component (never balance-sign; ADR 0021). Exported so
 *  the #33 banks view can flag a same-key pair the guard refused with EXACTLY the engine's semantics. */
export function classifyAccount(member: { account_type?: unknown; name?: unknown; raw?: unknown }): AcctClass {
  const at = member.account_type;
  if (typeof at === "string" && at !== "") {
    const t = at.toLowerCase();
    if (t === "credit" || t === "loan" || t === "mortgage") return "liability";
    if (t === "depository" || t === "checking" || t === "savings" || t === "cash") return "asset";
    if (t === "investment" || t === "brokerage") return "investment";
  }
  const raw = member.raw;
  if (raw && typeof raw === "object") {
    const holdings = (raw as { holdings?: unknown }).holdings;
    if (Array.isArray(holdings) && holdings.length > 0) return "investment"; // robust
  }
  const name = typeof member.name === "string" ? member.name.toLowerCase() : "";
  if (name) {
    // Liability keywords first. Asset keywords are deliberately the UNAMBIGUOUS ones — NOT "cash" (an
    // Amex "Blue Cash" card would mis-classify as an asset and lose its dedup; ADR 0021 fail-open prefers
    // AMBIGUOUS, which still merges with a confident-liability peer).
    if (/card|credit|loan|mortgage/.test(name)) return "liability";
    if (/checking|savings|deposit|debit/.test(name)) return "asset";
  }
  return "ambiguous";
}

/** Two classes CONFIDENTLY conflict only when both are non-ambiguous AND differ (else merge — fail-open). */
export function classesConflict(a: AcctClass, b: AcctClass): boolean {
  return a !== "ambiguous" && b !== "ambiguous" && a !== b;
}

/** A confirmed pair's refusal check — EXACTLY the organic hard gates minus the mask gate (which the
 *  confirmation exists to bypass). Currency: two distinct NON-NULL currencies. Class: a confident
 *  (both non-ambiguous) class disagreement. account_type label mismatch is deliberately not here —
 *  the operator's ground truth beats a provider type-label squabble when the coarse class agrees. */
function pairConflictReason(
  a: { currency?: unknown; account_type?: unknown; name?: unknown; raw?: unknown },
  b: { currency?: unknown; account_type?: unknown; name?: unknown; raw?: unknown },
): "currency" | "class" | null {
  if (a.currency != null && b.currency != null && a.currency !== b.currency) return "currency";
  if (classesConflict(classifyAccount(a), classifyAccount(b))) return "class";
  return null;
}

/** The group's class — the first non-ambiguous member class, else 'ambiguous'. */
function groupClassOf(members: Member[]): AcctClass {
  for (const m of members) {
    const c = classifyAccount(m);
    if (c !== "ambiguous") return c;
  }
  return "ambiguous";
}

/** Balance-tuple member: non-null balance_at first, then REAL (native non-synthetic) first, then rank. */
function balanceMember(members: Member[]): Member {
  return [...members].sort((x, y) => {
    const xn = x.balance_at == null ? 1 : 0;
    const yn = y.balance_at == null ? 1 : 0;
    if (xn !== yn) return xn - yn;
    const xs = BALANCE_TIME_NATIVELY_SYNTHETIC[x.provider] ? 1 : 0;
    const ys = BALANCE_TIME_NATIVELY_SYNTHETIC[y.provider] ? 1 : 0;
    if (xs !== ys) return xs - ys;
    return cmpMembers(x, y);
  })[0];
}

/** `available_balance` per-type: SimpleFIN for depository; else Plaid (limit-derived), 0/charge-card → null. */
function selectAvailable(groupClass: AcctClass, members: Member[]): unknown {
  const plaid = members.find((m) => m.provider === "plaid");
  const sfin = members.find((m) => m.provider === "simplefin");
  if (groupClass === "asset") {
    return sfin?.available_balance ?? plaid?.available_balance ?? null;
  }
  // credit / loan / investment / ambiguous → prefer Plaid (limit-derived); SimpleFIN credit-available is garbage.
  const pa = plaid?.available_balance ?? null;
  if (pa == null) return null;
  if (Number(pa) === 0) return null; // a Plaid limit=0 charge card → a misleading $0 → null
  return pa;
}

/** The synthetic account winner's enriched columns (keys === ENRICHED_COLUMNS.account, in order). */
function computeAccountWinner(members: Member[], groupClass: AcctClass): Record<string, unknown> {
  const bal = balanceMember(members);
  return {
    name: selectBest(members, "name"),
    account_type: selectBest(members, "account_type"),
    currency: selectBest(members, "currency"),
    current_balance: bal.current_balance ?? null,
    available_balance: selectAvailable(groupClass, members),
    balance_at: bal.balance_at ?? null,
    balance_at_is_synthetic: bal.balance_at_is_synthetic ?? false,
    institution_name: selectBest(members, "institution_name"),
    org_domain: selectBest(members, "org_domain"),
    mask: selectBest(members, "mask"),
  };
}

/** The synthetic txn winner's enriched columns (keys === ENRICHED_COLUMNS.transaction, all generic). */
function computeTxnWinner(members: Member[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of ENRICHED_COLUMNS.transaction) out[col] = selectBest(members, col);
  return out;
}

/** Normalize a value for a column-equality diff (Date → ISO, bool → t/f, else String). */
function normCmp(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "boolean") return v ? "t" : "f";
  return String(v);
}

/** A loaded row's whole-row column equality against a desired column map (over a fixed column list). */
function rowMatches(existing: Record<string, unknown>, desired: Record<string, unknown>, cols: readonly string[]): boolean {
  for (const c of cols) {
    if (normCmp(existing[c]) !== normCmp(desired[c])) return false;
  }
  return true;
}

/** Build "$1, $2, …" + the value array for an ordered insert/update column list. */
function placeholders(n: number, start = 1): string {
  return Array.from({ length: n }, (_, i) => `$${i + start}`).join(", ");
}

/**
 * CREATE a synthetic winner row as an UPSERT on (connection_id, source_object_id) — NEVER a blind
 * INSERT (review fold, spec finance-holding). A pre-tombstoned union ZOMBIE (or a malicious provider
 * emitting a soid inside the engine-reserved 'union:%' namespace) holds the unique key while being
 * invisible to the existing-synth diff (which filters `deleted_at is null`); a blind INSERT then
 * collides, the WHOLE reconcile transaction rolls back, and — because the runner's
 * reconcileFinanceBestEffort swallows it — all finance dedup freezes permanently. On conflict the row
 * is FULLY recomputed: every non-key column the caller passes (all normalized cols + dedup markers +
 * raw=null + shadowed_by_id=null), PLUS deleted_at = null (the zombie is resurrected) and
 * ingested_at = now(). Table names are literal engine-owned constants; all values parameterized.
 */
async function upsertSynthetic(
  client: PoolClient,
  table: "finance_accounts" | "finance_transactions" | "finance_holdings",
  cols: string[],
  vals: unknown[],
): Promise<string> {
  const sets = cols
    .filter((c) => c !== "connection_id" && c !== "source_object_id") // the conflict keys
    .map((c) => `"${c}" = excluded."${c}"`)
    .join(", ");
  const res = await client.query(
    `insert into ${table} (${cols.map((c) => `"${c}"`).join(", ")})
     values (${placeholders(vals.length)})
     on conflict (connection_id, source_object_id)
       do update set ${sets}, deleted_at = null, ingested_at = now()
     returning id`,
    vals,
  );
  return res.rows[0].id as string;
}

/** Floor an ISO/Date timestamp to a UTC day number (for the ±1-day txn bucket match). */
function dayNumber(v: unknown): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 86_400_000);
}

// ── The engine ──────────────────────────────────────────────────────────────────────────────────

/** A decided cross-provider account group carried from the account pass into the txn + holdings passes. */
interface ValidGroup {
  dedupGroupId: string;
  syntheticSourceObjId: string;
  /** The human-readable group anchor '<inst>:<mask>' — the holdings pass builds 'union:holding:<groupKey>:<SYMBOL>'. */
  groupKey: string;
  members: Member[];
  groupClass: AcctClass;
}

export async function reconcileFinance(userId: string): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    accountGroups: 0,
    syntheticAccounts: 0,
    syntheticTxns: 0,
    syntheticHoldings: 0,
    accountsShadowed: 0,
    txnsShadowed: 0,
    holdingsShadowed: 0,
    ambiguous: 0,
    created: 0,
    recomputed: 0,
    dropped: 0,
  };

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Per-user advisory lock: the two finance connectors poll on the SAME cadence, so two reconcile calls
    // can overlap; the lock serializes them per-user (the second runs against the first's committed state
    // and converges). Never blocks other users or non-finance work.
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [userId]);

    const validGroups = await reconcileAccounts(client, userId, result);
    await reconcileTransactions(client, userId, validGroups, result);
    await reconcileHoldings(client, userId, validGroups, result);

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return result;
}

// ── Account pass ────────────────────────────────────────────────────────────────────────────────

async function reconcileAccounts(
  client: PoolClient,
  userId: string,
  result: ReconcileResult,
): Promise<ValidGroup[]> {
  const accountCols = ENRICHED_COLUMNS.account;

  // Tombstone-only marker reset (#37). No pair clause — accounts have no pair-set concept; every
  // LIVE account is a candidate each run, so the only reset gap is a marked real that got TOMBSTONED:
  // invisible to the candidate load (`deleted_at is null`), it would keep stale markers forever.
  await client.query(
    `update finance_accounts set dedup_status = null, shadowed_by_id = null, dedup_group_id = null
      where user_id = $1 and source_object_id not like 'union:%'
        and (dedup_status is not null or dedup_group_id is not null or shadowed_by_id is not null)
        and deleted_at is not null`,
    [userId],
  );

  // The user's confirmed pairs (operator ground truth — finance-dedup-trust-batch), loaded up front
  // and consumed after the organic grouping below. Deterministic order (created_at, id) so a member
  // shared by two confirmations resolves the same way every run.
  const confRes = await client.query(
    `select id, a_connection_id, a_source_object_id, b_connection_id, b_source_object_id
       from finance_dedup_confirmations where user_id = $1 order by created_at, id`,
    [userId],
  );
  const confirmations = confRes.rows as Array<{
    id: string;
    a_connection_id: string;
    a_source_object_id: string;
    b_connection_id: string;
    b_source_object_id: string;
  }>;

  // Load the live, non-synthetic accounts (the candidates) + their provider + current markers.
  const candRes = await client.query(
    `select a.id, a.connection_id, a.source_object_id, a.raw, c.provider,
            a.dedup_status, a.dedup_group_id, a.shadowed_by_id,
            ${accountCols.map((c) => `a."${c}"`).join(", ")}
       from finance_accounts a
       join connectors c on c.id = a.connection_id
      where a.user_id = $1 and a.deleted_at is null and (a.dedup_status is distinct from 'winner')`,
    [userId],
  );
  const candidates = candRes.rows as Member[];

  // Existing synthetic account winners (for diff-only CREATE/RECOMPUTE/DROP).
  const synthRes = await client.query(
    `select id, connection_id, source_object_id, dedup_group_id,
            ${accountCols.map((c) => `"${c}"`).join(", ")}
       from finance_accounts
      where user_id = $1 and dedup_status = 'winner' and deleted_at is null`,
    [userId],
  );
  const existingSynths = synthRes.rows as Array<Record<string, unknown> & { id: string; dedup_group_id: string | null }>;

  // Group the candidates by canonical institution + exactly-4-digit mask.
  const groups = new Map<string, Member[]>();
  const desired = new Map<string, { status: string; groupId: string | null; shadowedById: string | null }>();
  for (const a of candidates) {
    const inst = canonicalInstitution(a.org_domain as string | null, a.institution_name as string | null);
    const mask = typeof a.mask === "string" ? a.mask : null;
    if (!inst || !mask || !EXACTLY_FOUR_DIGITS.test(mask)) {
      desired.set(a.id, { status: "unique", groupId: null, shadowedById: null }); // no key → fail-open visible dupe
      continue;
    }
    const key = `${inst}|${mask}`;
    const arr = groups.get(key);
    if (arr) arr.push(a);
    else groups.set(key, [a]);
  }

  const validGroups: ValidGroup[] = [];
  // The dedup_group_ids that SHOULD have a synthetic this run (drives the DROP diff).
  const liveGroupIds = new Set<string>();

  for (const [key, members] of groups) {
    const connIds = new Set(members.map((m) => m.connection_id as string));
    const perConn = new Map<string, number>();
    for (const m of members) perConn.set(m.connection_id as string, (perConn.get(m.connection_id as string) ?? 0) + 1);
    const currencies = new Set(members.map((m) => m.currency).filter((c) => c != null));
    const classes = members.map(classifyAccount);

    const singleProvider = connIds.size < 2;
    const intraItemCollision = [...perConn.values()].some((n) => n > 1);
    const currencyConflict = currencies.size > 1;
    let classConflict = false;
    let typeConflict = false;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (classesConflict(classes[i], classes[j])) classConflict = true;
        const ti = members[i].account_type;
        const tj = members[j].account_type;
        if (ti != null && tj != null && ti !== tj) typeConflict = true;
      }
    }

    if (singleProvider || currencyConflict || classConflict || typeConflict) {
      // Fail-open: leave every member a visible LIVE dupe, no synthetic.
      for (const m of members) desired.set(m.id, { status: "unique", groupId: null, shadowedById: null });
      continue;
    }
    if (intraItemCollision) {
      // One Item contributes >1 row with the same mask → never auto-merge; flag ambiguous, leave live.
      for (const m of members) desired.set(m.id, { status: "ambiguous", groupId: null, shadowedById: null });
      continue;
    }

    // A genuine cross-provider group → a synthetic winner; mark reals shadow.
    const inst = key.slice(0, key.lastIndexOf("|"));
    const mask = key.slice(key.lastIndexOf("|") + 1);
    const dedupGroupId = deterministicUuid(`acct:${key}`);
    const syntheticSourceObjId = `union:${inst}:${mask}`;
    const groupClass = groupClassOf(members);
    validGroups.push({ dedupGroupId, syntheticSourceObjId, groupKey: `${inst}:${mask}`, members, groupClass });
    liveGroupIds.add(dedupGroupId);
    result.accountGroups++;
    for (const m of members) desired.set(m.id, { status: "shadow", groupId: dedupGroupId, shadowedById: null });
  }

  // ── Confirmed pairs (operator ground truth — finance-dedup-trust-batch) ────────────────────────
  // A confirmed pair whose members BOTH exist live forms a group under key 'confirmed:<pairhash>',
  // bypassing ONLY the mask gate. The currency, class-guard, and intra-item refusals still apply —
  // a refusal SUSPENDS the confirmation fail-open (group not formed; the row is KEPT, never silently
  // deleted; listDedupConfirmations serves the suspension state). A member already claimed by an
  // organic group (or flagged ambiguous by the intra-Item mask-collision rule) is contested — the
  // confirmation stays unapplied rather than fighting the organic pass. account_type label
  // disagreement is deliberately NOT a refusal here: the operator's ground truth beats a provider
  // type-label squabble when the coarse CLASS agrees (the class guard still protects).
  const byPairKey = new Map<string, Member>();
  for (const a of candidates) byPairKey.set(`${a.connection_id as string}|${a.source_object_id}`, a);
  const claimed = new Set<string>();
  for (const g of validGroups) for (const m of g.members) claimed.add(m.id);
  for (const c of confirmations) {
    const ma = byPairKey.get(`${c.a_connection_id}|${c.a_source_object_id}`);
    const mb = byPairKey.get(`${c.b_connection_id}|${c.b_source_object_id}`);
    if (!ma || !mb) continue; // a member is gone/tombstoned → the confirmation is inert (kept)
    if (claimed.has(ma.id) || claimed.has(mb.id)) continue; // contested by an already-formed group
    if (desired.get(ma.id)?.status === "ambiguous" || desired.get(mb.id)?.status === "ambiguous") continue;
    if (ma.connection_id === mb.connection_id) continue; // intra-item refusal (defense in depth — confirm rejects these)
    if (pairConflictReason(ma, mb) != null) continue; // currency/class refusal → SUSPENDED fail-open
    const pairhash = confirmationPairHash(
      { connectionId: c.a_connection_id, sourceObjectId: c.a_source_object_id },
      { connectionId: c.b_connection_id, sourceObjectId: c.b_source_object_id },
    );
    const groupKey = `confirmed:${pairhash}`; // → winner soid 'union:confirmed:<pairhash>' — its own
    const dedupGroupId = deterministicUuid(`acct:${groupKey}`); //   sub-namespace, never collides with
    const members = [ma, mb]; //                                     an organic 'union:<inst>:<mask>'
    validGroups.push({ dedupGroupId, syntheticSourceObjId: `union:${groupKey}`, groupKey, members, groupClass: groupClassOf(members) });
    liveGroupIds.add(dedupGroupId);
    result.accountGroups++;
    claimed.add(ma.id);
    claimed.add(mb.id);
    for (const m of members) desired.set(m.id, { status: "shadow", groupId: dedupGroupId, shadowedById: null });
  }

  // DROP synthetics whose group is no longer valid (FK on delete set null auto-un-shadows the survivor).
  for (const s of existingSynths) {
    if (s.dedup_group_id == null || !liveGroupIds.has(s.dedup_group_id)) {
      await client.query(`delete from finance_accounts where id = $1 and user_id = $2`, [s.id, userId]);
      result.dropped++;
    }
  }

  // GC (#37, PAIR-keyed since finance-dedup-trust-batch): hard-DELETE any TOMBSTONED union winner
  // whose (connection_id, source_object_id) PAIR is not a desired synthetic this run. Invisible to
  // the DROP diff (the existing-synth load filters `deleted_at is null`), it would otherwise squat on
  // the unique key forever. Keying on the PAIR — not the group id — closes the ADR 0022 residual: a
  // tombstoned winner moved to a NON-anchor connection still matched its (live) group id and survived
  // every sweep, and a later synthetic UPDATE onto its unique key collided → whole-transaction
  // rollback → reconcileFinanceBestEffort swallow → all finance dedup frozen. A tombstoned synth at
  // exactly the desired pair is KEPT — it must reach upsertSynthetic's resurrect path, which is why
  // this sweep stays SEPARATE from the existing-synth load (widening that load would route the
  // tombstoned-but-desired synth into the RECOMPUTE branch, which never clears deleted_at).
  // Hard-delete is safe and lossless: a synthetic is fabricated (raw = null), fully recomputable, and
  // the FK `shadowed_by_id … on delete set null` auto-un-shadows any lingering pointers.
  // `<> all('{}')` is vacuously true, same convention as the resets.
  const desiredAcctPairs = validGroups.map(
    (g) => `${winnerMember(g.members).connection_id as string}|${g.syntheticSourceObjId}`,
  );
  const gcAccounts = await client.query(
    `delete from finance_accounts
      where user_id = $1 and dedup_status = 'winner' and source_object_id like 'union:%'
        and raw is null and deleted_at is not null
        and (connection_id::text || '|' || source_object_id) <> all($2)`,
    [userId, desiredAcctPairs],
  );
  result.dropped += gcAccounts.rowCount ?? 0;

  const synthByGroup = new Map(existingSynths.filter((s) => s.dedup_group_id != null && liveGroupIds.has(s.dedup_group_id)).map((s) => [s.dedup_group_id as string, s]));

  // CREATE / RECOMPUTE synthetics; capture each group's synthetic id for the shadow pointers.
  const synthIdByGroup = new Map<string, string>();
  for (const g of validGroups) {
    const winner = computeAccountWinner(g.members, g.groupClass);
    const conn = winnerMember(g.members).connection_id as string;
    const existing = synthByGroup.get(g.dedupGroupId);
    if (existing) {
      const changed =
        !rowMatches(existing, winner, accountCols) ||
        existing.connection_id !== conn ||
        existing.source_object_id !== g.syntheticSourceObjId;
      if (changed) {
        const sets = accountCols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
        const vals = accountCols.map((c) => winner[c]);
        vals.push(conn, g.syntheticSourceObjId, existing.id);
        await client.query(
          `update finance_accounts set ${sets}, connection_id = $${vals.length - 2}, source_object_id = $${vals.length - 1} where id = $${vals.length}`,
          vals,
        );
        result.recomputed++;
      }
      synthIdByGroup.set(g.dedupGroupId, existing.id);
    } else {
      // UPSERT, never a blind INSERT (same latent zombie-collision class as holdings — see upsertSynthetic).
      const cols = ["connection_id", "user_id", "source_object_id", "dedup_status", "dedup_group_id", "shadowed_by_id", "raw", ...accountCols];
      const vals = [conn, userId, g.syntheticSourceObjId, "winner", g.dedupGroupId, null, null, ...accountCols.map((c) => winner[c])];
      synthIdByGroup.set(g.dedupGroupId, await upsertSynthetic(client, "finance_accounts", cols, vals));
      result.created++;
    }
  }

  // Fill shadow members' shadowed_by_id now that the synthetic ids exist.
  for (const [id, d] of desired) {
    if (d.status === "shadow" && d.groupId) d.shadowedById = synthIdByGroup.get(d.groupId) ?? null;
  }

  // Apply the real-row markers — ONLY where they changed (a converged run writes nothing).
  for (const a of candidates) {
    const d = desired.get(a.id) ?? { status: "unique", groupId: null, shadowedById: null };
    const changed =
      (a.dedup_status ?? null) !== d.status ||
      (a.dedup_group_id ?? null) !== d.groupId ||
      (a.shadowed_by_id ?? null) !== d.shadowedById;
    if (changed) {
      await client.query(
        `update finance_accounts set dedup_status = $2, dedup_group_id = $3, shadowed_by_id = $4 where id = $1 and user_id = $5`,
        [a.id, d.status, d.groupId, d.shadowedById, userId],
      );
    }
    if (d.status === "shadow") result.accountsShadowed++;
    if (d.status === "ambiguous") result.ambiguous++;
  }
  result.syntheticAccounts = validGroups.length;
  return validGroups;
}

// ── Transaction pass ──────────────────────────────────────────────────────────────────────────────

async function reconcileTransactions(
  client: PoolClient,
  userId: string,
  validGroups: ValidGroup[],
  result: ReconcileResult,
): Promise<void> {
  const txnCols = ENRICHED_COLUMNS.transaction;

  // Only credit + depository cross-provider groups (investment txns are Plaid-invisible — ADR 0021).
  const includedGroups = validGroups.filter((g) => g.groupClass === "liability" || g.groupClass === "asset");

  // Map every (connection_id, account_source_id) of an included group → its dedup_group_id.
  const pairKeys: string[] = [];
  const pairToGroup = new Map<string, string>();
  for (const g of includedGroups) {
    for (const m of g.members) {
      const pk = `${m.connection_id as string}|${m.source_object_id}`;
      pairKeys.push(pk);
      pairToGroup.set(pk, g.dedupGroupId);
    }
  }

  // Reset ANY previously-marked real txn whose account is no longer a candidate (un-shadow on
  // reversal) — AND any TOMBSTONED marked real regardless of group membership (#37, the holdings
  // reset mirrored: a shadowed txn tombstoned while its group persists is invisible to the candidate
  // load — `deleted_at is null` — so without this clause it keeps stale shadow markers forever).
  // No dedup_group_id here: finance_transactions has no such column (schema has it only on
  // finance_accounts + finance_holdings). `<> all('{}')` is vacuously true, so an empty group set
  // clears every real marker.
  await client.query(
    `update finance_transactions set dedup_status = null, shadowed_by_id = null
      where user_id = $1 and source_object_id not like 'union:%'
        and (dedup_status is not null or shadowed_by_id is not null)
        and (deleted_at is not null
             or (connection_id::text || '|' || coalesce(account_source_id, '')) <> all($2))`,
    [userId, pairKeys],
  );

  // Load this run's candidate txns (live, non-synthetic, belonging to an included group's accounts).
  const candidates: Member[] = [];
  if (pairKeys.length > 0) {
    const candRes = await client.query(
      `select t.id, t.connection_id, t.source_object_id, t.account_source_id, t.raw, c.provider,
              t.dedup_status, t.shadowed_by_id,
              ${txnCols.map((col) => `t."${col}"`).join(", ")}
         from finance_transactions t
         join connectors c on c.id = t.connection_id
        where t.user_id = $1 and t.deleted_at is null and (t.dedup_status is distinct from 'winner')
          and (t.connection_id::text || '|' || coalesce(t.account_source_id, '')) = any($2)`,
      [userId, pairKeys],
    );
    candidates.push(...(candRes.rows as Member[]));
  }

  // Existing synthetic txn winners — diff by the deterministic 'union:…' source_object_id.
  const synthRes = await client.query(
    `select id, source_object_id, connection_id, account_source_id,
            ${txnCols.map((col) => `"${col}"`).join(", ")}
       from finance_transactions
      where user_id = $1 and dedup_status = 'winner' and source_object_id like 'union:%' and deleted_at is null`,
    [userId],
  );
  const existingSynths = synthRes.rows as Array<Record<string, unknown> & { id: string; source_object_id: string }>;

  // Bucket by (dedup_group_id, rounded amount, currency) across ALL the group's connections (N-connection,
  // NOT a hardcoded plaid-vs-simplefin pair — so two Plaid Items for the SAME card collapse, not double-count).
  // Plaid pending rows are EXCLUDED from matching (left LIVE, no marker). amount-null rows can't bucket → left LIVE.
  const buckets = new Map<string, Member[]>();
  const desired = new Map<string, { status: string; shadowedById: string | null }>();
  for (const t of candidates) {
    desired.set(t.id, { status: "live", shadowedById: null }); // default: served live, no marker
    const isPlaidPending = t.provider === "plaid" && t.pending === true;
    if (isPlaidPending || t.amount == null) continue;
    const pk = `${t.connection_id as string}|${t.account_source_id == null ? "" : String(t.account_source_id)}`;
    const groupId = pairToGroup.get(pk);
    if (!groupId) continue;
    const amountKey = Number(t.amount).toFixed(2);
    const currKey = t.currency == null ? "" : String(t.currency);
    const bkey = `${groupId}|${amountKey}|${currKey}`;
    let b = buckets.get(bkey);
    if (!b) {
      b = [];
      buckets.set(bkey, b);
    }
    b.push(t);
  }

  // Greedy ±1-day, N-connection count-reconcile inside each bucket. Each real charge is ONE cluster that
  // takes AT MOST ONE row per connection (so the same charge double-reported — by two providers OR two
  // Plaid Items of one card — collapses to a single winner). A ≥2-row cluster → a synthetic + shadows; a
  // singleton leftover → 'ambiguous' when the bucket spans ≥2 connections (a count conflict), else
  // 'pending' (leading-edge, only one connection reporting). Money is never dropped.
  interface DesiredSynth { sourceObjId: string; members: Member[]; conn: string; accountSourceId: unknown; }
  const desiredSynths = new Map<string, DesiredSynth>();
  for (const rows of buckets.values()) {
    const distinctConns = new Set(rows.map((r) => r.connection_id as string)).size;
    const leftoverStatus = distinctConns >= 2 ? "ambiguous" : "pending";
    // Day order, then the deterministic total-order tiebreak (rank → source_object_id → id).
    const pool = [...rows].sort((x, y) => {
      const dx = dayNumber(x.posted_at) ?? 0;
      const dy = dayNumber(y.posted_at) ?? 0;
      if (dx !== dy) return dx - dy;
      return cmpMembers(x, y);
    });
    const used = new Set<string>();
    for (const anchor of pool) {
      if (used.has(anchor.id)) continue;
      const anchorDay = dayNumber(anchor.posted_at);
      const cluster: Member[] = [anchor];
      used.add(anchor.id);
      const clusterConns = new Set<string>([anchor.connection_id as string]);
      for (const s of pool) {
        if (used.has(s.id)) continue;
        const sConn = s.connection_id as string;
        if (clusterConns.has(sConn)) continue; // one row per connection per real charge
        const sd = dayNumber(s.posted_at);
        if (anchorDay != null && sd != null && Math.abs(anchorDay - sd) <= 1) {
          cluster.push(s);
          used.add(s.id);
          clusterConns.add(sConn);
        }
      }
      if (cluster.length >= 2) {
        const w = winnerMember(cluster);
        const sourceObjId = `union:${cluster.map((m) => m.source_object_id).sort().join("+")}`;
        desiredSynths.set(sourceObjId, { sourceObjId, members: cluster, conn: w.connection_id as string, accountSourceId: w.account_source_id });
        for (const m of cluster) desired.set(m.id, { status: "shadow", shadowedById: null });
      } else {
        desired.set(anchor.id, { status: leftoverStatus, shadowedById: null });
      }
    }
  }

  // DROP synthetic txns no longer desired (FK on delete set null auto-un-shadows the reals).
  const existingBySoid = new Map(existingSynths.map((s) => [s.source_object_id, s]));
  for (const s of existingSynths) {
    if (!desiredSynths.has(s.source_object_id)) {
      await client.query(`delete from finance_transactions where id = $1 and user_id = $2`, [s.id, userId]);
      result.dropped++;
    }
  }

  // GC (#37, PAIR-keyed since finance-dedup-trust-batch): hard-DELETE tombstoned union winners whose
  // (connection_id, source_object_id) PAIR is not desired this run — a SEPARATE sweep, never a
  // widened existing-synth load (see the accounts GC comment: a tombstoned-but-still-desired synth
  // must reach upsertSynthetic's resurrect path, not the RECOMPUTE branch). Pair-keying (not the old
  // soid-only `<> all`) reaps the ADR 0022 zombie — a tombstoned winner squatting on a NON-anchor
  // connection whose soid is still desired — before it can collide with a later synthetic UPDATE.
  // $2 = the desired `conn|soid` pairs; `<> all('{}')` is vacuously true, same as the resets.
  const desiredTxnPairs = [...desiredSynths.values()].map((ds) => `${ds.conn}|${ds.sourceObjId}`);
  const gcTxns = await client.query(
    `delete from finance_transactions
      where user_id = $1 and dedup_status = 'winner' and source_object_id like 'union:%'
        and raw is null and deleted_at is not null
        and (connection_id::text || '|' || source_object_id) <> all($2)`,
    [userId, desiredTxnPairs],
  );
  result.dropped += gcTxns.rowCount ?? 0;

  // CREATE / RECOMPUTE synthetic txns; capture ids for the shadow pointers.
  const synthIdBySoid = new Map<string, string>();
  for (const ds of desiredSynths.values()) {
    const winner = computeTxnWinner(ds.members);
    const existing = existingBySoid.get(ds.sourceObjId);
    if (existing && desiredSynths.has(existing.source_object_id)) {
      const changed = !rowMatches(existing, winner, txnCols) || existing.connection_id !== ds.conn || normCmp(existing.account_source_id) !== normCmp(ds.accountSourceId);
      if (changed) {
        const sets = txnCols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
        const vals = txnCols.map((c) => winner[c]);
        vals.push(ds.conn, ds.accountSourceId, existing.id);
        await client.query(
          `update finance_transactions set ${sets}, connection_id = $${vals.length - 2}, account_source_id = $${vals.length - 1} where id = $${vals.length}`,
          vals,
        );
        result.recomputed++;
      }
      synthIdBySoid.set(ds.sourceObjId, existing.id);
    } else {
      // UPSERT, never a blind INSERT (same latent zombie-collision class as holdings — see upsertSynthetic).
      const cols = ["connection_id", "user_id", "source_object_id", "account_source_id", "dedup_status", "shadowed_by_id", "raw", ...txnCols];
      const vals = [ds.conn, userId, ds.sourceObjId, ds.accountSourceId, "winner", null, null, ...txnCols.map((c) => winner[c])];
      synthIdBySoid.set(ds.sourceObjId, await upsertSynthetic(client, "finance_transactions", cols, vals));
      result.created++;
    }
  }

  // Resolve shadow pointers from the matched pairs.
  for (const ds of desiredSynths.values()) {
    const synthId = synthIdBySoid.get(ds.sourceObjId) ?? null;
    for (const m of ds.members) {
      const d = desired.get(m.id);
      if (d && d.status === "shadow") d.shadowedById = synthId;
    }
  }

  // Apply real-txn markers — ONLY where changed. 'live' (default) maps to a NULL status.
  for (const t of candidates) {
    const d = desired.get(t.id) ?? { status: "live", shadowedById: null };
    const status = d.status === "live" ? null : d.status;
    const changed = (t.dedup_status ?? null) !== status || (t.shadowed_by_id ?? null) !== d.shadowedById;
    if (changed) {
      await client.query(
        `update finance_transactions set dedup_status = $2, shadowed_by_id = $3 where id = $1 and user_id = $4`,
        [t.id, status, d.shadowedById, userId],
      );
    }
    if (status === "shadow") result.txnsShadowed++;
    if (status === "ambiguous") result.ambiguous++;
  }
  result.syntheticTxns = desiredSynths.size;
}

// ── Holdings pass (#36, spec finance-holding) ─────────────────────────────────────────────────────

/**
 * The tuple member: freshest non-null `as_of` first (provider sync lag means mixing fields across
 * members fabricates a snapshot that never existed — the balance-tuple rule applied to positions),
 * then the deterministic total order. quantity + market_value + cost_basis + as_of are co-selected
 * from THIS member as one tuple; its connection anchors the synthetic.
 */
function freshestMember(members: Member[]): Member {
  const t = (m: Member): number | null => {
    if (m.as_of == null) return null;
    const ms = m.as_of instanceof Date ? m.as_of.getTime() : Date.parse(String(m.as_of));
    return Number.isNaN(ms) ? null : ms;
  };
  return [...members].sort((x, y) => {
    const xt = t(x);
    const yt = t(y);
    const xn = xt == null ? 1 : 0;
    const yn = yt == null ? 1 : 0;
    if (xn !== yn) return xn - yn; // non-null as_of first
    if (xt != null && yt != null && xt !== yt) return yt - xt; // fresher first
    return cmpMembers(x, y);
  })[0];
}

/** The synthetic holding winner's enriched columns (keys === ENRICHED_COLUMNS.holding, in order). */
function computeHoldingWinner(members: Member[], sym: string): Record<string, unknown> {
  const tuple = freshestMember(members);
  return {
    symbol: sym, // the normalized (uppercase-trimmed) key — deterministic, matches the union source_object_id
    name: selectBest(members, "name"),
    security_type: selectBest(members, "security_type"),
    quantity: tuple.quantity ?? null,
    market_value: tuple.market_value ?? null,
    cost_basis: tuple.cost_basis ?? null,
    currency: selectBest(members, "currency"),
    as_of: tuple.as_of ?? null,
  };
}

/**
 * Holdings dedup — anchored on the ACCOUNT pass's groups (a group already proves "same real account
 * via N providers"; no account group → no holdings dedup, so single-provider users pay zero). Unlike
 * the txn pass there is NO class restriction — investment groups are exactly the point. Within a
 * group, buckets key on the normalized symbol (uppercase, trimmed), ONLY when non-empty — the
 * fail-open guard mirroring the exactly-4-digit-mask rule: cash rows (SimpleFIN empty symbol) and
 * ticker-less bonds/options NEVER merge, stay LIVE. A bucket with rows from ≥2 distinct connections →
 * ONE synthetic winner ('union:holding:<groupKey>:<SYMBOL>', raw null), reals shadowed; a connection
 * contributing >1 row for one symbol (duplicate share classes under one ticker) → the whole bucket is
 * 'ambiguous', all LIVE (mirrors the intra-Item mask collision rule). Diff-only CREATE/RECOMPUTE/DROP.
 */
async function reconcileHoldings(
  client: PoolClient,
  userId: string,
  validGroups: ValidGroup[],
  result: ReconcileResult,
): Promise<void> {
  const holdCols = ENRICHED_COLUMNS.holding;

  // Map every (connection_id, account_source_id) of EVERY group → its group (ALL classes included).
  const pairKeys: string[] = [];
  const pairToGroup = new Map<string, ValidGroup>();
  for (const g of validGroups) {
    for (const m of g.members) {
      const pk = `${m.connection_id as string}|${m.source_object_id}`;
      pairKeys.push(pk);
      pairToGroup.set(pk, g);
    }
  }

  // Reset ANY previously-marked real holding whose parent account is no longer a group member
  // (un-shadow on reversal) — AND any TOMBSTONED marked real regardless of group membership (review
  // fold, spec finance-holding: a shadowed holding tombstoned while its group persists is invisible
  // to the candidate load — `deleted_at is null` — so without this clause it keeps stale shadow
  // markers forever). `<> all('{}')` is vacuously true, so an empty group set clears everything.
  await client.query(
    `update finance_holdings set dedup_status = null, shadowed_by_id = null, dedup_group_id = null
      where user_id = $1 and source_object_id not like 'union:%'
        and (dedup_status is not null or dedup_group_id is not null or shadowed_by_id is not null)
        and (deleted_at is not null
             or (connection_id::text || '|' || coalesce(account_source_id, '')) <> all($2))`,
    [userId, pairKeys],
  );

  // Load this run's candidates (live, non-synthetic, parent account inside a group).
  const candidates: Member[] = [];
  if (pairKeys.length > 0) {
    const candRes = await client.query(
      `select h.id, h.connection_id, h.source_object_id, h.account_source_id, h.raw, c.provider,
              h.dedup_status, h.dedup_group_id, h.shadowed_by_id,
              ${holdCols.map((col) => `h."${col}"`).join(", ")}
         from finance_holdings h
         join connectors c on c.id = h.connection_id
        where h.user_id = $1 and h.deleted_at is null and (h.dedup_status is distinct from 'winner')
          and (h.connection_id::text || '|' || coalesce(h.account_source_id, '')) = any($2)`,
      [userId, pairKeys],
    );
    candidates.push(...(candRes.rows as Member[]));
  }

  // Existing synthetic holding winners — diff by the deterministic 'union:holding:…' source_object_id.
  const synthRes = await client.query(
    `select id, source_object_id, connection_id, account_source_id, dedup_group_id,
            ${holdCols.map((col) => `"${col}"`).join(", ")}
       from finance_holdings
      where user_id = $1 and dedup_status = 'winner' and source_object_id like 'union:%' and deleted_at is null`,
    [userId],
  );
  const existingSynths = synthRes.rows as Array<Record<string, unknown> & { id: string; source_object_id: string }>;

  // Bucket per (account group × normalized symbol). Default marker for every in-group candidate is
  // 'unique' (live, fail-open) — empty-symbol rows and single-connection symbols keep it.
  const desired = new Map<string, { status: string; groupId: string | null; shadowedById: string | null }>();
  const buckets = new Map<string, { group: ValidGroup; sym: string; rows: Member[] }>();
  for (const h of candidates) {
    desired.set(h.id, { status: "unique", groupId: null, shadowedById: null });
    const sym = typeof h.symbol === "string" ? h.symbol.trim().toUpperCase() : "";
    if (sym === "") continue; // empty symbol → never merges (cash rows stay LIVE)
    const pk = `${h.connection_id as string}|${h.account_source_id == null ? "" : String(h.account_source_id)}`;
    const group = pairToGroup.get(pk);
    if (!group) continue;
    const bkey = `${group.dedupGroupId}|${sym}`;
    let b = buckets.get(bkey);
    if (!b) {
      b = { group, sym, rows: [] };
      buckets.set(bkey, b);
    }
    b.rows.push(h);
  }

  interface DesiredHoldingSynth {
    sourceObjId: string;
    sym: string;
    groupId: string;
    members: Member[];
    conn: string;
    accountSourceId: unknown;
  }
  const desiredSynths = new Map<string, DesiredHoldingSynth>();
  for (const { group, sym, rows } of buckets.values()) {
    const perConn = new Map<string, number>();
    for (const r of rows) perConn.set(r.connection_id as string, (perConn.get(r.connection_id as string) ?? 0) + 1);
    if ([...perConn.values()].some((n) => n > 1)) {
      // One connection contributes >1 row for this symbol → never auto-merge; flag the bucket, all LIVE.
      for (const r of rows) desired.set(r.id, { status: "ambiguous", groupId: null, shadowedById: null });
      continue;
    }
    if (perConn.size < 2) continue; // single connection → stays 'unique' (live)

    const tuple = freshestMember(rows);
    const sourceObjId = `union:holding:${group.groupKey}:${sym}`;
    const groupId = deterministicUuid(`hold:${group.groupKey}:${sym}`);
    desiredSynths.set(sourceObjId, {
      sourceObjId,
      sym,
      groupId,
      members: rows,
      conn: tuple.connection_id as string, // the winner-tuple provider anchors the synthetic
      accountSourceId: tuple.account_source_id,
    });
    for (const r of rows) desired.set(r.id, { status: "shadow", groupId, shadowedById: null });
  }

  // DROP synthetic holdings no longer desired (FK on delete set null auto-un-shadows the reals).
  const existingBySoid = new Map(existingSynths.map((s) => [s.source_object_id, s]));
  for (const s of existingSynths) {
    if (!desiredSynths.has(s.source_object_id)) {
      await client.query(`delete from finance_holdings where id = $1 and user_id = $2`, [s.id, userId]);
      result.dropped++;
    }
  }

  // GC (#37, PAIR-keyed since finance-dedup-trust-batch): hard-DELETE tombstoned union winners whose
  // (connection_id, source_object_id) PAIR is not desired this run — a SEPARATE sweep, never a
  // widened existing-synth load (see the accounts GC comment: a tombstoned-but-still-desired synth
  // must reach upsertSynthetic's resurrect path, not the RECOMPUTE branch). Pair-keying (not the old
  // soid-only `<> all`) reaps the ADR 0022 zombie — a tombstoned winner squatting on a NON-anchor
  // connection whose soid is still desired — before it can collide with a later synthetic UPDATE
  // (e.g. an anchor move when the freshest tuple flips providers).
  // $2 = the desired `conn|soid` pairs; `<> all('{}')` is vacuously true, same as the resets.
  const desiredHoldingPairs = [...desiredSynths.values()].map((ds) => `${ds.conn}|${ds.sourceObjId}`);
  const gcHoldings = await client.query(
    `delete from finance_holdings
      where user_id = $1 and dedup_status = 'winner' and source_object_id like 'union:%'
        and raw is null and deleted_at is not null
        and (connection_id::text || '|' || source_object_id) <> all($2)`,
    [userId, desiredHoldingPairs],
  );
  result.dropped += gcHoldings.rowCount ?? 0;

  // CREATE / RECOMPUTE synthetic holdings; capture ids for the shadow pointers.
  const synthIdBySoid = new Map<string, string>();
  for (const ds of desiredSynths.values()) {
    const winner = computeHoldingWinner(ds.members, ds.sym);
    const existing = existingBySoid.get(ds.sourceObjId);
    if (existing) {
      const changed =
        !rowMatches(existing, winner, holdCols) ||
        existing.connection_id !== ds.conn ||
        normCmp(existing.account_source_id) !== normCmp(ds.accountSourceId) ||
        (existing.dedup_group_id ?? null) !== ds.groupId;
      if (changed) {
        const sets = holdCols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
        const vals = holdCols.map((c) => winner[c]);
        vals.push(ds.conn, ds.accountSourceId, ds.groupId, existing.id);
        await client.query(
          `update finance_holdings set ${sets}, connection_id = $${vals.length - 3}, account_source_id = $${vals.length - 2}, dedup_group_id = $${vals.length - 1} where id = $${vals.length}`,
          vals,
        );
        result.recomputed++;
      }
      synthIdBySoid.set(ds.sourceObjId, existing.id);
    } else {
      // UPSERT, never a blind INSERT: a tombstoned zombie union row is resurrected + fully recomputed
      // in place (same id — the shadows' pointers stay coherent). See upsertSynthetic.
      const cols = ["connection_id", "user_id", "source_object_id", "account_source_id", "dedup_status", "dedup_group_id", "shadowed_by_id", "raw", ...holdCols];
      const vals = [ds.conn, userId, ds.sourceObjId, ds.accountSourceId, "winner", ds.groupId, null, null, ...holdCols.map((c) => winner[c])];
      synthIdBySoid.set(ds.sourceObjId, await upsertSynthetic(client, "finance_holdings", cols, vals));
      result.created++;
    }
  }

  // Resolve shadow pointers now that the synthetic ids exist.
  for (const ds of desiredSynths.values()) {
    const synthId = synthIdBySoid.get(ds.sourceObjId) ?? null;
    for (const m of ds.members) {
      const d = desired.get(m.id);
      if (d && d.status === "shadow") d.shadowedById = synthId;
    }
  }

  // Apply the real-row markers — ONLY where they changed (a converged run writes nothing).
  for (const h of candidates) {
    const d = desired.get(h.id) ?? { status: "unique", groupId: null, shadowedById: null };
    const changed =
      (h.dedup_status ?? null) !== d.status ||
      (h.dedup_group_id ?? null) !== d.groupId ||
      (h.shadowed_by_id ?? null) !== d.shadowedById;
    if (changed) {
      await client.query(
        `update finance_holdings set dedup_status = $2, dedup_group_id = $3, shadowed_by_id = $4 where id = $1 and user_id = $5`,
        [h.id, d.status, d.groupId, d.shadowedById, userId],
      );
    }
    if (d.status === "shadow") result.holdingsShadowed++;
    if (d.status === "ambiguous") result.ambiguous++;
  }
  result.syntheticHoldings = desiredSynths.size;
}

// ── Confirmed merges — the operator surface (finance-dedup-trust-batch) ───────────────────────────
//
// When two accounts look like the same one but lack proof (no exactly-4-digit mask on ≥1 side), the
// gateway FLAGS the pair (listDedupCandidates → the Console pill) instead of silently double-counting,
// and the operator can CONFIRM the merge once (confirmDedupPair). Ground truth beats inference —
// deterministic, reversible (unconfirmDedupPair), and NO fuzzy matching ever enters the engine. The
// confirmation is consumed by reconcileAccounts INSIDE its transaction/lock (never by planting rows or
// markers from here); these functions only maintain the finance_dedup_confirmations table, audit, and
// trigger a reconcile.

/** One side of a confirmable/confirmed pair — the engine's stable (connection, soid) identity. */
export interface DedupRef {
  connectionId: string;
  sourceObjectId: string;
}

export interface DedupConfirmation {
  id: string;
  a: { connectionId: string; sourceObjectId: string };
  b: { connectionId: string; sourceObjectId: string };
}

/** A candidate pair's side, with enough display context for the Console pill (child C). */
export interface CandidateSide extends DedupRef {
  accountId: string;
  provider: string;
  name: string | null;
  institutionName: string | null;
  mask: string | null;
}

/** A flagged possibly-the-same pair: same canonical institution + compatible currency/class,
 *  different connections, and ≥1 side failing the exactly-4-digit mask gate (so the organic engine
 *  can never prove it). Served in canonical (a < b on 'conn|soid') order. */
export interface CandidatePair {
  institution: string;
  currency: string | null;
  a: CandidateSide;
  b: CandidateSide;
}

/** A stored confirmation's current standing against the live rows:
 *  - applied    — both members live and the confirmed group is formed (markers say so);
 *  - suspended  — both members live but a currency/class conflict developed → the engine refuses
 *                 the group FAIL-OPEN (reals serve; the confirmation is kept, never honored);
 *  - inactive   — a member is missing/tombstoned (or the pair is contested by an organic group),
 *                 so the confirmation currently does nothing. */
export type DedupConfirmationState = "applied" | "suspended" | "inactive";

export interface DedupConfirmationSummary extends DedupConfirmation {
  createdAt: string;
  state: DedupConfirmationState;
  suspendedReason: "currency" | "class" | null;
}

/** uuid syntax guard (mirrors lifecycle.ts) — a malformed id is a typed error, never a pg 22P02. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The engine's 'conn|soid' pair key over a ref. The connection id is LOWERCASED (uuid semantics are
 *  case-insensitive; Postgres renders the stored uuid lowercase) so the JS canonical order always
 *  matches the migration's collate-"C" CHECK over the stored text — a mixed-case caller id can no
 *  longer flip the ordering between JS and the DB (review fold). */
function refPairKey(r: DedupRef): string {
  return `${r.connectionId.toLowerCase()}|${r.sourceObjectId}`;
}

/** BYTEWISE string order — matches the migration's `collate "C"` CHECK exactly, so the canonical
 *  order computed here always satisfies the DB constraint (locale collations may disagree on '|'). */
function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Deterministic hash of the CANONICALLY-ORDERED pair — the group key is 'confirmed:<pairhash>' and
 *  the winner soid 'union:confirmed:<pairhash>' (its own sub-namespace inside the enforced 'union:%'
 *  reserved namespace, so it can never collide with an organic 'union:<inst>:<mask>' key). */
export function confirmationPairHash(a: DedupRef, b: DedupRef): string {
  const keys = [refPairKey(a), refPairKey(b)].sort(cmpBytes);
  // JSON-encode the pair (not a raw join): soids are provider-controlled text, so a delimiter join
  // could theoretically let two distinct pairs collide on the same hash input (review fold).
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex").slice(0, 16);
}

/** Fire one async audit line for a confirm/unconfirm (the standard writer; free-text tool vocab). */
function auditConfirmation(userId: string, tool: "finance.dedup.confirm" | "finance.dedup.unconfirm", args: unknown): void {
  audit({
    userId,
    agentId: "operator",
    tool: tool as unknown as AuditTool,
    sector: "finance",
    decision: "allow",
    args,
    outcome: "ok",
  });
}

function assertRef(label: "a" | "b", r: DedupRef): void {
  if (r == null || typeof r !== "object") throw new QueryValidationError(`${label} must be { connectionId, sourceObjectId }`);
  if (typeof r.connectionId !== "string" || !UUID_RE.test(r.connectionId)) {
    throw new QueryValidationError(`${label}.connectionId must be a connection uuid`);
  }
  if (typeof r.sourceObjectId !== "string" || r.sourceObjectId === "") {
    throw new QueryValidationError(`${label}.sourceObjectId must be a non-empty string`);
  }
  // The engine-reserved synthetic namespace is never confirmable — a confirmation must point at
  // PROVIDER rows only (the winner is engine-fabricated and recomputed every run).
  if (r.sourceObjectId.startsWith("union:")) {
    throw new QueryValidationError(`${label}.sourceObjectId is in the reserved 'union:' namespace`);
  }
}

/**
 * Flag pass (server-side detection): every same-institution pair the engine CANNOT auto-merge for
 * lack of proof — same canonical institution, non-conflicting currency (two distinct non-null
 * currencies refuse), non-conflicting class, DIFFERENT connections, and ≥1 side failing the
 * exactly-4-digit mask gate. Pairs where BOTH sides carry a valid mask are excluded — the organic
 * engine owns provable pairs (same mask → auto-merge; different masks → genuinely different).
 * Already-confirmed pairs are excluded (they are no longer "possible" — they're decided), as are
 * winner/shadow rows (already merged). Deterministic order; never fuzzy — this LISTS, never merges.
 */
export async function listDedupCandidates(userId: string): Promise<CandidatePair[]> {
  const res = await pool.query(
    `select a.id, a.connection_id, a.source_object_id, a.name, a.account_type, a.currency,
            a.institution_name, a.org_domain, a.mask, a.raw, c.provider
       from finance_accounts a
       join connectors c on c.id = a.connection_id
      where a.user_id = $1 and a.deleted_at is null
        and (a.dedup_status is distinct from 'winner')
        and (a.dedup_status is distinct from 'shadow')
      order by a.source_object_id, a.id`,
    [userId],
  );
  const confRes = await pool.query(
    `select a_connection_id, a_source_object_id, b_connection_id, b_source_object_id
       from finance_dedup_confirmations where user_id = $1`,
    [userId],
  );
  const confirmedPairs = new Set<string>(
    confRes.rows.map(
      (r: Record<string, string>) =>
        `${r.a_connection_id}|${r.a_source_object_id}\n${r.b_connection_id}|${r.b_source_object_id}`,
    ),
  );

  type Row = Record<string, unknown> & {
    id: string;
    connection_id: string;
    source_object_id: string;
    provider: string;
    currency?: unknown;
    account_type?: unknown;
    name?: unknown;
    raw?: unknown;
  };
  const byInst = new Map<string, Row[]>();
  for (const row of res.rows as Row[]) {
    const inst = canonicalInstitution(row.org_domain as string | null, row.institution_name as string | null);
    if (!inst) continue; // no institution key → no candidate basis
    const arr = byInst.get(inst);
    if (arr) arr.push(row);
    else byInst.set(inst, [row]);
  }

  const side = (r: Row): CandidateSide => ({
    accountId: r.id,
    connectionId: r.connection_id,
    sourceObjectId: r.source_object_id,
    provider: r.provider,
    name: (r.name as string | null) ?? null,
    institutionName: (r.institution_name as string | null) ?? null,
    mask: (r.mask as string | null) ?? null,
  });

  const out: CandidatePair[] = [];
  for (const [inst, rows] of [...byInst.entries()].sort(([x], [y]) => cmpBytes(x, y))) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const x = rows[i];
        const y = rows[j];
        if (x.connection_id === y.connection_id) continue; // intra-item pairs never merge
        if (pairConflictReason(x, y) != null) continue; // currency/class conflict → not a candidate
        const xMasked = typeof x.mask === "string" && EXACTLY_FOUR_DIGITS.test(x.mask);
        const yMasked = typeof y.mask === "string" && EXACTLY_FOUR_DIGITS.test(y.mask);
        if (xMasked && yMasked) continue; // provable pairs belong to the organic engine
        const [first, second] =
          cmpBytes(`${x.connection_id}|${x.source_object_id}`, `${y.connection_id}|${y.source_object_id}`) < 0
            ? [x, y]
            : [y, x];
        if (
          confirmedPairs.has(
            `${first.connection_id}|${first.source_object_id}\n${second.connection_id}|${second.source_object_id}`,
          )
        ) {
          continue; // already decided by the operator
        }
        out.push({
          institution: inst,
          currency: (x.currency as string | null) ?? (y.currency as string | null) ?? null,
          a: side(first),
          b: side(second),
        });
      }
    }
  }
  return out;
}

/**
 * Operator ground truth: persist the confirmed pair (canonical a < b order on 'conn|soid'), audit,
 * and trigger a reconcile so the merge applies immediately. BOTH connections must belong to `userId`
 * AND both soids must exist on finance_accounts — verified BEFORE the insert, so a confirmation can
 * never reach across users or point at nothing. Idempotent: re-confirming an existing pair returns
 * the existing row. No confirm-token — the action is reversible (tokens are for destructive verbs).
 */
export async function confirmDedupPair(userId: string, a: DedupRef, b: DedupRef): Promise<DedupConfirmation> {
  assertRef("a", a);
  assertRef("b", b);
  if (a.connectionId === b.connectionId && a.sourceObjectId === b.sourceObjectId) {
    throw new QueryValidationError("a and b must be two different accounts");
  }
  if (a.connectionId === b.connectionId) {
    throw new QueryValidationError("a and b must live on different connections — intra-connection pairs never merge");
  }
  const [x, y] = cmpBytes(refPairKey(a), refPairKey(b)) < 0 ? [a, b] : [b, a];

  for (const [label, ref] of [["a", x], ["b", y]] as const) {
    const conn = await pool.query(`select 1 from connectors where id = $1 and user_id = $2`, [ref.connectionId, userId]);
    if ((conn.rowCount ?? 0) === 0) {
      throw new NotFoundError(`${label}: connection ${ref.connectionId} not found`);
    }
    const acct = await pool.query(
      `select 1 from finance_accounts where user_id = $1 and connection_id = $2 and source_object_id = $3`,
      [userId, ref.connectionId, ref.sourceObjectId],
    );
    if ((acct.rowCount ?? 0) === 0) {
      throw new NotFoundError(`${label}: account '${ref.sourceObjectId}' not found on connection ${ref.connectionId}`);
    }
  }

  const ins = await pool.query(
    `insert into finance_dedup_confirmations
       (user_id, a_connection_id, a_source_object_id, b_connection_id, b_source_object_id)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id, a_connection_id, a_source_object_id, b_connection_id, b_source_object_id)
       do nothing
     returning id`,
    [userId, x.connectionId, x.sourceObjectId, y.connectionId, y.sourceObjectId],
  );
  let id = ins.rows[0]?.id as string | undefined;
  if (id == null) {
    const existing = await pool.query(
      `select id from finance_dedup_confirmations
        where user_id = $1 and a_connection_id = $2 and a_source_object_id = $3
          and b_connection_id = $4 and b_source_object_id = $5`,
      [userId, x.connectionId, x.sourceObjectId, y.connectionId, y.sourceObjectId],
    );
    id = existing.rows[0].id as string;
  }

  const result: DedupConfirmation = {
    id,
    a: { connectionId: x.connectionId, sourceObjectId: x.sourceObjectId },
    b: { connectionId: y.connectionId, sourceObjectId: y.sourceObjectId },
  };
  auditConfirmation(userId, "finance.dedup.confirm", { confirmationId: id, a: result.a, b: result.b });
  await reconcileFinance(userId); // the engine forms the confirmed group inside its own txn/lock
  return result;
}

/**
 * Reverse a confirmation: delete the row (ownership-checked), audit, and trigger a reconcile — the
 * next run's existing dissolution diff drops the synthetic and un-shadows both reals.
 */
export async function unconfirmDedupPair(userId: string, confirmationId: string): Promise<void> {
  if (typeof confirmationId !== "string" || !UUID_RE.test(confirmationId)) {
    throw new NotFoundError(`confirmation not found`);
  }
  const res = await pool.query(
    `delete from finance_dedup_confirmations where id = $1 and user_id = $2
     returning a_connection_id, a_source_object_id, b_connection_id, b_source_object_id`,
    [confirmationId, userId],
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new NotFoundError(`confirmation not found`);
  }
  const r = res.rows[0] as Record<string, string>;
  auditConfirmation(userId, "finance.dedup.unconfirm", {
    confirmationId,
    a: { connectionId: r.a_connection_id, sourceObjectId: r.a_source_object_id },
    b: { connectionId: r.b_connection_id, sourceObjectId: r.b_source_object_id },
  });
  await reconcileFinance(userId);
}

/**
 * Summary helper (child C's confirmedMerge/confirmationSuspended source): every stored confirmation
 * with its CURRENT standing — applied (markers show the confirmed group), suspended (+ the
 * currency/class reason, computed with the engine's own refusal check), or inactive. Read-only.
 */
export async function listDedupConfirmations(userId: string): Promise<DedupConfirmationSummary[]> {
  const res = await pool.query(
    `select id, a_connection_id, a_source_object_id, b_connection_id, b_source_object_id, created_at
       from finance_dedup_confirmations where user_id = $1 order by created_at, id`,
    [userId],
  );
  const out: DedupConfirmationSummary[] = [];
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const a = { connectionId: row.a_connection_id as string, sourceObjectId: row.a_source_object_id as string };
    const b = { connectionId: row.b_connection_id as string, sourceObjectId: row.b_source_object_id as string };
    const members = await pool.query(
      `select connection_id, source_object_id, currency, account_type, name, raw, dedup_status, dedup_group_id
         from finance_accounts
        where user_id = $1 and deleted_at is null
          and ((connection_id = $2 and source_object_id = $3) or (connection_id = $4 and source_object_id = $5))`,
      [userId, a.connectionId, a.sourceObjectId, b.connectionId, b.sourceObjectId],
    );
    const ma = members.rows.find((m) => m.connection_id === a.connectionId && m.source_object_id === a.sourceObjectId);
    const mb = members.rows.find((m) => m.connection_id === b.connectionId && m.source_object_id === b.sourceObjectId);

    let state: DedupConfirmationState = "inactive";
    let suspendedReason: "currency" | "class" | null = null;
    if (ma && mb) {
      const reason = pairConflictReason(ma, mb);
      if (reason != null) {
        state = "suspended";
        suspendedReason = reason;
      } else {
        const expectedGroupId = deterministicUuid(`acct:confirmed:${confirmationPairHash(a, b)}`);
        if (ma.dedup_group_id === expectedGroupId && mb.dedup_group_id === expectedGroupId) state = "applied";
      }
    }
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    out.push({ id: row.id as string, a, b, createdAt, state, suspendedReason });
  }
  return out;
}
