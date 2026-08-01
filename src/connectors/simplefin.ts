// SimpleFIN connector — the first finance source and the proving ground for the multi-object
// connector contract (one connector → finance_accounts + finance_transactions + finance_holdings
// via RawRecord.object).
//
// Read-only (finance has no actions). Onboarding: the operator pastes a SimpleFIN SETUP TOKEN; we
// claim it ONCE (claimSetupToken) → an ACCESS URL sealed in the vault at purpose 'access'. sync()
// consumes that access URL from ctx.secret, polls {accessUrl}/accounts over a bounded window, and
// yields RawRecords tagged object:'account' | 'transaction' | 'holding'. normalize() branches on
// rec.object. Holdings (#36) are a SNAPSHOT, not an event stream: each account's raw.holdings[] is
// fanned out per-record (ADR 0005 — the account raw stays byte-faithful, holdings included), and a
// COMPLETE, successful enumeration ends with a snapshot-tombstone reconcile (ADR 0004) so positions
// absent from the fresh snapshot are tombstoned — never after a failed fetch, and never when any
// window's errors[] is non-empty (a partially-failing bridge = incomplete enumeration; records are
// still emitted, only the sweep is skipped — no mass-tombstone).
//
// SECURITY: the setup token and the access URL are credentials (the access URL embeds basic-auth) —
// they are NEVER logged. Every claim/HTTP failure throws a clean error with no secret in the message.

import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";
import { reconcileObjectSnapshot } from "../sync/runner.js";

// ── Windowing constants (epoch SECONDS) ─────────────────────────────────────────
const DAY_SECONDS = 86_400;
const OVERLAP_SECONDS = 3 * DAY_SECONDS; // incremental: re-fetch a 3-day overlap (absorbs late posts)
const BACKFILL_SECONDS = 365 * DAY_SECONDS; // first sync backfills one year
const WINDOW_SECONDS = 90 * DAY_SECONDS; // the bridge silently caps spans > 90 days

// ── Normalized row shapes (decimals carried as STRINGS → exact numeric, never JS float) ─────────

/** Normalized finance account row (matches finance_accounts). */
export interface AccountRow {
  source_object_id: string;
  name: string | null;
  account_type: string | null;
  currency: string | null;
  current_balance: string | null; // decimal string -> numeric (exact)
  available_balance: string | null; // decimal string -> numeric (exact)
  balance_at: string | null; // ISO timestamptz
  balance_at_is_synthetic: boolean;
  institution_name: string | null;
  mask: string | null; // #34b dedup key: last-4 extracted from the NAME's (dddd) suffix (SimpleFIN raw has no mask field)
  org_domain: string | null; // #34b dedup key: raw.org.domain (americanexpress.com / client.schwab.com / …)
}

/** Normalized finance transaction row (matches finance_transactions; amount signed, negative = out). */
export interface TransactionRow {
  source_object_id: string;
  account_source_id: string | null;
  posted_at: string | null;
  amount: string | null; // decimal string -> numeric (exact); signed, as-is from SimpleFIN
  currency: string | null;
  description: string | null;
  merchant: string | null;
  pending: boolean;
  category: string | null; // SimpleFIN has none -> null (the agent infers at query time; Plaid PFC vocab)
  payment_channel: string | null;
  authorized_at: string | null;
  location_city: string | null;
  location_region: string | null;
}

/** Normalized finance holding row (matches finance_holdings; a position snapshot — #36). */
export interface HoldingRow {
  source_object_id: string;
  account_source_id: string | null;
  symbol: string | null; // trimmed; null when empty (CASH rows) — the dedup pass's fail-open guard
  name: string | null; // SimpleFIN description
  security_type: string | null; // ENRICHMENT column: SimpleFIN always null (agent infers; Plaid fills)
  quantity: string | null; // shares — decimal string -> numeric (exact)
  market_value: string | null; // decimal string -> numeric (exact)
  cost_basis: string | null; // as reported (SimpleFIN's junk "0.00" stored faithfully — agent interprets)
  currency: string | null; // null when empty (CASH rows)
  as_of: string | null; // ISO timestamptz from `created` (epoch seconds)
}

// ── SimpleFIN /accounts (v1) raw shapes — the subset we read, parsed defensively ────────────────
interface SfinOrg {
  name?: string;
  domain?: string;
  "sfin-url"?: string;
  url?: string;
  id?: string;
}
interface SfinTransaction {
  id: string;
  posted?: number; // epoch seconds; may be 0 -> fall back to transacted_at
  transacted_at?: number; // epoch seconds
  amount: string; // signed decimal string, negative = out
  description?: string;
  payee?: string;
  memo?: string;
  [k: string]: unknown;
}
interface SfinHolding {
  id: string; // "HOL-…"
  created?: number; // epoch seconds — the position's as-of stamp
  currency?: string; // "" on CASH rows -> null
  cost_basis?: string; // decimal string; often a junk "0.00" — stored as reported
  description?: string;
  market_value?: string; // decimal string
  purchase_price?: string; // average cost — stays in raw (no honest cross-provider price column)
  shares?: string; // decimal string
  symbol?: string; // "" on CASH rows -> null
  [k: string]: unknown;
}
interface SfinAccount {
  id: string;
  name?: string;
  currency?: string;
  balance?: string; // decimal string
  "available-balance"?: string; // decimal string
  "balance-date"?: number; // epoch seconds
  org?: SfinOrg;
  transactions?: SfinTransaction[];
  holdings?: SfinHolding[];
  [k: string]: unknown;
}
interface SfinAccountsResponse {
  errors?: string[]; // non-fatal display strings (e.g. the 90-day cap)
  accounts?: SfinAccount[];
}

/**
 * The transaction raw we store + hand to normalize(): the SimpleFIN txn plus the parent account's id
 * and (inherited) currency, nested under a synthetic `__pci_parent` key so the original txn fields
 * stay byte-faithful in `raw` (the lossless-cache invariant). The RawRecord contract carries no
 * parent pointer, so this threading keeps normalize() a pure, stateless function of a single record.
 */
type TxnRaw = SfinTransaction & { __pci_parent: { account_id: string; currency: string | null } };

/**
 * The holding raw we store + hand to normalize(): the SimpleFIN holding plus the parent account's id
 * under the same synthetic `__pci_parent` key (the TxnRaw precedent) — the holding's own fields stay
 * byte-faithful in `raw` and normalize() stays a pure, stateless function of a single record.
 */
type HoldingRaw = SfinHolding & { __pci_parent: { account_id: string } };

/** epoch seconds -> ISO timestamptz; null/<=0/non-finite -> null. */
function epochToIso(epoch: number | undefined | null): string | null {
  if (epoch == null || !Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
}

/**
 * base64-decode the setup token -> POST the decoded claim URL (empty body) -> return the trimmed
 * access URL. ONE-TIME-USE upstream. Honors the host inside the decoded URL (no hardcoded bridge
 * host). NEVER logs the token or URL; on any decode/HTTP/non-2xx failure throws a clean, secret-free
 * Error('simplefin claim failed').
 */
export async function claimSetupToken(setupToken: string): Promise<string> {
  let claimUrl: string;
  try {
    claimUrl = Buffer.from(setupToken.trim(), "base64").toString("utf8").trim();
  } catch {
    throw new Error("simplefin claim failed");
  }
  // The claim URL (and the access URL it returns) are secrets — require TLS, never log them.
  if (!/^https:\/\//i.test(claimUrl)) throw new Error("simplefin claim failed");

  let resp: Response;
  try {
    resp = await fetch(claimUrl, { method: "POST" });
  } catch {
    throw new Error("simplefin claim failed");
  }
  if (!resp.ok) throw new Error("simplefin claim failed");

  const accessUrl = (await resp.text()).trim();
  if (!/^https:\/\//i.test(accessUrl)) throw new Error("simplefin claim failed");
  return accessUrl;
}

/**
 * GET {accessUrl}/accounts?start-date=..&end-date=.. (posted-only — no pending=1 in V0). The access
 * URL embeds basic-auth (https://user:pass@host/...). Node's fetch/undici REJECTS a URL that carries
 * embedded credentials (TypeError) — it does NOT convert them to a header — so we lift the creds into
 * an explicit Authorization header and strip them from the URL before fetching. Parses the v1 body
 * defensively. On network/non-2xx failure throws a secret-free error (status only — never the URL).
 */
async function fetchAccounts(
  accessUrl: string,
  startEpoch: number,
  endEpoch: number,
): Promise<SfinAccountsResponse> {
  let u: URL;
  try {
    u = new URL(accessUrl);
  } catch {
    throw new Error("simplefin: account fetch failed");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (u.username) {
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    u.username = "";
    u.password = "";
  }
  const base = u.toString().replace(/\/+$/, "");
  const url = `${base}/accounts?start-date=${startEpoch}&end-date=${endEpoch}`;
  let resp: Response;
  try {
    resp = await fetch(url, { method: "GET", headers });
  } catch {
    throw new Error("simplefin: account fetch failed");
  }
  if (!resp.ok) throw new Error(`simplefin: account fetch returned ${resp.status}`);
  return (await resp.json()) as SfinAccountsResponse;
}

/** SimpleFIN connector (finance, read-only). Multi-object: yields accounts, transactions AND holdings. */
export class SimpleFinConnector implements Connector<AccountRow | TransactionRow | HoldingRow> {
  readonly provider = "simplefin";
  readonly sector = "finance";
  // The fallback/primary object when a record sets no `object` (sync always tags, so this is a floor).
  readonly objectType = "transaction";

  // Poll source. 6h => <=4 incremental calls/day, well under the bridge's ~24/day cap.
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 21600,
    // Floor 7200s: the bridge expects ≤24 requests/day and DISABLES tokens beyond the warning level
    // (beta-bridge.simplefin.org/info/developers). A 3600s floor would consume that ENTIRE budget on
    // the poll cadence alone — zero headroom for sync-now/fetch_live — so the floor is 12/day,
    // leaving half the budget for manual syncs; bridge data refreshes ~daily anyway.
    minIntervalSec: 7200,
    freshnessToleranceSec: 21600,
    supportsIncremental: true,
  };

  // Finance is read-only by nature — no actions on the source side.
  readonly actions: ActionSpec[] = [];

  /**
   * Pull accounts + their embedded transactions over a bounded window. ctx.secret is the access URL;
   * ctx.cursor is the last window-end epoch (string) or undefined.
   *   - incremental (cursor present): one window [cursor - 3d, now).
   *   - first sync (no cursor): backfill [now-365d, now) in <=90-day edge-to-edge chunks.
   * Each record carries cursor=String(windowEnd); the runner advances connectors.cursor to it and
   * the idempotent upsert by (connection_id, source_object_id) absorbs the overlap re-fetch.
   */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    const accessUrl = ctx.secret;
    if (!accessUrl) throw new Error("simplefin: missing access URL");

    // Captured BEFORE any fetch — the snapshot-tombstone fence (#36): holding rows upserted during
    // this sync carry ingested_at >= syncStartedAt and survive the reconcile below.
    const syncStartedAt = new Date();
    const now = Math.floor(Date.now() / 1000);
    const cursorEpoch = ctx.cursor != null && ctx.cursor !== "" ? Number(ctx.cursor) : NaN;

    const windows: Array<{ start: number; end: number }> = [];
    if (Number.isFinite(cursorEpoch)) {
      windows.push({ start: Math.max(0, cursorEpoch - OVERLAP_SECONDS), end: now });
    } else {
      // First sync: backfill a year in <=90-day chunks, edge-to-edge (no gaps).
      let start = now - BACKFILL_SECONDS;
      while (start < now) {
        const end = Math.min(start + WINDOW_SECONDS, now);
        windows.push({ start, end });
        start = end;
      }
    }

    // Holdings are a SNAPSHOT, not an event stream (#36): every window re-delivers each account's
    // FULL current position set. Collect every emitted holding id across ALL windows to feed the
    // post-enumeration snapshot reconcile (accounts without holdings simply contribute none).
    const holdingIds = new Set<string>();
    // Set when ANY window reports errors[] — a partially-failing bridge (per-institution error
    // strings) means the enumeration is NOT complete, so the snapshot reconcile below is SKIPPED
    // (review fold, spec finance-holding): reconciling on a partial payload would mass-tombstone the
    // failing institution's holdings. Records are still emitted (keep the data); only the sweep waits.
    let sawErrors = false;

    for (const w of windows) {
      const body = await fetchAccounts(accessUrl, w.start, w.end);
      // errors[] are NON-FATAL display strings (e.g. the 90-day cap, a failing institution) —
      // surface them, keep the data, but treat the enumeration as incomplete (no sweep).
      // They're bridge-authored messages (no credentials); never log the access URL itself.
      for (const err of body.errors ?? []) {
        sawErrors = true;
        console.warn(`simplefin: ${err}`);
      }
      const endCursor = String(w.end);
      for (const acct of body.accounts ?? []) {
        const { transactions, ...accountRest } = acct;
        // The account raw stays byte-faithful INCLUDING its holdings[] (per-record fan-out, ADR 0005 —
        // holdings are projected into their own records below, never stripped from the account).
        yield { object: "account", externalId: acct.id, raw: accountRest, cursor: endCursor };
        for (const txn of transactions ?? []) {
          const raw: TxnRaw = { ...txn, __pci_parent: { account_id: acct.id, currency: acct.currency ?? null } };
          yield { object: "transaction", externalId: txn.id, raw, cursor: endCursor };
        }
        for (const h of acct.holdings ?? []) {
          const raw: HoldingRaw = { ...h, __pci_parent: { account_id: acct.id } };
          holdingIds.add(h.id);
          yield { object: "holding", externalId: h.id, raw, cursor: endCursor };
        }
      }
    }

    // COMPLETE enumeration only: any thrown fetch above exits the generator before this line, so a
    // transient miss can never mass-tombstone real positions — and a payload carrying errors[]
    // (incomplete enumeration) emits its records but SKIPS the sweep entirely. Runs when every window
    // succeeded WITH an empty errors[] — positions absent from the fresh snapshot are tombstoned
    // (ADR 0004); a genuinely-empty holdings set DOES reconcile (the positions are gone — truthful).
    // By the time the runner drains the stream to this point, every yielded record has already been
    // upserted (streaming applyRecords).
    if (!sawErrors) {
      await reconcileObjectSnapshot(ctx.connectionId, "finance", "holding", holdingIds, syncStartedAt);
    }
  }

  /** Branch on rec.object: account -> AccountRow, holding -> HoldingRow, transaction (or fallback) -> TransactionRow. */
  normalize(rec: RawRecord): AccountRow | TransactionRow | HoldingRow {
    if (rec.object === "account") return normalizeAccount(rec);
    if (rec.object === "holding") return normalizeHolding(rec);
    return normalizeTransaction(rec);
  }

  /** Deterministic strong keys: { account_id } / { holding_id } / { txn_id } by object. */
  strongKeys(rec: RawRecord): Record<string, string> {
    const id = String((rec.raw as { id?: unknown }).id ?? rec.externalId);
    if (rec.object === "account") return { account_id: id };
    if (rec.object === "holding") return { holding_id: id };
    return { txn_id: id };
  }

  async execute(): Promise<ActionResult> {
    throw new Error("SimpleFinConnector has no actions (finance is read-only)");
  }
}

/** The (dddd) last-4 suffix in a SimpleFIN account NAME — e.g. "Blue Cash (4327)" → "4327". Tolerant of
 *  a trailing ® / whitespace. null when absent (401k / "(297)" / "(2AW9)" / Apple-Card → fail-open). */
function extractMask(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const m = /\((\d{4})\)\s*®?\s*$/.exec(name);
  return m ? m[1] : null;
}

/** The institution domain from raw.org.domain (the stable cross-provider institution key signal). */
function extractOrgDomain(a: SfinAccount): string | null {
  const d = a.org?.domain;
  return typeof d === "string" && d !== "" ? d : null;
}

/** Map a SimpleFIN account -> AccountRow. account_type stays null (SimpleFIN has none). */
function normalizeAccount(rec: RawRecord): AccountRow {
  const a = rec.raw as SfinAccount;
  return {
    source_object_id: a.id,
    name: a.name ?? null,
    account_type: null,
    currency: a.currency ?? null, // store as-is; a custom-currency URL stays in raw
    current_balance: a.balance ?? null,
    available_balance: a["available-balance"] ?? null,
    balance_at: epochToIso(a["balance-date"]),
    balance_at_is_synthetic: false,
    institution_name: a.org?.name ?? null,
    mask: extractMask(a.name), // #34b: last-4 from the (dddd) name suffix
    org_domain: extractOrgDomain(a), // #34b: raw.org.domain
  };
}

/**
 * Map a SimpleFIN holding -> HoldingRow (#36). Decimals stay exact strings; `symbol`/`currency` are
 * empty on CASH rows -> null (the dedup pass's fail-open guard never merges a null symbol);
 * `security_type` is a Plaid enrichment column — always null here (the agent infers);
 * `cost_basis` as reported (SimpleFIN's junk "0.00" stored faithfully); `purchase_price` stays in raw.
 */
function normalizeHolding(rec: RawRecord): HoldingRow {
  const h = rec.raw as HoldingRaw;
  const symbol = typeof h.symbol === "string" ? h.symbol.trim() : "";
  return {
    source_object_id: h.id,
    account_source_id: h.__pci_parent?.account_id ?? null,
    symbol: symbol === "" ? null : symbol,
    name: h.description ?? null,
    security_type: null,
    quantity: h.shares ?? null,
    market_value: h.market_value ?? null,
    cost_basis: h.cost_basis ?? null,
    currency: h.currency == null || h.currency === "" ? null : h.currency,
    as_of: epochToIso(h.created),
  };
}

/** Map a SimpleFIN transaction -> TransactionRow. amount as-is (negative = out); currency inherited. */
function normalizeTransaction(rec: RawRecord): TransactionRow {
  const t = rec.raw as TxnRaw;
  // posted may be 0 (not yet posted) -> fall back to transacted_at.
  const postedEpoch = typeof t.posted === "number" && t.posted > 0 ? t.posted : t.transacted_at;
  return {
    source_object_id: t.id,
    account_source_id: t.__pci_parent?.account_id ?? null,
    posted_at: epochToIso(postedEpoch),
    amount: t.amount ?? null,
    currency: t.__pci_parent?.currency ?? null, // inherited from the parent account (txns carry none)
    description: t.description ?? null,
    merchant: t.payee ?? null,
    pending: false,
    category: null,
    payment_channel: null,
    authorized_at: null,
    location_city: null,
    location_region: null,
  };
}
