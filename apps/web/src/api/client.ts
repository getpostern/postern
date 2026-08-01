// Typed REST client — thin fetch wrappers over the live loopback gateway contract
// (`src/rest/*`). Operator/admin/data routes carry NO bearer: the gateway binds
// 127.0.0.1, so reaching them already implies operator trust (and a loopback
// Host-allowlist guards the admin/OAuth/Plaid group server-side). The agent
// bearer mirror (`/api/context`, `/api/schema`, `/api/query`, `/api/records/*`,
// `/api/fetch_live`) is a separate surface this client NEVER calls — the three
// primitives the Console needs are served to loopback at `/api/operator/*`
// instead, deliberately not as a fallback on the bearer paths, so a missing or
// mistyped bearer can never silently succeed as the all-sectors operator.
//
// Base URL: SAME-ORIGIN by default — every request path is RELATIVE, so the Console
// works at whatever address the browser reached it on (127.0.0.1:8787, a LAN IP, a
// tailnet name) instead of accusing itself of being down anywhere but one. The
// gateway serves the built Console from its own origin (src/rest/static.ts), so an
// absolute default would be a lie about the shipped product (ADR 0035 §D4).
// VITE_GATEWAY_URL is an escape hatch for a cross-origin dev setup, not the default.
// No secrets are ever stored in the client.

import { AUDIT_HAS_MORE_HEADER, AUDIT_NEXT_HEADER } from "./types";
import type {
  ActionCatalog,
  ActionFilter,
  AddCredentialBody,
  AddCredentialResult,
  Agent,
  AgentPatch,
  AppleOnboardBody,
  AppleOnboardResult,
  AuditFilters,
  AuditPage,
  AuditRow,
  ConnectorDetail,
  ConnectorStatus,
  CreateAgentBody,
  CreateAgentResult,
  CreateConnectorBody,
  CreateConnectorResult,
  DisconnectResult,
  EraseBody,
  FinanceBankSummary,
  FinanceDedupCandidate,
  FinanceDedupConfirmation,
  FinanceDedupRef,
  HealthzResult,
  MintIngestSecretResult,
  OAuthStartResult,
  PauseResult,
  QueryBody,
  QueryResult,
  ResumeResult,
  RevokeCredentialResult,
  Row,
  SetSyncWindowResult,
  SyncNowResult,
  DescribeContext,
  ExposureStatus,
  FetchLiveResult,
  SchemaResult,
  Sector,
} from "./types";

/**
 * The gateway origin. **Defaults to "" — same-origin, RELATIVE requests** (the shipped build; the
 * gateway serves this SPA itself). `??` not `||` so an explicit "" and an unset var agree. Set
 * VITE_GATEWAY_URL to an absolute origin ONLY for a cross-origin dev setup; never in the Dockerfile.
 */
export const GATEWAY_URL: string = import.meta.env.VITE_GATEWAY_URL ?? "";

// There is deliberately NO module-level MCP endpoint constant here any more, and the Vite env var
// that used to override it is retired with it.
// The MCP edge is a SEPARATE server on its own port — there is no fixed REST↔MCP offset, so it can
// never be derived from GATEWAY_URL — and a build-time constant was therefore a guess that went
// stale the moment the port moved and was a flat lie when the MCP edge was not running at all.
// Every surface now reads the address the GATEWAY reports (`getExposure().localEndpoint`, and
// `serving.publicUrl` for the public one). One string, one source: the same rule ADR 0035 §D4 set
// for the OAuth `redirect_uri`. If you find yourself re-adding a module constant here, the fix is
// to plumb the served value through, not to bake one in again.

/** The three interactive-OAuth providers (matches `isOAuthProvider` in `src/oauth/providers.ts`). */
export type OAuthProvider = "google" | "microsoft" | "whoop";

/** Status of a provider's BYO-app config (GET /api/oauth/:provider/app). `confidential`
 *  drives whether the setup form must collect a client secret (google/whoop) or not (microsoft). */
export interface OAuthAppStatus {
  configured: boolean;
  clientId: string | null;
  confidential: boolean;
}

// ── Plaid (grounded hosted-link onboarding · #14 / wave 13) ──
// The Console drives Plaid entirely through these loopback routes: configure a vault-sealed
// BYO Plaid app (client_id + secret + env), mint a hosted Link, then POLL for the banks the
// operator authenticates in Plaid's hosted page (the polled results object is the only
// authoritative success signal — the completion redirect fires on exit too). `client_secret`
// is sealed server-side and NEVER returned. Shapes mirror the spec's plaid-routes contract.

export type PlaidEnv = "sandbox" | "production";

/** GET /api/plaid/app — BYO Plaid app config status. The secret is never echoed. */
export interface PlaidAppStatus {
  configured: boolean;
  clientId: string | null;
  env: PlaidEnv;
}

/** A minted hosted-link URL (POST /api/plaid/hosted-link and /api/plaid/relink). Open
 *  `hostedLinkUrl` in a new tab; `linkToken` is the handle to poll for completion. */
export interface PlaidHostedLinkResult {
  linkToken: string;
  hostedLinkUrl: string;
}

/** Per-Item connection health (the error-state machine), surfaced so the Console can offer a
 *  "Reconnect" affordance on `action_required`. */
export type PlaidHealthStatus = "ok" | "action_required" | "transient" | "dead";

/** One bank exchanged + connected behind a hosted-link session (one per Plaid Item). */
export interface PlaidConnectedItem {
  connectionId: string;
  itemId: string;
  institutionName: string | null;
  health: { status: PlaidHealthStatus } | null;
}

/** POST /api/plaid/poll — the authoritative capture state. `complete` flips true once Plaid's
 *  results window has resolved; `connections` accumulates the exchanged Items (banks) so far. */
export interface PlaidPollResult {
  complete: boolean;
  connections: PlaidConnectedItem[];
}

/** A non-2xx REST response. `status` is the HTTP code; `message` is the safe `{ error }` body. */
export class RestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "RestError";
    this.status = status;
    this.body = body;
  }
}

/**
 * This gateway does not serve the thing that was asked for. **"Not served" is a FACT about the
 * wire; "none" is a CLAIM about the gateway's capability** — conflating them is the whole of #58,
 * and `CAN ACT: none` is the exact sentence this type exists to prevent.
 *
 * Two reasons, and they are genuinely different:
 *   - `no_route`      — the route does not exist on THIS gateway's build (404/405 on an `/api/*` path).
 *                       The four reads below are all served now (commit 8529bd3), so this means the box
 *                       is running an older gateway than the Console — a real state during a staged
 *                       deploy, and the reason these methods still map it rather than assuming success.
 *   - `unauthorized`  — the route exists but sits on the BEARER-GATED agent mirror (401/403) and the
 *                       caller carries no bearer. **No method here produces this today**: the Console
 *                       calls the loopback operator paths, never `/api/context` · `/api/schema` ·
 *                       `/api/fetch_live`. The reason is kept because it is the vocabulary for that
 *                       surface, and because narrowing an exported union breaks consumers for nothing.
 *
 * Every `message` is a renderable operator sentence beginning "Not served" — a surface may show it
 * verbatim next to its disabled affordance (the degradation contract's clause 2).
 */
export class NotServedError extends Error {
  readonly reason: "no_route" | "unauthorized";
  constructor(reason: "no_route" | "unauthorized", message: string) {
    super(message);
    this.name = "NotServedError";
    this.reason = reason;
  }
}

/**
 * Map a MISSING-ROUTE failure onto `NotServedError`, leaving every OTHER failure as the `RestError` it
 * is. A 500 is a broken gateway, not an unserved capability — folding it in here would turn an outage
 * into "this feature doesn't exist", which is the same lie in the other direction.
 *
 * **401/403 is deliberately NOT folded in, and that is a change from when these reads lived on the
 * bearer mirror.** They are on `/api/actions` and `/api/operator/*` now, which are `localOnly` — so the
 * only way to get a 403 there is the loopback **Host-allowlist**, the DNS-rebinding guard (a Console
 * opened at a non-allowlisted host, e.g. through a Funnel). That is a security-relevant rejection of
 * THIS REQUEST, not an absent capability, and every other operator route surfaces it as the `RestError`
 * it is. Calling it "not served — this is on the bearer-gated mirror, and the Console carries no agent
 * key" would be flatly false and would send the operator hunting for a bearer that is not the problem.
 *
 * `what` names the capability in operator words ("the action catalog"), never the route.
 */
function notServedIfNoRoute(err: unknown, what: string): never {
  if (err instanceof RestError && (err.status === 404 || err.status === 405)) {
    throw new NotServedError("no_route", `Not served — this gateway has no route for ${what} yet.`);
  }
  throw err;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * The one fetch path, returning the parsed body **and the response headers**.
 *
 * Headers are needed by exactly one caller today (`auditPage` — the ledger's keyset cursor rides in
 * `x-postern-audit-*` response headers, #61) and `request` below discards them, so every existing call
 * site keeps the shape it already compiles against. One transport, two return shapes: adding a second
 * fetch implementation for the header case is how the referrer/credentials hardening below ends up
 * applying to only half the surface.
 *
 * ⚠️ Custom response headers are readable because the Console is **same-origin** with the gateway by
 * default (`GATEWAY_URL === ""`; the gateway serves this SPA). Under a cross-origin `VITE_GATEWAY_URL`
 * dev setup the CORS layer hides any header not named in `Access-Control-Expose-Headers`, so
 * `hasMore`/`nextCursor` would read as `undefined`/`null` — which `AuditPage` types as "this gateway
 * does not page", i.e. it degrades to the honest answer rather than to a wrong one.
 */
async function requestWithHeaders<T>(
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ data: T; headers: Headers }> {
  // Defense-in-depth (security review, 1c-A): the Console handles material that must never leak —
  // agent bearer keys, ingest secrets, provider client secrets, OAuth tokens. No secret is ever in a
  // request URL today, but `no-referrer` guarantees one can never ride out in a Referer if a future
  // page URL carries one or the origin config changes, and `same-origin` keeps ambient credentials
  // from being sent cross-origin. Both are free on the loopback same-origin path.
  const init: RequestInit = { method, headers: {}, referrerPolicy: "no-referrer", credentials: "same-origin" };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${GATEWAY_URL}${path}`, init);

  // Parse a JSON body when present; tolerate empty 2xx responses.
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new RestError(res.status, msg, parsed);
  }
  return { data: parsed as T, headers: res.headers };
}

/** The parsed body alone — what every call site but `auditPage` wants. */
async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return (await requestWithHeaders<T>(method, path, body)).data;
}

/** Encode a path segment (sector / id / provider) safely. */
const seg = (s: string): string => encodeURIComponent(s);

/** `patchAgent`'s legacy sectors-only argument form. A hand-written guard because `Array.isArray`
 *  does not narrow a union member typed `readonly string[]`. */
const isSectorsOnly = (p: AgentPatch | readonly string[]): p is readonly string[] => Array.isArray(p);

/**
 * `/api/audit` with its seven served filters. ONE builder, shared by `audit` (rows) and `auditPage`
 * (rows + header cursor), so the two can never drift into asking different questions of the ledger —
 * a pager whose page 2 carried a filter its page 1 did not would silently walk a different history.
 *
 * Every filter is dropped when empty, matching `getAudit`, which reads each with a truthiness check and
 * so treats `?sector=` and no `sector` identically. Keeping the two sides aligned means the URL says
 * exactly what the server will apply.
 */
function auditPath(filters: AuditFilters): string {
  const q = new URLSearchParams();
  if (filters.agent) q.set("agent", filters.agent);
  if (filters.tool) q.set("tool", filters.tool);
  if (filters.decision) q.set("decision", filters.decision);
  if (filters.sector) q.set("sector", filters.sector);
  if (filters.since) q.set("since", filters.since);
  if (filters.before) q.set("before", filters.before);
  if (filters.limit != null) q.set("limit", String(filters.limit));
  const qs = q.toString();
  return `/api/audit${qs ? `?${qs}` : ""}`;
}

/**
 * The frozen Console REST surface. Every method maps to exactly one shipping route;
 * shapes come from `src/rest/*` and `src/core/*`, never guessed. See `./types.ts`.
 */
export interface RestClient {
  // operator data-read (powers the inspector)
  /** `body.includeShadowed` is served TODAY on the finance sectors (data-routes.ts) and is a typed
   *  400 naming the field anywhere else — pass it only on `finance.*`. */
  queryData(sector: string, body?: QueryBody): Promise<QueryResult>;
  getRecord(sector: string, id: string): Promise<{ record: Row }>;

  // ── The four reads that WERE unreachable and are now served on the operator edge ──
  // (#57 / #58 / #82 / #89 · commit 8529bd3.) Each still issues the REAL request; a 404/405 still
  // rejects with a typed NotServedError, because a box running an older gateway genuinely does not
  // serve them. What none of them may ever do is answer an empty list for a missing route: an empty
  // catalog from a read-only connector and an unreachable catalog are different facts (#58).
  //
  // The three mirror reads call `/api/operator/*`, NOT the bearer paths. There is no loopback fallback
  // on `/api/context` · `/api/schema` · `/api/fetch_live` by design — one there would let a missing or
  // mistyped bearer silently succeed as the ALL-SECTORS operator.

  /**
   * `GET /api/actions?sector=&area=&domain=&entity_id=&limit=` — the action catalog, served to the
   * loopback operator over core `listActions`.
   *
   * **Resolves to `ActionCatalog`, not a bare array**, because the wire is `{ actions, count,
   * truncated }` and a client that flattened it to an array would drop `truncated` — presenting a
   * trimmed, id-sorted prefix (possibly missing a whole trailing domain) as the whole surface. Reading
   * `.length` on the old bare-array declaration is what turned this route landing into a silent
   * "read-only, no actions" on every lens including Home (#58).
   *
   * `sector` omitted = every sector. Pass a `filter` to narrow when `truncated` comes back true — the
   * answer to truncation is a narrower filter, never a bigger limit.
   */
  listActions(sector?: Sector, filter?: ActionFilter): Promise<ActionCatalog>;
  /** `POST /api/operator/fetch_live` — the one read-time upstream path: sector sync-now, or a
   *  per-record live drill with `{ id }`. Served to loopback now (#57), so a surface may label it
   *  "Fetch live" and mean it. Audited server-side as the operator. */
  fetchLive(sector: string, opts?: { id?: string }): Promise<FetchLiveResult>;
  /** `GET /api/operator/context` — "as an agent sees it" (#82). */
  describeContext(): Promise<DescribeContext>;
  /** `GET /api/operator/schema?sector=` — the published read contract, filtered to granted sectors. */
  getSchema(sector?: string): Promise<SchemaResult>;
  // status / lifecycle
  listConnectors(): Promise<ConnectorStatus[]>;
  /** The finance banks-by-institution view (#33) — one row per connected bank, deduped across providers. */
  getFinanceBanks(): Promise<FinanceBankSummary[]>;
  /** Server-flagged possibly-the-same pairs the engine cannot prove (no last-4) — each stamped with
   *  the two cards' bank keys, so Confirm joins by key equality (zero FE dedup logic). */
  getFinanceDedupCandidates(): Promise<FinanceDedupCandidate[]>;
  /** Confirm a flagged pair IS the same account (operator ground truth) — the gateway merges it on
   *  the spot (reversible; audited server-side). */
  confirmDedupMerge(a: FinanceDedupRef, b: FinanceDedupRef): Promise<FinanceDedupConfirmation>;
  getConnector(id: string): Promise<ConnectorDetail>;
  pause(id: string): Promise<PauseResult>;
  resume(id: string): Promise<ResumeResult>;
  syncNow(id: string): Promise<SyncNowResult>;
  /** Set a mail connection's recency window in days (7…36500), or null for all history. */
  setSyncWindow(connectionId: string, days: number | null): Promise<SetSyncWindowResult>;
  /** Set a poll connection's sync cadence in seconds (≥ the connector's floor, ≤ 30 days), or
   *  null to reset to the connector default (ADR 0025). Non-poll connections reject with 409. */
  setSyncInterval(connectionId: string, intervalSec: number | null): Promise<{ ok: true }>;
  revokeCredential(credentialId: string): Promise<RevokeCredentialResult>;
  /** Hard-disconnect a connection (#18). `confirmToken` is a fat-finger guard — echo the connectionId. */
  disconnectConnection(connectionId: string, confirmToken: string): Promise<DisconnectResult>;
  /** Remove a revoked agent grant (#24). Gated server-side to already-revoked agents. */
  deleteAgent(agentId: string): Promise<{ ok: true }>;
  // onboarding
  addCredential(body: AddCredentialBody): Promise<AddCredentialResult>;
  createConnector(body: CreateConnectorBody): Promise<CreateConnectorResult>;
  /** Apple / iCloud one-step fan-out (#26): one app-specific-password credential → mail + calendar +
   *  contacts connectors, created atomically server-side. The ASP is sealed and never echoed. */
  appleOnboard(body: AppleOnboardBody): Promise<AppleOnboardResult>;
  /** Fetch the provider's consent URL from its start endpoint (`GET /api/oauth/:provider/start`,
   *  which answers JSON `{ authorizationUrl }`). */
  oauthAuthorizationUrl(provider: string): Promise<string>;
  /** BYO-app config status for a provider (configured? client id? confidential?). */
  oauthAppStatus(provider: string): Promise<OAuthAppStatus>;
  /** The EXACT `redirect_uri` this gateway will send to the provider, as the gateway itself reports
   *  it (`GET /api/oauth/:provider/app` → `redirectUri`). The Console renders this VERBATIM and
   *  NEVER derives its own — one string, one source (ADR 0035 §D4). Rejects
   *  `NotServedError{reason:"no_route"}` if the gateway does not answer with one, so an older or
   *  misconfigured build produces a stated absence rather than `undefined` in a `<code>`. */
  oauthRedirectUri(provider: string): Promise<string>;
  /** Set/replace a provider's BYO-app credentials. The secret is sealed in the vault
   *  server-side; required for confidential providers (google/whoop), rejected for public (microsoft). */
  setOauthApp(provider: string, body: { clientId: string; clientSecret?: string }): Promise<void>;
  /** Clear a provider's configured BYO app (#20) — removes the row + its sealed secret server-side.
   *  A subsequent oauthAppStatus reports configured:false. */
  deleteOauthApp(provider: string): Promise<void>;
  // ── Plaid grounded hosted-link onboarding (#14) ──
  /** BYO Plaid app config status (configured? client id? env?). Secret never returned. */
  plaidAppStatus(): Promise<PlaidAppStatus>;
  /** Set/replace the BYO Plaid app credentials. The secret is sealed in the vault server-side. */
  setPlaidApp(body: { clientId: string; clientSecret: string; env: PlaidEnv }): Promise<void>;
  /** Clear the configured Plaid app + its sealed secret. A subsequent plaidAppStatus reports configured:false. */
  deletePlaidApp(): Promise<void>;
  /** Mint a hosted Link session (multi-item) — open `hostedLinkUrl`, then poll `linkToken`. */
  plaidHostedLink(): Promise<PlaidHostedLinkResult>;
  /** Poll a hosted-link session for the banks authenticated so far (the authoritative success signal). */
  plaidPoll(linkToken: string): Promise<PlaidPollResult>;
  /** Update-mode re-link for a broken Item — mints a link carrying the stored token (no row repointing). */
  plaidRelink(connectionId: string): Promise<PlaidHostedLinkResult>;
  mintIngestSecret(connectorId: string): Promise<MintIngestSecretResult>;
  // agents
  listAgents(): Promise<Agent[]>;
  /** Mint (or re-mint/rotate — same agentId replaces the key) a scoped bearer. `expiresInDays`
   *  (1..3650) sets a hard deadline server-side; absent = the key never expires. */
  createAgent(body: CreateAgentBody): Promise<CreateAgentResult>;
  /**
   * `PATCH /api/agents/:agentId` — edit the grant IN PLACE (#80): the granted sectors, the key's
   * expiry, or both. No rotation, so no session is forced to re-auth just to move a deadline.
   *
   * **`AgentPatch.expiresInDays` is TRI-STATE and this client preserves it on the wire**: an ABSENT
   * field is omitted from the JSON entirely (the deadline is untouched), and an explicit `null` is
   * serialized as `null` (never expires). Sending `null` where "unchanged" was meant would silently
   * clear the deadline on every sectors-only edit — which is why the two are built separately here
   * rather than by spreading an object with an `undefined` value and trusting `JSON.stringify`.
   *
   * The bare `string[]` form is the shipped sectors-only call, kept verbatim: it is exactly
   * `{ sectors }`, it sends no expiry key, and dropping it would break existing callers to express
   * nothing new.
   */
  patchAgent(agentId: string, patch: AgentPatch | readonly string[]): Promise<Agent>;
  revokeAgent(agentId: string): Promise<{ agentId: string; revoked_at: string }>;
  // ── public exposure (ADR 0035 §D1) ──
  /** What this gateway is configured to publish, what it is actually serving right now, the local
   *  MCP endpoint, and the exact route set a whole-port Funnel exposes. `configured` and `serving`
   *  are different facts and the Console renders the disagreement rather than hiding it. */
  getExposure(): Promise<ExposureStatus>;
  /** Publish this gate at `publicUrl`. `acknowledged` is the RECORDED consent, and the literal
   *  `true` is enforced server-side — this client cannot skip it and neither can a Console bug.
   *  Takes effect on the next gateway restart; the returned status says so. */
  setExposure(body: { publicUrl: string; acknowledged: true }): Promise<ExposureStatus>;
  /** Stop publishing. Idempotent. The edge KEEPS SERVING until the gateway restarts — the returned
   *  status still carries `serving`, and no surface may read this as "private now". */
  clearExposure(): Promise<ExposureStatus>;

  // data-control (Phase-2 flows; design-aware in U0)
  erase(body: EraseBody): Promise<unknown>;
  exportBundle(): Promise<unknown>;
  // audit / health
  /**
   * The append-only trail, newest first — **the rows only**. Seven filters exist and no more: `agent`,
   * `tool`, `decision`, `sector`, `since`, `before`, `limit` (see `AuditFilters`). There is still no
   * total count.
   *
   * This returns the bare array it always has, so every existing call site is untouched. It CANNOT tell
   * you whether older rows exist — that fact lives in the response headers. Use `auditPage` when the
   * surface pages; do not infer "end of history" from `rows.length < limit` (see `AuditPage.hasMore`).
   */
  audit(filters?: AuditFilters): Promise<AuditRow[]>;
  /**
   * The same request as `audit`, plus the keyset paging facts the gateway puts in RESPONSE HEADERS
   * (#61): `x-postern-audit-has-more` and `x-postern-audit-next`.
   *
   * Feed `nextCursor` straight back as `AuditFilters.before`, byte-for-byte — the cursor is server-minted
   * because the `created_at` on the wire has lost the microseconds it is anchored to, so one rebuilt from
   * a row silently drops every row inside a sub-millisecond window (and the audit writer flushes in
   * batches, so those neighbours are routine).
   *
   * `hasMore: undefined` means the gateway sent no has-more header at all, i.e. it predates paging — a
   * different fact from `false`, and the reason the cursor header alone is not enough to read.
   */
  auditPage(filters?: AuditFilters): Promise<AuditPage>;
  healthz(): Promise<HealthzResult>;
}

export const api: RestClient = {
  // ── reads ──
  queryData(sector, body = {}) {
    return request<QueryResult>("POST", `/api/data/${seg(sector)}`, body);
  },
  getRecord(sector, id) {
    return request<{ record: Row }>("GET", `/api/data/${seg(sector)}/${seg(id)}`);
  },

  // ── the four operator reads: real call, honest typed failure on an older gateway ──
  async listActions(sector, filter) {
    // `entity_id` is the wire spelling of core's `entityId` — the ONE name mapping on this route (the
    // MCP tool does it identically). Spelling it `entityId` would silently disable the filter and
    // return a WIDER catalog than asked for, rather than failing.
    //
    // `area` is the first free-text query value the Console sends, so the encoding was checked rather
    // than assumed: URLSearchParams writes a space as `+`, and the gateway parses with `url.searchParams`
    // (src/rest/index.ts), which decodes `+` back to a space. "Living Room" round-trips. A hand-rolled
    // `encodeURIComponent` join on either side would break that pairing in one direction only.
    const q = new URLSearchParams();
    if (sector !== undefined) q.set("sector", sector);
    if (filter?.area !== undefined) q.set("area", filter.area);
    if (filter?.domain !== undefined) q.set("domain", filter.domain);
    if (filter?.entityId !== undefined) q.set("entity_id", filter.entityId);
    if (filter?.limit !== undefined) q.set("limit", String(filter.limit));
    const qs = q.toString();
    try {
      // The catalog is passed through VERBATIM — `truncated` and `count` reach the caller untouched.
      // Never reduce this to `.actions`: that is precisely how the cap's honest signal gets dropped.
      return await request<ActionCatalog>("GET", `/api/actions${qs ? `?${qs}` : ""}`);
    } catch (err) {
      return notServedIfNoRoute(err, "the action catalog");
    }
  },
  async fetchLive(sector, opts) {
    try {
      const body: { sector: string; id?: string } = { sector };
      if (opts?.id != null) body.id = opts.id;
      return await request<FetchLiveResult>("POST", "/api/operator/fetch_live", body);
    } catch (err) {
      return notServedIfNoRoute(err, "fetching live from the source");
    }
  },
  async describeContext() {
    try {
      return await request<DescribeContext>("GET", "/api/operator/context");
    } catch (err) {
      return notServedIfNoRoute(err, "the agent's view of this gateway");
    }
  },
  async getSchema(sector) {
    try {
      const qs = sector ? `?sector=${seg(sector)}` : "";
      return await request<SchemaResult>("GET", `/api/operator/schema${qs}`);
    } catch (err) {
      return notServedIfNoRoute(err, "the published read schema");
    }
  },

  // ── status / lifecycle ──
  listConnectors() {
    return request<ConnectorStatus[]>("GET", "/api/connectors");
  },
  getFinanceBanks() {
    return request<FinanceBankSummary[]>("GET", "/api/finance/banks");
  },
  getFinanceDedupCandidates() {
    return request<FinanceDedupCandidate[]>("GET", "/api/finance/dedup-candidates");
  },
  confirmDedupMerge(a, b) {
    return request<FinanceDedupConfirmation>("POST", "/api/finance/dedup-confirmations", { a, b });
  },
  getConnector(id) {
    return request<ConnectorDetail>("GET", `/api/connectors/${seg(id)}`);
  },
  pause(id) {
    return request<PauseResult>("POST", `/api/connectors/${seg(id)}/pause`);
  },
  resume(id) {
    return request<ResumeResult>("POST", `/api/connectors/${seg(id)}/resume`);
  },
  syncNow(id) {
    return request<SyncNowResult>("POST", `/api/connectors/${seg(id)}/sync`);
  },
  setSyncWindow(connectionId, days) {
    return request<SetSyncWindowResult>("POST", `/api/connectors/${seg(connectionId)}/sync-window`, { days });
  },
  setSyncInterval(connectionId, intervalSec) {
    return request<{ ok: true }>("POST", `/api/connectors/${seg(connectionId)}/sync-interval`, {
      interval_sec: intervalSec,
    });
  },
  revokeCredential(credentialId) {
    return request<RevokeCredentialResult>("POST", `/api/credentials/${seg(credentialId)}/revoke`);
  },
  disconnectConnection(connectionId, confirmToken) {
    return request<DisconnectResult>("DELETE", `/api/connectors/${seg(connectionId)}`, { confirmToken });
  },

  // ── onboarding ──
  addCredential(body) {
    return request<AddCredentialResult>("POST", "/api/credentials", body);
  },
  createConnector(body) {
    return request<CreateConnectorResult>("POST", "/api/connectors", body);
  },
  appleOnboard(body) {
    return request<AppleOnboardResult>("POST", "/api/onboard/apple", body);
  },
  async oauthAuthorizationUrl(provider) {
    const r = await request<OAuthStartResult>("GET", `/api/oauth/${seg(provider)}/start`);
    return r.authorizationUrl;
  },
  async oauthAppStatus(provider) {
    const r = await request<{ provider: string; configured: boolean; clientId: string | null; confidential: boolean }>(
      "GET",
      `/api/oauth/${seg(provider)}/app`,
    );
    return { configured: r.configured, clientId: r.clientId, confidential: r.confidential };
  },
  async oauthRedirectUri(provider) {
    const r = await request<{ redirectUri?: unknown }>("GET", `/api/oauth/${seg(provider)}/app`);
    if (typeof r.redirectUri !== "string" || r.redirectUri.length === 0) {
      throw new NotServedError(
        "no_route",
        "Not served — this gateway did not answer with the redirect URI it uses.",
      );
    }
    return r.redirectUri;
  },
  async setOauthApp(provider, body) {
    await request<{ ok: true }>("POST", `/api/oauth/${seg(provider)}/app`, body);
  },
  async deleteOauthApp(provider) {
    await request<{ ok: true }>("DELETE", `/api/oauth/${seg(provider)}/app`);
  },
  plaidAppStatus() {
    return request<PlaidAppStatus>("GET", "/api/plaid/app");
  },
  async setPlaidApp(body) {
    await request<{ ok: true }>("POST", "/api/plaid/app", body);
  },
  async deletePlaidApp() {
    await request<{ ok: true }>("DELETE", "/api/plaid/app");
  },
  plaidHostedLink() {
    return request<PlaidHostedLinkResult>("POST", "/api/plaid/hosted-link");
  },
  plaidPoll(linkToken) {
    return request<PlaidPollResult>("POST", "/api/plaid/poll", { linkToken });
  },
  plaidRelink(connectionId) {
    return request<PlaidHostedLinkResult>("POST", "/api/plaid/relink", { connectionId });
  },
  mintIngestSecret(connectorId) {
    return request<MintIngestSecretResult>("POST", `/api/connectors/${seg(connectorId)}/webhook`);
  },

  // ── agents ──
  listAgents() {
    return request<Agent[]>("GET", "/api/agents");
  },
  createAgent(body) {
    return request<CreateAgentResult>("POST", "/api/agents", body);
  },
  patchAgent(agentId, patch) {
    // Built key-by-key on purpose. An ABSENT `expiresInDays` must not appear in the JSON at all (the
    // deadline is left exactly as it was), while an explicit `null` MUST appear as null (never expires).
    // Spreading a patch object whose value happens to be `undefined` reaches the same wire today only
    // because JSON.stringify drops undefined — an accident, not a contract, and the direction it fails
    // in is silently clearing every deadline on a sectors-only edit.
    const body: { sectors?: string[]; expiresInDays?: number | null } = {};
    if (isSectorsOnly(patch)) {
      body.sectors = [...patch];
    } else {
      if (patch.sectors !== undefined) body.sectors = patch.sectors;
      if (patch.expiresInDays !== undefined) body.expiresInDays = patch.expiresInDays;
    }
    return request<Agent>("PATCH", `/api/agents/${seg(agentId)}`, body);
  },
  revokeAgent(agentId) {
    return request<{ agentId: string; revoked_at: string }>(
      "POST",
      `/api/agents/${seg(agentId)}/revoke`,
    );
  },
  deleteAgent(agentId) {
    return request<{ ok: true }>("DELETE", `/api/agents/${seg(agentId)}`);
  },

  // ── public exposure ──
  getExposure() {
    return request<ExposureStatus>("GET", "/api/exposure");
  },
  setExposure(body) {
    return request<ExposureStatus>("POST", "/api/exposure", body);
  },
  clearExposure() {
    return request<ExposureStatus>("DELETE", "/api/exposure");
  },

  // ── data-control (Phase-2) ──
  erase(body) {
    return request<unknown>("POST", "/api/erase", body);
  },
  exportBundle() {
    return request<unknown>("GET", "/api/export");
  },

  // ── audit / health ──
  audit(filters = {}) {
    return request<AuditRow[]>("GET", auditPath(filters));
  },
  async auditPage(filters = {}) {
    const { data, headers } = await requestWithHeaders<AuditRow[]>("GET", auditPath(filters));
    // ABSENT has-more header = a gateway that predates paging. `undefined` says that; `false` would
    // claim "this is all there is", which such a gateway cannot support (AuditPage.hasMore).
    const raw = headers.get(AUDIT_HAS_MORE_HEADER);
    const hasMore = raw === null ? undefined : raw === "true";
    // The cursor is only meaningful WITH has-more. A stray -next header on a gateway that does not
    // report has-more is not a page we can honour, so it is not offered as one.
    const nextCursor = hasMore === true ? headers.get(AUDIT_NEXT_HEADER) : null;
    return { rows: data, hasMore, nextCursor };
  },
  async healthz() {
    // /healthz returns { status: "ok" | "shutting_down" | "unavailable" }; 503 throws.
    const r = await request<{ status: string }>("GET", "/healthz");
    return { ok: r.status === "ok" };
  },
};
