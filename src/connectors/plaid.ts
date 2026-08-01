// Plaid connector — the SECOND finance source and the "rich" provider that FILLS the enrichment
// columns SimpleFIN leaves null (category from PFC, merchant, payment_channel, authorized_at,
// location, account_type, available_balance, institution_name). Read-only (finance has no actions).
//
// Reuses SimpleFIN's per-record routing: sync() tags each yielded record object:'account'|'transaction'
// |'holding' so the generic runner lands it in finance_accounts / finance_transactions /
// finance_holdings (no runner change).
//
// HOLDINGS (#36, spec finance-holding): /investments/holdings/get is called ONLY for Items whose
// fresh account snapshot (from the same sync's /transactions/sync drain) includes ≥1 investment-type
// account — the per-Item billing gate (option a: the Holdings subscription starts per-Item on first
// call, so un-invested Items never trigger it). Holdings are a SNAPSHOT, not an event stream: after a
// COMPLETE enumeration the connector calls the shared reconcileObjectSnapshot fence (ADR 0004) so
// positions absent from the fresh snapshot are tombstoned; a skipped/failed fetch NEVER reconciles
// (a transient miss must never mass-tombstone real positions).
//
// ONBOARDING (wave 13, grounded): the operator configures their own BYO Plaid app in the Console
// (client_id + secret + env, vault-sealed via plaid_app), then connects banks through Plaid's HOSTED
// Link (no widget bundle). Capture is multi-Item-aware: /link/token/get returns a results.item_add_results
// ARRAY; each public_token is exchanged into its OWN durable access_token + Item, and each Item becomes
// its OWN credential row keyed by external_item_id (the gateway DB is the SOLE source of truth for "which
// banks did I connect"). Incremental sync rides /transactions/sync's native cursor (added/modified/
// removed + next_cursor + has_more) — no date-window reconciliation. A per-Item /item/get HEALTH poll
// (sub-unit B) keeps describe_context honest: a broken Item makes sync go QUIET (empty arrays), so the
// poll's error_code/consent clock is what tells action-required apart from "no new data".
//
// SIGN: Plaid amount is POSITIVE = money out; we store negative = out, so amounts are NEGATED on write.
//
// SECURITY: the Plaid `secret`, the item `access_token`, `public_token`, and `link_token` are
// credentials — NEVER logged. Every client failure throws a clean error carrying status (+ a non-secret
// Plaid error_code at most), never token material.

import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { pool } from "../db.js";
import { open, seal } from "../secrets/index.js";
import { ConfigError } from "../oauth/providers.js";
import { loadPlaidApp } from "../plaid/app-config.js";
import { classifyItemError } from "../plaid/health.js";
import { reconcileObjectSnapshot } from "../sync/runner.js";

// ── Normalized row shapes (decimals carried as STRINGS → exact numeric, never JS float) ─────────

/** Normalized finance account row (matches finance_accounts). */
export interface AccountRow {
  source_object_id: string;
  name: string | null;
  account_type: string | null; // enrichment: Plaid `type`
  currency: string | null;
  current_balance: string | null; // decimal string -> numeric (exact)
  available_balance: string | null; // enrichment; decimal string -> numeric (exact)
  balance_at: string | null; // ISO timestamptz (synthetic — Plaid reports no balance timestamp)
  balance_at_is_synthetic: boolean;
  institution_name: string | null; // enrichment; best-effort resolved
  mask: string | null; // #34b dedup key: Plaid clean last-4 field (raw.mask); 2–4 alphanumeric — the engine keys only on EXACTLY 4 digits
  org_domain: string | null; // #34b dedup key: institution domain (best-effort; null → canonicalInstitution name-folds institution_name)
}

/** Normalized finance transaction row (matches finance_transactions; amount signed, negative = out). */
export interface TransactionRow {
  source_object_id: string;
  account_source_id: string | null;
  posted_at: string | null;
  amount: string | null; // decimal string -> numeric (exact); NEGATED (Plaid positive = out)
  currency: string | null;
  description: string | null;
  merchant: string | null; // enrichment: Plaid merchant_name
  pending: boolean;
  category: string | null; // enrichment: personal_finance_category.primary (PFC vocab)
  payment_channel: string | null; // enrichment
  authorized_at: string | null; // enrichment
  location_city: string | null;
  location_region: string | null;
}

/** Normalized finance holding row (matches finance_holdings; #36). */
export interface HoldingRow {
  source_object_id: string; // `${account_id}:${security_id}` — Plaid holdings carry no id of their own
  account_source_id: string | null; // links to finance_accounts.source_object_id within the connection
  symbol: string | null; // securities join: ticker_symbol (null for cash / unlisted securities)
  name: string | null; // securities join: name
  security_type: string | null; // enrichment: securities join `type` (SimpleFIN leaves null)
  quantity: string | null; // decimal string -> numeric (exact)
  market_value: string | null; // institution_value; decimal string -> numeric (exact)
  cost_basis: string | null; // as reported; decimal string -> numeric (exact)
  currency: string | null;
  as_of: string; // institution_price_datetime ?? institution_price_as_of ?? sync time (ISO)
}

// ── Plaid API raw shapes — the subset we read, parsed defensively ────────────────────────────────

interface PlaidBalances {
  current?: number | null;
  available?: number | null;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  [k: string]: unknown;
}
interface PlaidAccount {
  account_id: string;
  name?: string | null;
  official_name?: string | null;
  type?: string | null;
  subtype?: string | null;
  mask?: string | null; // #34b: the account's last-4 (Plaid: 2–4 alphanumeric)
  balances?: PlaidBalances;
  [k: string]: unknown;
}
interface PlaidLocation {
  city?: string | null;
  region?: string | null;
  [k: string]: unknown;
}
interface PlaidPfc {
  primary?: string | null;
  detailed?: string | null;
  [k: string]: unknown;
}
interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number; // Plaid: POSITIVE = money OUT
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  name?: string | null;
  merchant_name?: string | null;
  pending?: boolean;
  date?: string | null; // "YYYY-MM-DD"
  datetime?: string | null; // ISO 8601 (preferred when present)
  authorized_date?: string | null;
  authorized_datetime?: string | null;
  payment_channel?: string | null;
  personal_finance_category?: PlaidPfc | null;
  location?: PlaidLocation | null;
  [k: string]: unknown;
}

/** One /investments/holdings/get holdings[] entry — the subset we normalize (long tail stays in raw). */
interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity?: number | null;
  institution_value?: number | null;
  cost_basis?: number | null;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  institution_price_as_of?: string | null; // "YYYY-MM-DD"
  institution_price_datetime?: string | null; // ISO 8601 (preferred when present)
  [k: string]: unknown;
}
/** One /investments/holdings/get securities[] entry — joined to its holdings by security_id. */
interface PlaidSecurity {
  security_id: string;
  ticker_symbol?: string | null;
  name?: string | null;
  type?: string | null; // cash|cryptocurrency|derivative|equity|etf|fixed income|loan|mutual fund|other
  [k: string]: unknown;
}

/** One page of /transactions/sync. */
export interface PlaidSyncPage {
  accounts: PlaidAccount[];
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}

/**
 * The account raw we store + hand to normalize(): the Plaid account enriched with the (best-effort)
 * resolved institution name. The RawRecord contract carries no connection-level context, so threading
 * it here keeps normalize() a pure, stateless function of a single record (the SimpleFIN precedent).
 */
type AccountRaw = PlaidAccount & { institution_name: string | null; institution_domain?: string | null };

/**
 * The holding raw we store + hand to normalize(): the Plaid holding with its joined security nested
 * under `__pci_security` (byte-faithful both; the securities[] side-array would otherwise be lost —
 * the RawRecord contract carries one raw per record, the AccountRaw threading precedent).
 */
type HoldingRaw = PlaidHolding & { __pci_security: PlaidSecurity | null };

// ── Table-first config + thin raw-`fetch` client (no SDK dep — matches oauth/exchange.ts) ─────────

interface PlaidConfig {
  clientId: string;
  secret: string;
  baseUrl: string;
}

/**
 * The product name Plaid Link DISPLAYS to the user while they hand over bank credentials (#109).
 * `client_name` is a literal WE send on every /link/token/create — it is not read from anyone's Plaid
 * dashboard — so this one constant is the name every Postern user on earth sees at the most
 * trust-sensitive moment in the product. It must match every other surface: POSTERN, operator-locked
 * 2026-07-12 (`docs/design/naming-2026.md` 🔒). ONE constant, never a literal per call site — three
 * literals is how one of them survives the next rename.
 *
 * NOT ours: the "… is testing something new" half of Plaid's banner. Plaid shows that for apps without
 * full Production access, so it depends on each user's own BYO Plaid app status (ADR 0014) and cannot be
 * suppressed from our side — it is explained in the setup instructions, never worked around here.
 */
export const PLAID_LINK_CLIENT_NAME = "Postern";

/**
 * Resolve Plaid config TABLE-FIRST (the BYO `plaid_app` row, configured in the Console) with an ENV
 * fallback (`PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV`) for headless/back-compat deploys. A failed
 * table read (no DB / no row / decrypt error) falls back to env; when NEITHER resolves a client_id +
 * secret it throws ConfigError (→ HTTP 400) so a half-configured deploy fails actionably rather than
 * minting a broken request. The env picks the base URL (default sandbox — the safe non-prod default).
 * Async: the table lookup opens the vault-sealed secret. NEVER logs the secret.
 */
export async function plaidConfig(): Promise<PlaidConfig> {
  // Table-first: a configured plaid_app wins. catch(()=>null) keeps the DB-free unit tests + a
  // missing/old table tolerant — they drop to the env fallback rather than throwing a raw pg error.
  const app = await loadPlaidApp().catch(() => null);
  const clientId = app?.clientId ?? process.env.PLAID_CLIENT_ID;
  const secret = app?.clientSecret ?? process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new ConfigError(
      "plaid is not configured: set the Plaid client_id + secret in the Console (or PLAID_CLIENT_ID + PLAID_SECRET)",
    );
  }
  const env = (app?.env ?? process.env.PLAID_ENV ?? "sandbox").toLowerCase();
  const baseUrl = env === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
  return { clientId, secret, baseUrl };
}

/**
 * POST a JSON body to a Plaid endpoint (client_id + secret injected). On network failure or non-2xx
 * throws a secret-free error: status + a non-sensitive Plaid error_code at most (never the request
 * body, which carries the secret/access_token, and never the response body verbatim).
 */
async function plaidPost<T>(path: string, params: Record<string, unknown>, op: string): Promise<T> {
  const { clientId, secret, baseUrl } = await plaidConfig();
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, ...params }),
    });
  } catch {
    throw new Error(`plaid ${op} failed: network error`);
  }
  if (!resp.ok) {
    // error_code (e.g. INVALID_ACCESS_TOKEN) is a non-sensitive enum; never echo the full body.
    let code = "";
    try {
      const j = (await resp.json()) as { error_code?: string };
      if (j?.error_code) code = ` ${j.error_code}`;
    } catch {
      // body unreadable — status alone is enough
    }
    throw new Error(`plaid ${op} failed: ${resp.status}${code}`);
  }
  return (await resp.json()) as T;
}

/**
 * Create a Link token (products: transactions). Returns the link_token for the Console widget.
 * `transactions.days_requested: 365` makes Plaid's initial backfill match SimpleFIN's 365-day window
 * (finance-depth parity — wave 10D); /transactions/sync then has up to a year of history to drain.
 */
export async function linkTokenCreate(): Promise<string> {
  const j = await plaidPost<{ link_token: string }>(
    "/link/token/create",
    {
      client_name: PLAID_LINK_CLIENT_NAME,
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: LOCAL_USER_ID },
      products: ["transactions"],
      transactions: { days_requested: 365 },
    },
    "link_token_create",
  );
  return j.link_token;
}

/**
 * Mint a HOSTED Link token (wave 13) for the Console's "connect a bank" flow — Plaid serves the Link
 * UI at hosted_link_url; we never bundle the widget. `enable_multi_item_link:true` lets one session add
 * SEVERAL banks (captured as the results.item_add_results array). `transactions.days_requested:730` is
 * frozen at Item init (cannot widen later without re-linking — a faithful cache requests the deep window
 * up front). `hosted_link.url_lifetime_seconds:10800` (3h) overrides the 30-min server-minted default.
 */
export async function hostedLinkCreate(): Promise<{ linkToken: string; hostedLinkUrl: string }> {
  // Single-Item hosted Link (one bank per Connect session — each session yields one Item, keyed by its
  // own external_item_id). Multi-Item Link was dropped: it needs a Plaid user_token, which /user/create
  // only issues for Layer/Consumer-Report-enrolled apps — not available here (verified live: /user/create
  // returns {user_id} with NO user_token; #31). The hosted URL is the TOP-LEVEL `hosted_link_url`
  // (verified live: response keys = expiration / hosted_link_url / link_token / request_id).
  const j = await plaidPost<{ link_token: string; hosted_link_url?: string | null }>(
    "/link/token/create",
    {
      client_name: PLAID_LINK_CLIENT_NAME,
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: LOCAL_USER_ID },
      products: ["transactions"],
      transactions: { days_requested: 730 },
      hosted_link: { url_lifetime_seconds: 10800 },
    },
    "hosted_link_create",
  );
  return { linkToken: j.link_token, hostedLinkUrl: j.hosted_link_url ?? "" };
}

/**
 * Poll a hosted-Link session via /link/token/get (the retrieval path for flows with no frontend
 * callback — Hosted Link; verified against plaid.com/docs/api/link/). The response is a `link_sessions`
 * ARRAY; each session has a nullable `finished_at` (the completion signal — there is NO status enum) and
 * `results.item_add_results[]`, each carrying a `public_token` to exchange. We collect public_tokens
 * across all sessions (idempotent re-exchange is safe) and report `complete` once any session has
 * finished (finished_at non-null) — so an abandoned, item-less session still ends the poll.
 */
export async function linkTokenGet(
  linkToken: string,
): Promise<{ items: Array<{ publicToken: string }>; complete: boolean }> {
  const j = await plaidPost<{
    link_sessions?: Array<{
      finished_at?: string | null;
      results?: { item_add_results?: Array<{ public_token?: string | null }> } | null;
    }> | null;
  }>("/link/token/get", { link_token: linkToken }, "link_token_get");
  const sessions = j.link_sessions ?? [];
  const items = sessions
    .flatMap((s) => s.results?.item_add_results ?? [])
    .map((r) => r.public_token)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((publicToken) => ({ publicToken }));
  const complete = sessions.some((s) => s.finished_at != null);
  return { items, complete };
}

/**
 * Mint an UPDATE-mode hosted Link token (wave 13) carrying the stored `access_token` — re-consent for a
 * broken Item (~annual re-auth is guaranteed for major banks). The `access_token`/`external_item_id`
 * are UNCHANGED across update mode (no row repointing); on success the next sync clears the error flag
 * and resumes the cursor (backfilling missed data). Update-mode link tokens are short-lived (~30 min).
 */
export async function relinkTokenCreate(
  accessToken: string,
): Promise<{ linkToken: string; hostedLinkUrl: string }> {
  const j = await plaidPost<{ link_token: string; hosted_link_url?: string | null }>(
    "/link/token/create",
    {
      client_name: PLAID_LINK_CLIENT_NAME,
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: LOCAL_USER_ID },
      access_token: accessToken, // update mode — carries the stored token (NO products field)
      hosted_link: { url_lifetime_seconds: 1800 },
    },
    "relink_token_create",
  );
  return { linkToken: j.link_token, hostedLinkUrl: j.hosted_link_url ?? "" };
}

/** Exchange a public_token (from Link) for the durable item access_token + item_id. */
export async function exchangePublicToken(
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const j = await plaidPost<{ access_token: string; item_id: string }>(
    "/item/public_token/exchange",
    { public_token: publicToken },
    "public_token_exchange",
  );
  return { accessToken: j.access_token, itemId: j.item_id };
}

/** One /transactions/sync page (added/modified/removed + next_cursor + has_more). */
export async function transactionsSync(accessToken: string, cursor?: string): Promise<PlaidSyncPage> {
  const params: Record<string, unknown> = { access_token: accessToken };
  if (cursor) params.cursor = cursor;
  const page = await plaidPost<PlaidSyncPage>("/transactions/sync", params, "transactions_sync");
  return page;
}

/** The COMPLETE holdings snapshot for one Item (unpaginated) — holdings[] + their securities[] join. */
export interface PlaidHoldingsSnapshot {
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
}

/**
 * /investments/holdings/get (#36) — the full holdings set for the Item in ONE call (Plaid documents it
 * unpaginated). Called ONLY behind the per-Item investment-account gate (billing option a: the Holdings
 * subscription starts per-Item on first call). Throws via plaidPost's secret-free error path — the
 * caller matches the benign per-Item skip codes on the bare error_code plaidPost embeds in the message.
 */
export async function investmentsHoldingsGet(accessToken: string): Promise<PlaidHoldingsSnapshot> {
  const j = await plaidPost<{ holdings?: PlaidHolding[]; securities?: PlaidSecurity[] }>(
    "/investments/holdings/get",
    { access_token: accessToken },
    "investments_holdings_get",
  );
  return { holdings: j.holdings ?? [], securities: j.securities ?? [] };
}

/**
 * Per-Item BENIGN holdings skips (#36, grounded): the Item's institution doesn't support investments
 * (PRODUCTS_NOT_SUPPORTED), the Item has no investment accounts after all (NO_INVESTMENT_ACCOUNTS), or
 * the product's initial pull hasn't finished (PRODUCT_NOT_READY — auto-add is in flight; the next poll
 * picks it up). All three: no status=error, other objects still sync, and NO snapshot reconcile.
 */
const BENIGN_HOLDINGS_SKIP_CODES = ["PRODUCTS_NOT_SUPPORTED", "NO_INVESTMENT_ACCOUNTS", "PRODUCT_NOT_READY"] as const;

/** Match a thrown holdings-fetch error against the benign skip codes (plaidPost embeds the bare error_code). */
function isBenignHoldingsSkip(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return BENIGN_HOLDINGS_SKIP_CODES.some((code) => msg.includes(code));
}

/** Best-effort institution name by id (get_by_id). Swallows failure → null (enrichment, not critical). */
export async function institutionsGet(institutionId: string): Promise<string | null> {
  try {
    const j = await plaidPost<{ institution?: { name?: string | null } }>(
      "/institutions/get_by_id",
      { institution_id: institutionId, country_codes: ["US"] },
      "institutions_get",
    );
    return j.institution?.name ?? null;
  } catch {
    return null;
  }
}

/** The /item/get read: institution_id (enrichment) + the connection-health fields (sub-unit B). */
export interface PlaidItemGet {
  institutionId: string | null;
  /** item.error.error_code on a 200, OR the top-level error_code on a non-2xx (e.g. a 429 quota). */
  errorCode: string | null;
  consentExpirationTime: string | null;
  updateType: string | null;
  httpStatus: number;
}

/**
 * /item/get — institution_id for enrichment AND the health fields (error_code / consent_expiration_time
 * / update_type). Unlike plaidPost this does NOT throw on a non-2xx: a broken Item / a 429 quota returns
 * its error_code so the health state machine can classify it (a throw would erase the signal). It throws
 * ONLY on a network failure (no response). NEVER logs/echoes the access token — only non-secret fields.
 */
export async function itemGet(accessToken: string): Promise<PlaidItemGet> {
  const { clientId, secret, baseUrl } = await plaidConfig();
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/item/get`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, access_token: accessToken }),
    });
  } catch {
    throw new Error("plaid item_get failed: network error");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    // body unreadable — fall through with the status alone
  }
  if (!resp.ok) {
    const code = typeof body.error_code === "string" ? (body.error_code as string) : null;
    return { institutionId: null, errorCode: code, consentExpirationTime: null, updateType: null, httpStatus: resp.status };
  }
  const item = (body.item ?? {}) as Record<string, unknown>;
  const itemError = item.error as { error_code?: unknown } | null | undefined;
  const errorCode = itemError && typeof itemError.error_code === "string" ? (itemError.error_code as string) : null;
  return {
    institutionId: typeof item.institution_id === "string" ? (item.institution_id as string) : null,
    errorCode,
    consentExpirationTime:
      typeof item.consent_expiration_time === "string" ? (item.consent_expiration_time as string) : null,
    updateType: typeof item.update_type === "string" ? (item.update_type as string) : null,
    httpStatus: resp.status,
  };
}

/**
 * Live balance drill (wave 13) — the per-call-BILLED /accounts/balance/get (throttled under Plaid's
 * 30/hour/Item cap). Used ONLY behind an explicit fetch_live; routine cached balances come FREE from
 * the /transactions/sync accounts snapshot. Optional account_ids scopes the (billed) refresh.
 */
export async function accountsBalanceGet(accessToken: string, accountIds?: string[]): Promise<PlaidAccount[]> {
  const params: Record<string, unknown> = { access_token: accessToken };
  if (accountIds && accountIds.length > 0) params.options = { account_ids: accountIds };
  const j = await plaidPost<{ accounts?: PlaidAccount[] }>("/accounts/balance/get", params, "accounts_balance_get");
  return j.accounts ?? [];
}

/**
 * /item/remove (wave 13) — the operator OUT-bound call that invalidates the access_token and STOPS the
 * monthly Transactions subscription on paid Production (deleting local rows alone leaves a billable
 * zombie Item). NOT an agent action — finance stays actions:[]; this is wired into disconnect/erase.
 */
export async function itemRemove(accessToken: string): Promise<void> {
  await plaidPost<{ request_id?: string }>("/item/remove", { access_token: accessToken }, "item_remove");
}

/**
 * Open a Plaid connection's sealed access token (purpose 'access') and call /item/remove — the wiring
 * disconnect/erase use to stop the billable Item upstream BEFORE dropping local rows. BEST-EFFORT:
 * returns true when the Item was removed, false on a missing ref / open failure / Plaid error, so the
 * destructive op never blocks on it (the operator still wants their rows gone). NEVER logs the token.
 */
export async function removePlaidItem(secretRef: string | null, userId: string): Promise<boolean> {
  if (!secretRef) return false;
  try {
    const token = (await open(secretRef, { userId, provider: "plaid", purpose: "access" })).toString("utf8");
    await itemRemove(token);
    return true;
  } catch {
    return false;
  }
}

/** Mint a sandbox public_token with NO browser — tests only (the full server path, headless). */
export async function sandboxPublicTokenCreate(): Promise<string> {
  const j = await plaidPost<{ public_token: string }>(
    "/sandbox/public_token/create",
    { institution_id: "ins_109508", initial_products: ["transactions"] }, // First Platypus Bank (sandbox)
    "sandbox_public_token_create",
  );
  return j.public_token;
}

/** Outcome of exchanging + persisting ONE Item. `skipped` = an already-consumed public_token (idempotent). */
export interface ExchangeStoreResult {
  skipped?: boolean;
  credentialId?: string;
  connectionId?: string;
  itemId?: string;
}

/**
 * Exchange ONE public_token → durable access_token + Item, seal it, and upsert the per-Item credential
 * (+ its finance connector). Per-Item keying is non-negotiable: the credential conflict target is
 * (user_id, provider, external_item_id) (the 0007 partial unique index) so adding bank #2 never
 * overwrites bank #1, and re-linking the SAME Item updates the row in place (same access_token slot).
 *
 * The exchange happens BEFORE any DB write so a failure writes NO row. An already-consumed/expired
 * public_token (the results window can be polled repeatedly within ~6h) → { skipped:true } with no
 * row + no duplicate (idempotent re-poll). The access token is sealed only, NEVER echoed or logged.
 */
export async function exchangeAndStore(publicToken: string): Promise<ExchangeStoreResult> {
  let accessToken: string;
  let itemId: string;
  try {
    const r = await exchangePublicToken(publicToken);
    accessToken = r.accessToken;
    itemId = r.itemId;
  } catch {
    // Idempotent re-poll: the public_token was already consumed/expired. No row, no duplicate, no leak.
    return { skipped: true };
  }

  // Seal at purpose 'access' (uniform with static + OAuth, so the runner's open(purpose 'access') is
  // uniform). The token is the durable per-credential secret — never echoed/logged.
  const secretRef = await seal({ userId: LOCAL_USER_ID, provider: "plaid", purpose: "access" }, accessToken);

  // Per-Item credential, keyed on (user_id, provider, external_item_id). item_status seeds 'ok'; a
  // re-link of the same Item refreshes the token + clears any prior error in place (no new row).
  const cred = await pool.query(
    `insert into provider_credentials
       (user_id, provider, custody, secret_ref, external_item_id, item_status, status)
     values ($1, 'plaid', 'byo_app', $2, $3, 'ok', 'active')
     on conflict (user_id, provider, external_item_id) where external_item_id is not null
       do update set secret_ref  = excluded.secret_ref,
                     custody     = 'byo_app',
                     item_status = 'ok',
                     item_error_code = null,
                     status      = 'active'
     returning id`,
    [LOCAL_USER_ID, secretRef, itemId],
  );
  const credentialId = cred.rows[0].id as string;

  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status)
     values ($1, $2, 'finance', 'plaid', 'active')
     on conflict (credential_id, sector) do update set status = 'active'
     returning id`,
    [LOCAL_USER_ID, credentialId],
  );
  const connectionId = conn.rows[0].id as string;

  // access_token NEVER echoed; item_id is an opaque, non-secret identifier (useless without the token).
  return { credentialId, connectionId, itemId };
}

// ── Small normalization helpers ──────────────────────────────────────────────────────────────────

/** A finite number → its string form (exact); null/NaN → null. Normalizes -0 to "0". */
function numToString(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return String(n === 0 ? 0 : n);
}

/** NEGATE a Plaid amount (positive = out) → our signed convention (negative = out), as an exact string. */
function negateToString(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const v = -n;
  return String(v === 0 ? 0 : v);
}

/** Plaid liability account types (case-insensitive) whose `current_balance` is an amount OWED. */
const PLAID_LIABILITY_TYPES = new Set(["credit", "loan", "mortgage"]);

/**
 * Normalize a Plaid `current_balance` to our signed convention (owed = NEGATIVE everywhere, matching
 * SimpleFIN + the `amount<0 = money out` invariant). Plaid reports a POSITIVE magnitude for every
 * account type — even liabilities — so a credit/loan/mortgage balance is NEGATED on write (like the
 * txn `amount`); asset (depository/investment) balances pass through as-is. null/NaN → null; -0 → "0".
 * `available_balance` is left UNCHANGED (operator decision: Plaid available-credit passes through).
 */
function normalizeBalance(current: number | null | undefined, type: string | null | undefined): string | null {
  if (type != null && PLAID_LIABILITY_TYPES.has(type.toLowerCase())) return negateToString(current);
  return numToString(current);
}

/** Plaid date/datetime → UTC ISO. `datetime` (ISO 8601) preferred; else `date` (YYYY-MM-DD) at UTC midnight. */
function plaidDateToIso(date?: string | null, datetime?: string | null): string | null {
  const src = datetime ?? (date ? `${date}T00:00:00Z` : null);
  if (!src) return null;
  const d = new Date(src);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Persist a per-Item /item/get health read onto its credential row (sub-unit B): the classified status
 * + the raw error_code + the consent clock. Joined connector→credential so the connectionId suffices.
 * Best-effort by its callers (a failure must never break the sync). No secret material is written/logged.
 */
async function persistItemHealth(connectionId: string, info: PlaidItemGet): Promise<void> {
  const status = classifyItemError(info.errorCode, info.consentExpirationTime);
  await pool.query(
    `update provider_credentials pc
        set item_status = $2, item_error_code = $3, consent_expiration_time = $4
       from connectors c
      where c.id = $1 and c.credential_id = pc.id`,
    [connectionId, status, info.errorCode, info.consentExpirationTime],
  );
}

// ── The connector ────────────────────────────────────────────────────────────────────────────────

/** Plaid connector (finance, read-only). Multi-object: yields accounts, transactions AND holdings. */
export class PlaidConnector implements Connector<AccountRow | TransactionRow | HoldingRow> {
  readonly provider = "plaid";
  readonly sector = "finance";
  // The fallback/primary object when a record sets no `object` (sync always tags, so this is a floor).
  readonly objectType = "transaction";

  // Poll source. 6h => a cheap cursor poll; webhook (SYNC_UPDATES_AVAILABLE) is a later push unit.
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 21600,
    // Floor 900s: Transactions is billed as a per-Item MONTHLY subscription regardless of call count
    // (plaid.com/docs/account/billing/), and /transactions/sync allows 50 req/min per Item
    // (plaid.com/docs/errors/rate-limit-exceeded/) — a 15-min cursor poll (96/day) is negligible on both.
    minIntervalSec: 900,
    freshnessToleranceSec: 21600,
    supportsIncremental: true,
  };

  // Finance is read-only by nature — no actions on the source side.
  readonly actions: ActionSpec[] = [];

  /**
   * Pull the item's transactions via /transactions/sync's native cursor. ctx.secret is the item
   * access_token; ctx.cursor is the last Plaid next_cursor (or undefined on first sync).
   *   - Drain `has_more`, accumulating added+modified (deduped by transaction_id; modified wins) and
   *     the accounts snapshot (deduped by account_id); capture the final next_cursor.
   *   - `removed` is reconciled per id, LAST-WINS within the drain (Plaid can deliver the same id as
   *     added on one page and removed on a later one): a remove evicts the live txn and marks the
   *     id removed; a later add/modify un-marks it. Each surviving removed id yields a deletion
   *     record (deleted:true) that the runner tombstones (ADR 0004).
   * Each record carries cursor=finalNextCursor; the runner advances connectors.cursor to it and the
   * idempotent upsert by (connection_id, source_object_id) makes a re-run a no-op.
   */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    const accessToken = ctx.secret;
    if (!accessToken) throw new Error("plaid: missing access token");

    // The holdings snapshot-reconcile fence anchor (#36): rows upserted during THIS sync carry
    // ingested_at >= syncStartedAt (both stamped from this process's clock) and survive the fence.
    const syncStartedAt = new Date();

    // Connection-health refresh (sub-unit B) + institution enrichment via ONE /item/get (reusing the
    // SAME read for both — pollItemHealth is the standalone health API; sync folds health into this
    // combined call), BEST-EFFORT, BEFORE draining /transactions/sync. Persisting health UP FRONT means
    // a broken Item is detected even when the subsequent /transactions/sync goes QUIET (empty arrays —
    // indistinguishable from "no new data") or throws — so describe_context's health is honest and
    // last_synced_at can't lie. Never breaks the sync (a health/enrichment failure is swallowed).
    //
    // The persistItemHealth DB-write is in its OWN inner try/catch, SEPARATE from the itemGet +
    // institutionsGet network enrichment: a health-persist DB hiccup must NOT suppress institution
    // enrichment (nor make the network-only unit path DB-dependent). The two are independent best-efforts.
    let institutionName: string | null = null;
    try {
      const info = await itemGet(accessToken);
      try {
        await persistItemHealth(ctx.connectionId, info);
      } catch {
        // best-effort health persist — a DB hiccup here never blocks the enrichment below or the sync.
      }
      if (info.institutionId) institutionName = await institutionsGet(info.institutionId);
    } catch {
      institutionName = null;
    }

    const startCursor = ctx.cursor != null && ctx.cursor !== "" ? ctx.cursor : undefined;
    const { accountsById, txnsById, removedSet, finalCursor } = await this.drain(accessToken, startCursor);

    // ── Holdings (#36) — the per-Item billing gate (option a): call /investments/holdings/get ONLY
    // when this Item's fresh account snapshot (from the drain above) includes ≥1 investment-type
    // account, so un-invested Items never start the per-Item Holdings subscription. The three
    // documented failure codes are BENIGN per-Item skips (no status=error, accounts+txns still sync,
    // NO reconcile); any OTHER failure rethrows — a real error must fail the sync loudly, and a
    // failed fetch must NEVER snapshot-reconcile (the mass-tombstone guard). The fetch runs BEFORE
    // any yield so a hard failure aborts the cycle cleanly instead of half-landing it.
    const hasInvestmentAccount = [...accountsById.values()].some(
      (a) => (a.type ?? "").toLowerCase() === "investment",
    );
    let holdingsSnapshot: PlaidHoldingsSnapshot | null = null;
    if (hasInvestmentAccount) {
      try {
        holdingsSnapshot = await investmentsHoldingsGet(accessToken);
      } catch (err) {
        if (!isBenignHoldingsSkip(err)) throw err;
        holdingsSnapshot = null; // benign per-Item skip — no holdings this sync, NO reconcile
      }
    }

    for (const a of accountsById.values()) {
      const raw: AccountRaw = { ...a, institution_name: institutionName };
      yield { object: "account", externalId: a.account_id, raw, cursor: finalCursor };
    }
    for (const t of txnsById.values()) {
      yield { object: "transaction", externalId: t.transaction_id, raw: t, cursor: finalCursor };
    }
    // Holdings: each holdings[] entry joined to its securities[] record; identity is the
    // (account_id, security_id) pair — Plaid holdings carry no id of their own.
    const holdingIds = new Set<string>();
    if (holdingsSnapshot) {
      const securitiesById = new Map(holdingsSnapshot.securities.map((s) => [s.security_id, s]));
      for (const h of holdingsSnapshot.holdings) {
        const raw: HoldingRaw = { ...h, __pci_security: securitiesById.get(h.security_id) ?? null };
        const externalId = `${h.account_id}:${h.security_id}`;
        holdingIds.add(externalId);
        yield { object: "holding", externalId, raw, cursor: finalCursor };
      }
    }
    // Surviving removed ids → deletion records. The runner tombstones (never upserts) these, so the
    // stub raw is never written; it just keeps the record shape honest.
    for (const id of removedSet) {
      yield { object: "transaction", externalId: id, deleted: true, raw: { transaction_id: id }, cursor: finalCursor };
    }

    // ── Holdings snapshot-tombstone reconcile (ADR 0004 / #36) — runs AFTER the final yield, i.e.
    // after the runner has consumed (upserted) every record above. Fires ONLY on:
    //   (a) a COMPLETE successful holdings enumeration — positions absent from the fresh snapshot
    //       are tombstoned; or
    //   (b) a successful NON-EMPTY accounts snapshot whose gate evaluated FALSE (holdings fetch never
    //       attempted): the Item genuinely has no investment accounts anymore, so any previously
    //       cached positions are gone — a truthful EMPTY-set reconcile (a no-op for Items that never
    //       had investments).
    // A benign skip, a thrown fetch, or a QUIET zero-account drain (a broken Item syncs as empty
    // arrays — indistinguishable from data loss) reconciles NOTHING: a transient miss must never
    // mass-tombstone real positions (HA's zero-state skip, applied here).
    if (holdingsSnapshot) {
      await reconcileObjectSnapshot(ctx.connectionId, "finance", "holding", holdingIds, syncStartedAt);
    } else if (!hasInvestmentAccount && accountsById.size > 0) {
      await reconcileObjectSnapshot(ctx.connectionId, "finance", "holding", new Set<string>(), syncStartedAt);
    }
  }

  /**
   * Drain /transactions/sync's has_more pages from `startCursor`, accumulating added+modified (deduped
   * by transaction_id; modified wins) + the accounts snapshot (deduped by account_id), with per-id
   * LAST-WINS removed reconciliation (Plaid can deliver the same id as added on one page then removed on
   * a later one; pending→posted is remove-old-id + add-new-id, never in-place). The FINAL next_cursor is
   * the durable checkpoint — the runner persists it ONCE at cycle end (cursorCommittedThrough unset), so
   * it advances ONLY after has_more=false, atomically-enough with the row writes (a mid-drain failure
   * never advances the cursor → the next run safely restarts from startCursor → idempotent upsert).
   *
   * On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION (the page set mutated mid-pagination) the WHOLE drain
   * restarts from `startCursor` (the pre-loop cursor) — never half-commit a mutated window (Plaid's
   * documented recovery), bounded by MAX_MUTATION_RETRIES so a persistently-mutating Item fails loudly.
   */
  private async drain(
    accessToken: string,
    startCursor: string | undefined,
  ): Promise<{
    accountsById: Map<string, PlaidAccount>;
    txnsById: Map<string, PlaidTransaction>;
    removedSet: Set<string>;
    finalCursor: string;
  }> {
    const MAX_MUTATION_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      let cursor = startCursor;
      const accountsById = new Map<string, PlaidAccount>();
      const txnsById = new Map<string, PlaidTransaction>();
      const removedSet = new Set<string>();
      let finalCursor = cursor ?? "";
      try {
        for (;;) {
          const page = await transactionsSync(accessToken, cursor);
          for (const a of page.accounts ?? []) accountsById.set(a.account_id, a);
          for (const t of page.added ?? []) {
            removedSet.delete(t.transaction_id); // a later add wins over an earlier remove
            txnsById.set(t.transaction_id, t);
          }
          for (const t of page.modified ?? []) {
            removedSet.delete(t.transaction_id); // a later modify wins over an earlier remove
            txnsById.set(t.transaction_id, t);
          }
          for (const r of page.removed ?? []) {
            txnsById.delete(r.transaction_id); // a later remove wins over an earlier add/modify
            removedSet.add(r.transaction_id);
          }
          finalCursor = page.next_cursor;
          cursor = page.next_cursor;
          if (!page.has_more) break;
        }
        return { accountsById, txnsById, removedSet, finalCursor };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") && attempt < MAX_MUTATION_RETRIES) {
          // Discard the partial accumulation and restart the whole drain from the pre-loop cursor.
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Live record drill (fetch_live {id}) → a fresh balance for ONE account via the per-call-BILLED
   * /accounts/balance/get (routine cached balances come free from /transactions/sync). The drill is
   * scoped to the one requested account_id and returns the matching account (or null when the id is
   * not an account — e.g. a transaction id). Non-storing (the generic fetch_live path never persists).
   */
  async fetchRecordLive(ctx: SyncContext, sourceObjectId: string): Promise<unknown> {
    const accessToken = ctx.secret;
    if (!accessToken) throw new Error("plaid: missing access token");
    const accounts = await accountsBalanceGet(accessToken, [sourceObjectId]);
    return accounts.find((a) => a.account_id === sourceObjectId) ?? null;
  }

  /** Branch on rec.object: account -> AccountRow, holding -> HoldingRow, else -> TransactionRow. */
  normalize(rec: RawRecord): AccountRow | TransactionRow | HoldingRow {
    if (rec.object === "account") return normalizeAccount(rec);
    if (rec.object === "holding") return normalizeHolding(rec);
    return normalizeTransaction(rec);
  }

  /** Deterministic strong keys: { account_id } / { account_id, security_id } / { txn_id }. */
  strongKeys(rec: RawRecord): Record<string, string> {
    if (rec.object === "account") {
      const id = String((rec.raw as { account_id?: unknown }).account_id ?? rec.externalId);
      return { account_id: id };
    }
    if (rec.object === "holding") {
      const h = rec.raw as { account_id?: unknown; security_id?: unknown };
      return { account_id: String(h.account_id ?? ""), security_id: String(h.security_id ?? "") };
    }
    const id = String((rec.raw as { transaction_id?: unknown }).transaction_id ?? rec.externalId);
    return { txn_id: id };
  }

  async execute(): Promise<ActionResult> {
    throw new Error("PlaidConnector has no actions (finance is read-only)");
  }
}

/** Map a Plaid account -> AccountRow. account_type/available_balance/institution_name are enrichment. */
function normalizeAccount(rec: RawRecord): AccountRow {
  const a = rec.raw as AccountRaw;
  const b = a.balances ?? {};
  return {
    source_object_id: a.account_id,
    name: a.name ?? null,
    account_type: a.type ?? null, // enrichment (SimpleFIN leaves null)
    currency: b.iso_currency_code ?? null,
    current_balance: normalizeBalance(b.current, a.type), // liability (credit/loan/mortgage) owed → NEGATIVE
    available_balance: numToString(b.available), // enrichment — Plaid available-credit passes through UNCHANGED
    // Plaid reports no balance timestamp → synthesize the ingest time and flag it.
    balance_at: new Date().toISOString(),
    balance_at_is_synthetic: true,
    institution_name: a.institution_name ?? null, // enrichment (threaded in by sync)
    // #34b dedup keys: mask is Plaid's clean last-4 field (the engine keys only on EXACTLY 4 digits, so a
    // short/alpha mask fails open to a visible dupe); org_domain is the institution domain when threaded
    // (best-effort; null → canonicalInstitution name-folds institution_name, which matched live for Amex).
    mask: typeof a.mask === "string" && a.mask !== "" ? a.mask : null,
    org_domain: a.institution_domain ?? null,
  };
}

/** Map a Plaid holding (+ its security joined under __pci_security) -> HoldingRow (#36). */
function normalizeHolding(rec: RawRecord): HoldingRow {
  const h = rec.raw as HoldingRaw;
  const sec = h.__pci_security ?? null;
  return {
    source_object_id: `${h.account_id}:${h.security_id}`,
    account_source_id: h.account_id ?? null,
    symbol: sec?.ticker_symbol ?? null, // null for cash rows / unlisted securities (dedup fails open)
    name: sec?.name ?? null,
    security_type: sec?.type ?? null, // enrichment (SimpleFIN leaves null — agent infers)
    quantity: numToString(h.quantity),
    market_value: numToString(h.institution_value),
    cost_basis: numToString(h.cost_basis), // as reported (faithful cache)
    currency: h.iso_currency_code ?? null,
    // institution_price_datetime (ISO) preferred; else institution_price_as_of (YYYY-MM-DD) at UTC
    // midnight; else the sync time (the synthetic balance_at precedent — Plaid may report neither).
    as_of: plaidDateToIso(h.institution_price_as_of, h.institution_price_datetime) ?? new Date().toISOString(),
  };
}

/** Map a Plaid transaction -> TransactionRow. amount NEGATED (Plaid positive = out → our negative = out). */
function normalizeTransaction(rec: RawRecord): TransactionRow {
  const t = rec.raw as PlaidTransaction;
  return {
    source_object_id: t.transaction_id,
    account_source_id: t.account_id ?? null,
    posted_at: plaidDateToIso(t.date, t.datetime),
    amount: negateToString(t.amount), // Plaid positive = OUT → store negative = OUT
    currency: t.iso_currency_code ?? null,
    description: t.name ?? null,
    merchant: t.merchant_name ?? null, // enrichment
    pending: t.pending === true,
    category: t.personal_finance_category?.primary ?? null, // enrichment (PFC primary)
    payment_channel: t.payment_channel ?? null, // enrichment
    authorized_at: plaidDateToIso(t.authorized_date, t.authorized_datetime), // enrichment
    location_city: t.location?.city ?? null,
    location_region: t.location?.region ?? null,
  };
}
