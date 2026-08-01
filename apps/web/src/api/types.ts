// REST contract types — derived 1:1 from the shipping gateway routes in `src/rest/*`
// and `src/core/*`. The Console is a thin typed client over the loopback operator
// surface; these shapes are the frozen wire contract every screen unit consumes.
// Sources: data-routes.ts + core/query.ts (reads), lifecycle.ts (status/ops),
// admin.ts (onboarding/agents/audit), plaid-routes.ts, oauth-routes.ts.

// ── Sectors (the six life domains) ──

/** The six life-domain sector keys. Not a served enum — it is the REGISTRY's own sector set
 *  (`src/core/schema.ts`), which is a compile-time contract, not a runtime value we could invent. */
export const SECTORS = ["finance", "mail", "calendar", "contacts", "health", "home"] as const;
export type Sector = (typeof SECTORS)[number];

/** Narrow an arbitrary string to a known sector (route params arrive as `string`). */
export function isSector(s: string): s is Sector {
  return (SECTORS as readonly string[]).includes(s);
}

/**
 * The REGISTRY object keys per sector — mirrors `src/core/schema.ts`'s REGISTRY exactly.
 *
 * Why a constant and STILL not a fetch: `get_schema` is now reachable (`GET /api/operator/schema`,
 * commit 8529bd3 — `api.getSchema()`), so this is no longer a stand-in for an unserved route. It stays
 * because it is a COMPILE-TIME contract available SYNCHRONOUSLY: a sector lens lays its objects out on
 * first paint, and a list that arrives one round-trip later is a layout that shifts under the reader.
 * This is not a synthesised *value* — it is the read contract's shape, which the FE already compiles
 * against. If a sector gains an object, this list and `src/core/schema.ts` change together.
 *
 * A surface that needs the served FIELDS of an object (types, primaryTime) must call `getSchema` —
 * never extend this constant with field lists, which is exactly how the two drift apart.
 */
export const SECTOR_OBJECTS: Record<Sector, readonly string[]> = {
  finance: ["finance.account", "finance.transaction", "finance.holding"],
  mail: ["mail"],
  calendar: ["calendar"],
  contacts: ["contacts"],
  health: ["health.sample", "health.workout", "health.sleep_session"],
  home: ["home"],
};

// ── Operator data-read (POST /api/data/:sector, GET /api/data/:sector/:id) ──

/** One cached domain row. Columns are sector-specific (see REGISTRY); `raw` JSON
 *  is present on the single-record drill (getRecord), absent on list rows. */
export type Row = Record<string, unknown>;

export interface OrderBy {
  field: string;
  dir?: "asc" | "desc";
}

export interface AggregateSpec {
  fn: "count" | "sum" | "avg" | "min" | "max";
  /** Required for sum/avg/min/max; forbidden for count. */
  field?: string;
  groupBy?: string[];
}

/** The /api/data/:sector body — the query DSL minus `sector` (the path supplies it). */
export interface QueryBody {
  where?: Record<string, unknown>;
  select?: string[];
  limit?: number;
  offset?: number;
  orderBy?: OrderBy[];
  aggregate?: AggregateSpec;
  /**
   * Reveal the pristine per-provider rows a cross-provider dedup shadowed (ADR 0021/0022).
   * **Finance sectors only** — `query()` answers a typed 400 that names the field anywhere else,
   * and the route's `.strict()` body rejects it for no other reason. Served TODAY
   * (`src/rest/data-routes.ts:41` → `core/query.ts`), so #82's dedup drill is buildable now.
   *
   * When true, rows additionally carry the core-applied READ-ONLY projection
   * `shadowed_by_id` / `dedup_group_id` — deliberately NOT REGISTRY fields, so they are not
   * filterable/sortable.
   */
  includeShadowed?: boolean;
}

/** query() rows-mode result. */
export interface QueryRowsResult {
  sector: string;
  object: string;
  count: number;
  rows: Row[];
}

/** One aggregate group: the groupBy columns under `group`, the value under `value`. */
export interface AggregateGroup {
  group: Record<string, unknown>;
  value: number | string | null;
}

/** query() aggregate-mode result. */
export interface AggregateResult {
  sector: string;
  object: string;
  aggregate: { fn: string; field?: string };
  count: number;
  groups: AggregateGroup[];
}

export type QueryResult = QueryRowsResult | AggregateResult;

/** Narrow a query() result to aggregate mode. */
export function isAggregateResult(r: QueryResult): r is AggregateResult {
  return "groups" in r;
}

// ── Status / lifecycle (lifecycle.ts) ──

export type ConnectorState = "active" | "paused" | "error" | "revoked" | "syncing";
export type PolicyMode = "poll" | "push" | "on_demand";

// ── Freshness (ADR 0023, #39/#40) — the ONE server-derived state word per connection ──

export type FreshnessState =
  | "ok"
  | "syncing"
  | "stale"
  | "unreachable"
  | "error"
  | "paused"
  | "disconnected"
  | "never_synced";

export type StreamState = "connected" | "retrying" | "down";

/** Connector-declared push transport (SyncPolicy.pushKind, issue #41 item 6): `stream` = a
 *  socket WE hold open (Home Assistant WS), `webhook` = the DEVICE posts to us (Apple Health).
 *  null = non-push connection, or a gateway that predates the field (legacy heuristic applies).
 *  Drives the caption vocabulary only — never the badge. */
export type PushKind = "stream" | "webhook";

/** Mirror of core/freshness.ts `Freshness`. The Console renders THIS — it never re-derives
 *  display state from raw status+timestamps (freshness-grammar ban #1). */
export interface Freshness {
  state: FreshnessState;
  /** The one "last synced" clock, every mode. */
  last_heard_at: string | null;
  /** Poll only. null MEANS something per mode: stream → "Instant — connected",
   *  webhook → "Device controlled" (see push_kind + stream_state). */
  next_expected_at: string | null;
  /** Push-stream transport fact — feeds captions, never the badge. null for non-stream. */
  stream_state: StreamState | null;
  error: { message: string; since: string | null } | null;
}

export interface ConnectorStatus {
  connectionId: string;
  /** The owning credential id — SERVED on every list row (core `toStatus`, `GET /api/connectors`),
   *  not just on the detail wire. Two connectors sharing this id share one consent/vault secret, so
   *  a credential-level revoke removes them all — the true blast radius is computable from the list
   *  alone, synchronously, without an N+1 detail fetch (and without the resolution race that fetch
   *  introduced). Keys the Revoke action (#8). */
  credentialId: string;
  provider: string;
  sector: string;
  status: ConnectorState;
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  policy_mode: PolicyMode;
  next_sync_at: string | null;
  scopes: string[];
  credential: { status: string; expires_at: string | null };
  webhook_secret_set_at: string | null;
  /** Per-connection recency window for mail (days); null = all history. For non-mail
   *  connectors this is null/ignored. Read default for mail is 180 (6 months). */
  sync_window_days: number | null;
  /** Per-connection poll cadence override in seconds (ADR 0025); null = the connector's
   *  default cadence. Only meaningful for poll connections. */
  sync_interval_sec: number | null;
  /** Connector-declared floor for cadence overrides (SyncPolicy.minIntervalSec); null =
   *  undeclared (the connector default is also the floor — users may only slow down). */
  min_interval_sec: number | null;
  /** The connector's default poll interval (SyncPolicy.defaultIntervalSec); null for non-poll. */
  default_interval_sec: number | null;
  /** Count of LIVE cached domain rows for this connection (deleted_at IS NULL).
   *  Powers the honest "Syncing… (N)" progress pill while the first sync lands. */
  cached_count: number;
  /** The connector's declared push transport (see PushKind). Served on list + detail rows
   *  (additive, spec push-restart-residuals item 6); null for poll/on_demand connections, and
   *  absent/undefined on a gateway that predates the field (the caption falls back to the old
   *  stream_state heuristic for one release of tolerance). */
  push_kind?: PushKind | null;
  /** The server-derived freshness tuple (ADR 0023). Optional for one release of tolerance:
   *  a gateway that predates it omits the field and the Console falls back to the raw fields. */
  freshness?: Freshness;
  /**
   * **SERVED (#89 item 1, commit 8529bd3)** on every connector row, list AND detail, by
   * `src/core/lifecycle.ts`. The server-named discriminant that chooses the attention banner's button.
   *
   * It is a property of CUSTODY, not of STATE, so it is present on healthy rows too — a surface may
   * read it before anything is broken (which is what lets "how would I reconnect this?" be answered
   * without a second fetch).
   *
   * THREE FACTS, and they are not interchangeable:
   *   · a member of `ReconnectKind` → the server names this reconnect flow.
   *   · `"none"`                    → SERVED, and this gateway can name no reconnect flow for the row
   *                                   (unrecognised custody on an unregistered provider). It means
   *                                   "we don't know", never "nothing is wrong".
   *   · `undefined`                 → NOT SERVED: a gateway that predates the field. **Keep the
   *                                   existing `Manage this connection →` fallback for this case** —
   *                                   the Console still runs against an older gateway during a
   *                                   staged deploy, and a missing field must not read as `"none"`.
   * `"none"` and `undefined` happen to route to the same generic affordance; they are still different
   * facts and a surface that wants to SAY which one it is must not collapse them (`notserved.test.ts`).
   *
   * Still do NOT derive it from `provider`: the same provider takes different custody by flow, and
   * `oauth-routes.ts` stamps `custody='first_party'` on every OAuth callback while the beta's OAuth is
   * BYO-app, so a provider→custody map would contradict the database. The server derives it from the
   * stored custody PLUS the connector's declared transport, which is why device-push (custody
   * `static_token`, transport `push`+`webhook`) does not read as "paste a fresh token".
   */
  reconnect_kind?: ReconnectKind;
}

/** How a connection is reconnected when its credential dies — mirrors `ReconnectKind` in
 *  `src/core/lifecycle.ts` EXACTLY (verified against commit 8529bd3). Server-named, client-rendered:
 *  the same discipline as `Freshness.state` and the dedup `bankKey`. */
export type ReconnectKind =
  | "repaste_token"
  | "reauth_oauth"
  | "plaid_update_link"
  | "device_push"
  | "none";

/** POST /api/connectors/:id/sync-window result. */
export interface SetSyncWindowResult {
  ok: true;
}

/** GET /api/connectors/:id — enriched status plus per-domain-table live-row counts. */
export interface ConnectorDetail extends ConnectorStatus {
  /** credentialId is inherited from ConnectorStatus (served on both wires). */
  counts: Record<string, number>;
}

/** DELETE /api/connectors/:id — connectionId-scoped hard disconnect (#18). */
export interface DisconnectResult {
  connectionId: string;
  /** Per backing-table deleted row counts (non-zero only). */
  deleted: Record<string, number>;
  /** True only when this was the credential's LAST connector (credential + vault secret removed). */
  credentialRemoved: boolean;
}

/** POST /api/connectors/:id/sync result. */
export interface SyncNowResult {
  connectionId: string;
  provider: string;
  mode: PolicyMode;
  ran: boolean;
  ok?: boolean;
  upserted?: number;
  deleted?: number;
  timed_out?: boolean;
  error?: string;
  note?: string;
  /** Push-stream connections: the persisted stream state at answer time (#39 honesty). */
  stream_state?: string;
  /** When the stream entered its current state (stream_changed_at). */
  stream_since?: string | null;
}

export interface PauseResult {
  connectionId: string;
  status: "paused";
}
export interface ResumeResult {
  connectionId: string;
  status: "active";
}
export interface RevokeCredentialResult {
  credentialId: string;
  provider: string;
  revokedConnectors: string[];
  secretsDeleted: number;
}

// ── Finance banks-by-institution (GET /api/finance/banks — #33) ──

/** One provider's contribution to a bank (one per distinct connector under the institution). */
export interface FinanceBankProvider {
  provider: "plaid" | "simplefin" | string;
  connectionId: string;
  /** Plaid /item/get health; null for SimpleFIN (and other providers). */
  itemStatus: string | null;
  lastSyncedAt: string | null;
}

/** One row per connected institution+card (the #34b dedup key) — the finance Connections view. */
export interface FinanceBankSummary {
  /** Canonical display name (the merged identity). */
  institution: string;
  /** Last-4 (••••1000); null when unresolved. */
  mask: string | null;
  /** Stable opaque per-card key. `possibleDuplicate.otherBankKey` and the dedup-candidates route's
   *  `aBankKey`/`bBankKey` reference it — the Console joins by key EQUALITY, zero dedup logic. */
  bankKey: string;
  /** The #34b merged-bank anchor; null = single-provider bank. */
  dedupGroupId: string | null;
  providers: FinanceBankProvider[];
  /** Live (deduped) accounts under this institution. */
  accountCount: number;
  health: "ok" | "action_required" | "error" | "unknown";
  /** Same mask, disagreeing canonical institution -> surfaced as a flagged un-merged pair. */
  unmergedDuplicate: boolean;
  /** Same institution+mask across providers, but the dedup engine's class guard refused the merge (the providers report different account kinds) -> both listed un-merged. */
  classConflict: boolean;
  /** SERVER-computed: this card and `otherBankKey`'s card look like the same account but lack mask
   *  proof — the engine never auto-merges without proof; the operator may confirm the merge. */
  possibleDuplicate?: { otherBankKey: string; confirmable: true };
  /** This card is a merge the operator confirmed — reversible via the id (Unmerge). */
  confirmedMerge?: { confirmationId: string };
  /** A stored confirmation covers this card but a currency/class conflict developed — the engine
   *  refuses the merge fail-open (accounts serve separately; the confirmation is kept, not honored). */
  confirmationSuspended?: { confirmationId: string; reason: "currency" | "class" };
  /**
   * **SERVED (#89 item 3, commit 8529bd3)** on every bank card by `src/rest/finance-routes.ts` — the
   * stored `finance_accounts.org_domain`, which is the primary signal the dedup engine already keys on.
   *
   * **VERBATIM, deliberately NOT normalised.** The scheme is not stripped, `www.` is not stripped, the
   * case is not folded — whatever the provider wrote is what arrives. The route refuses to serve the
   * grouping FOLD instead, because that function falls back to a NAME fold when the domain is absent,
   * which would smuggle name-guessing back in under a domain-shaped field name. A client that wants a
   * canonical form must normalise it itself, at the point of use, and own that choice.
   *
   * THREE FACTS:
   *   · a string    → this gateway has this domain for the card, exactly as stored.
   *   · `null`      → SERVED, and this gateway has no domain for the card (neither connector reported
   *                   one, or it is a zero-account placeholder). The correct cue for the monogram
   *                   default branch — a stated absence, not a missing answer.
   *   · `undefined` → NOT SERVED: a gateway that predates the field. Same visual fallback, different
   *                   fact; never render it as "no domain".
   *
   * Marks must still resolve by EXACT match — on the domain, or by exact normalised-name lookup with
   * the monogram tile as the default branch. Never loose substring matching: "First National Bank of
   * Discovery" must not pick up the Discover mark.
   */
  orgDomain?: string | null;
}

// ── Finance dedup trust — flag + confirm-merge (dedup-trust-batch child C) ──

/** One side of a confirmable/confirmed pair — the engine's stable (connection, soid) identity. */
export interface FinanceDedupRef {
  connectionId: string;
  sourceObjectId: string;
}

/** A candidate pair's side, with display context (mirrors core CandidateSide). */
export interface FinanceDedupCandidateSide extends FinanceDedupRef {
  accountId: string;
  provider: string;
  name: string | null;
  institutionName: string | null;
  mask: string | null;
}

/** GET /api/finance/dedup-candidates — a flagged possibly-the-same pair, stamped with the bank keys
 *  of the two cards it spans so the Console joins Confirm clicks to pairs by key equality. */
export interface FinanceDedupCandidate {
  institution: string;
  currency: string | null;
  a: FinanceDedupCandidateSide;
  b: FinanceDedupCandidateSide;
  aBankKey: string | null;
  bBankKey: string | null;
}

/** POST /api/finance/dedup-confirmations — the persisted operator confirmation (reversible). */
export interface FinanceDedupConfirmation {
  id: string;
  a: FinanceDedupRef;
  b: FinanceDedupRef;
}

// ── Onboarding (admin.ts, plaid-routes.ts, oauth-routes.ts) ──

export interface AddCredentialBody {
  provider: string;
  /** The token/secret to seal (SimpleFIN access URL, HA token, Gmail app-password, …). */
  secret: string;
  /** e.g. the Gmail address for IMAP. */
  username?: string;
  /** Per-instance address (Home Assistant WebSocket URL); only HA reads it. Not a secret. */
  instanceUrl?: string;
  purpose?: string;
}
export interface AddCredentialResult {
  credentialId: string;
  provider: string;
  status: string;
}

export interface CreateConnectorBody {
  credentialId: string;
  sector: string;
}
export interface CreateConnectorResult {
  connectionId: string;
  sector: string;
  provider: string;
  status: string;
}

// ── Apple / iCloud one-step fan-out (POST /api/onboard/apple — #26) ──

export interface AppleOnboardBody {
  appleId: string;
  /** An app-specific password (NEVER a plain Apple ID password). Sealed server-side; never echoed. */
  appSpecificPassword: string;
}
/** One `apple` static-token credential + the three read-only connectors it fans out to. */
export interface AppleOnboardResult {
  credentialId: string;
  provider: "apple";
  connectors: { connectionId: string; sector: string; status: string }[];
}

export interface OAuthStartResult {
  authorizationUrl: string;
}

/** POST /api/connectors/:id/webhook — the per-connection push-ingest secret (shown once). */
export interface MintIngestSecretResult {
  ingestUrl: string;
  secret: string;
}

// ── Agents (admin.ts) ──

export interface Agent {
  agentId: string;
  sectors: string[];
  created_at: string;
  revoked_at: string | null;
  /** Hard key deadline (agent_grants.expires_at); null = never-expiring. Optional for one release
   *  of tolerance: a gateway that predates the field omits it (treated as never). */
  expires_at?: string | null;
  /**
   * **SERVED (#89 item 4, commit 8529bd3)** by `listAgents`. Agent "passage" — when this key last came
   * through, ANY sector, allowed or denied.
   *
   * Computed as an aggregate over the WHOLE ledger, never over the paged feed. That distinction is the
   * trap: `/api/audit` is newest-first and capped, so reducing the FEED to a last-seen makes a quiet
   * agent fall off the end and render as "never" — false, not approximate, and it looks fine in every
   * fixture. Do not re-derive it here for that reason.
   *
   * It is a LOWER BOUND on activity, and honestly so: audit is fire-and-forget and droppable
   * (CLAUDE.md invariant), so a dropped line can only make a key look QUIETER than it was. Safe in the
   * direction that matters — this value never invents passage that did not happen.
   *
   * THREE FACTS:
   *   `undefined` → **not served** by this gateway. Render "not served", never "never".
   *   `null`      → served, and this agent has genuinely never been seen.
   *   a string    → the ISO instant of the last recorded call.
   */
  last_seen_at?: string | null;
  /**
   * **SERVED (#89 item 4, commit 8529bd3).** Last ALLOWED read per sector, keyed by sector — the
   * "what did it actually reach" half of passage, where `last_seen_at` is "did it come through at all".
   *
   * Same lower-bound caveat as `last_seen_at`. Three levels of absence, all different:
   *   `undefined`          → not served (a gateway that predates the field).
   *   `{}`                 → served, and this agent has no recorded allowed read anywhere.
   *   a MISSING sector key → served, and no recorded allowed read in THAT sector. A granted sector
   *                          with no key here is a grant the agent has never used — which is a real
   *                          and useful thing to say, and is NOT the same as the grant being absent.
   */
  last_read_at?: Record<string, string>;
}
export interface CreateAgentBody {
  agentId: string;
  sectors: string[];
  /** Key lifetime in whole days (1..3650); absent = the key never expires (the default).
   *  **The MINT convention, which is the OPPOSITE of the PATCH one** — see `AgentPatch`. */
  expiresInDays?: number;
}

/**
 * `PATCH /api/agents/:agentId` body (#80, commit 8529bd3) — edit the grant IN PLACE, without touching
 * `key_hash`. Rotating just to move a deadline forced every session to re-auth; this is the same edit
 * without destroying the secret.
 *
 * **`expiresInDays` IS TRI-STATE, and collapsing it silently changes behaviour:**
 *   · ABSENT (the key is not in the JSON at all) → the deadline is left EXACTLY as it was. This is why
 *     the shipped sectors-only edit keeps its meaning: a Console that never learned about expiry cannot
 *     clear a deadline by omission. A client that sent `null` for "unchanged" would silently make every
 *     sectors-only edit into "this key now never expires".
 *   · a NUMBER (1..3650)                         → `expires_at = now() + N days` (extend OR shorten).
 *   · explicit `null`                            → `expires_at = null`, i.e. **never expires**. A type
 *     that cannot express this makes "never expires" unreachable from the Console.
 * `sectors` ABSENT likewise leaves the grant set alone, so an expiry-only edit cannot clobber a
 * concurrently-changed sector array with a stale copy read for the render.
 *
 * A body carrying NEITHER field is a typed 400, not a silent 200 no-op. And an expiry edit is REFUSED
 * on a key that is already dead (revoked, or past its deadline) — an expiry change must never resurrect
 * a key, and rotation is the only path back from dead.
 *
 * Note `null` here also makes the key ineligible for the oauth-bridge authorize flow, which refuses a
 * never-expiring key by design (ADR 0035 §D3 item 6). A documented consequence of the edit, re-evaluated
 * per authorize — not a hole.
 */
export interface AgentPatch {
  /** Absent = leave the granted sectors alone. `[]` clears them (a grant that can read nothing). */
  sectors?: string[];
  /** Absent = leave the deadline alone · number = a new deadline N days out · `null` = never expires. */
  expiresInDays?: number | null;
}
/** The minted bearer key is returned ONCE (and only its sha256 persisted). */
export interface CreateAgentResult {
  agentId: string;
  sectors: string[];
  key: string;
  /** The server-computed deadline for the minted key; null = never. */
  expires_at?: string | null;
}

// ── Audit (admin.ts) ──

export interface AuditRow {
  id: string;
  agent_id: string | null;
  tool: string;
  sector: string | null;
  decision: "allow" | "deny";
  deny_reason: string | null;
  /** The redacted tool params (query DSL / action params) the call carried, or null. */
  args: unknown | null;
  result_count: number | null;
  outcome: string | null;
  request_id: string | null;
  created_at: string;
}
/**
 * The audit filters the gateway ACTUALLY accepts — verified against `getAudit` in `src/rest/admin.ts`
 * (commit 8529bd3). There are SEVEN now: `sector` and `before` landed with #61.
 *
 *  - **`sector` IS served now.** A plain equality clause on the dedicated `audit_log.sector` column.
 *    (build-notes §16.5 claimed this before it was true and was wrong then; it is true now.)
 *  - **`before` IS served now** — a KEYSET cursor, not an offset. Older history is reachable.
 *  - **Still no total count.** The response is a bare row array; there is no `{ rows, total }`
 *    envelope. A filtered-empty ledger cannot quote "the ledger holds N entries" from this route.
 *    What it CAN say is whether more pages exist — from the has-more response header, not a count.
 */
export interface AuditFilters {
  agent?: string;
  tool?: string;
  decision?: "allow" | "deny";
  /**
   * Exact sector match on `audit_log.sector` (#61 part 1). Matched VERBATIM and never validated
   * against the REGISTRY: the ledger is history, so a sector that no longer exists must return the
   * rows it has rather than a 400.
   *
   * It correctly EXCLUDES rows whose sector is null — the gateway-wide verbs (`describe_context`,
   * `get_schema`, an `initialize` denial), none of which happened *in* a sector. A surface that filters
   * by sector is therefore not looking at the whole ledger, and should not imply that it is.
   */
  sector?: string;
  /** ISO timestamp; rows with `created_at >= since`. An unparseable value is a typed 400. */
  since?: string;
  /**
   * The keyset cursor for the NEXT page (#61 part 2): **the previous response's
   * `x-postern-audit-next` header value, handed back BYTE-FOR-BYTE.** Read it off `AuditPage.nextCursor`.
   *
   * **Never rebuild this from a row's `created_at`.** node-postgres parses `timestamptz` into a
   * millisecond-precision JS `Date`, so the `created_at` on the wire has already LOST the microseconds
   * the cursor is anchored to. A cursor rebuilt from it lands up to 999µs off the row it was standing
   * on and every row inside that window is silently dropped from the walk. Sub-millisecond neighbours
   * are not exotic here — the audit writer flushes in batches, so a whole batch shares one microsecond.
   * The server mints the exact value as text for precisely this reason; a value that does not match its
   * grammar is a typed 400, because refusing to page beats mis-paging the one oversight surface.
   */
  before?: string;
  /** Server default AUDIT_LIMIT_DEFAULT, SILENTLY capped at AUDIT_LIMIT_MAX (`Math.min`) — a
   *  larger request is not an error, it just returns at most the ceiling. Caps ONE PAGE, not history. */
  limit?: number;
}

/** `getAudit`'s default when no `limit` is sent (`src/rest/admin.ts`). */
export const AUDIT_LIMIT_DEFAULT = 100;
/** `getAudit`'s hard server-side ceiling for ONE PAGE. Since #61 this no longer bounds what is
 *  REACHABLE: older rows are reached with the `before` cursor, never by raising this. */
export const AUDIT_LIMIT_MAX = 1000;

/**
 * `true`/`false` on EVERY 200 from `/api/audit` on a gateway that pages (`src/rest/admin.ts`
 * `AUDIT_HAS_MORE_HEADER`). Its ABSENCE is the signal that the gateway predates paging — which is why
 * the next-cursor header alone is not enough to read: without has-more, a missing cursor is
 * indistinguishable from "this gateway cannot page".
 */
export const AUDIT_HAS_MORE_HEADER = "x-postern-audit-has-more";
/** The opaque cursor for the next page; present iff has-more is `true`. Send it back as `before`. */
export const AUDIT_NEXT_HEADER = "x-postern-audit-next";

/**
 * One page of the ledger plus the paging facts that ride in the RESPONSE HEADERS — the only place the
 * cursor exists (the body is still the bare row array it always was, so every existing caller of
 * `api.audit()` is untouched).
 */
export interface AuditPage {
  rows: AuditRow[];
  /**
   * THREE FACTS:
   *   · `true`      → more matching rows exist older than this page; `nextCursor` carries the anchor.
   *   · `false`     → end of history for this filter. Authoritative, and NOT inferred from
   *                   `rows.length === limit`: the server uses a limit+1 probe row, so an exactly-full
   *                   final page correctly reports end-of-history instead of offering a cursor to
   *                   nothing. Do not second-guess it by counting rows.
   *   · `undefined` → **this gateway does not page** (it predates #61 and sent no has-more header).
   *                   Not the same as `false`: a surface may say "older entries are unreachable on this
   *                   gateway", which is a true statement about the wire, but must not say "that is all
   *                   there is", which would be a claim it cannot support.
   */
  hasMore: boolean | undefined;
  /** The cursor to pass as `AuditFilters.before`, VERBATIM; `null` when there is no next page (or the
   *  gateway does not page). Never synthesise one from a row — see `AuditFilters.before`. */
  nextCursor: string | null;
}

// ── Data-control plane (erase/export — Phase-2 flows; design-aware in U0) ──

export type EraseScope = "connection" | "sector" | "all";
export interface EraseBody {
  scope: EraseScope;
  connectionId?: string;
  sector?: string;
  confirm: string;
}

// ── The four primitives the Console could not reach — NOW SERVED ON THE OPERATOR EDGE ──
//
// `describe_context`, `get_schema`, `fetch_live` and the action catalog were the four reads the design
// needed and the operator-loopback surface did not serve. Commit 8529bd3 serves all four to the
// loopback operator (#57 / #58 / #82 / #89):
//   · `GET  /api/actions`               — the catalog, core's ActionCatalog VERBATIM.
//   · `GET  /api/operator/context`      — describe_context.
//   · `GET  /api/operator/schema`       — get_schema, filtered to the caller's granted sectors.
//   · `POST /api/operator/fetch_live`   — the one read-time upstream path.
//
// The last three are mounted at `/api/operator/*` and NOT as a loopback fallback on the bearer paths
// (`/api/context`, `/api/schema`, `/api/fetch_live`), deliberately: a fallback there would let a missing
// or mistyped bearer silently succeed as the ALL-SECTORS operator. Two disjoint resolvers on two
// disjoint path spaces. The client calls the operator paths and never the bearer ones.
//
// `NotServedError` does not go away with them — it now means "this GATEWAY is older than the route"
// (404/405), which is a real state during a staged deploy. And the distinction it exists for is
// unchanged and still the whole of #58: an empty answer is a CLAIM about capability, a missing route is
// a FACT about the wire, and neither may be rendered as the other.

/** A typed parameter of an action — mirrors `ActionParam` in `src/connectors/types.ts`. */
export interface ActionParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
}

/** One capability a connector exposes to act ON the source — mirrors `ActionSpec` in
 *  `src/connectors/types.ts`. Read-only connectors declare an empty catalog, which is a real
 *  served "no actions" answer and is NOT the same as the catalog being unreachable. */
export interface ActionSpec {
  /** Stable id, namespaced by sector (e.g. "home.light.turn_on"). */
  id: string;
  description: string;
  params: ActionParam[];
  /** The source domain (HA: the entity domain). Undefined for static catalogs. */
  domain?: string;
  /** The source service this action invokes (HA: e.g. "turn_on"). */
  service?: string;
  /** Which selector keys apply when targeting this action. */
  target?: { area?: boolean; entity?: boolean; domain?: string };
}

/**
 * `GET /api/actions` — the served action catalog, mirroring `ActionCatalog` in `src/core/actions.ts`
 * EXACTLY. The route hands core's answer over untouched: no re-shape, no re-sort, no re-filter.
 *
 * **NOT a bare array, and that is the point.** The route used not to exist, the client declared it as
 * `ActionSpec[]`, and a lens read `.length` — so the day the route landed the read became `undefined`,
 * which is falsy, and EVERY sector lens including Home reported "read-only, no actions" with no error
 * anywhere. A loud failure had become a silent wrong answer (#58). Reading `actions.length` cannot fail
 * that way, because the shape now names what it is.
 */
export interface ActionCatalog {
  /** The specs THIS response carries, id-sorted. `[]` is a real served answer — this sector genuinely
   *  exposes no actions (a read-only connector) — and is NOT the catalog being unreachable. */
  actions: ActionSpec[];
  /** `actions.length`. Items in THIS response, **never a total**: it says nothing about how many the
   *  catalog holds, so a surface must not quote it as "N actions exist" when `truncated` is true. */
  count: number;
  /**
   * **MUST BE SURFACED, never dropped.** `true` means the server's cap cut an ID-SORTED list, so what
   * came back is a prefix — and because the ids are sector-namespaced, a trimmed catalog can be missing
   * a whole trailing DOMAIN (every `switch.*` gone while `light.*` survives). Presenting a trimmed
   * catalog as the complete one is the silent-truncation defect already removed from the MCP surface
   * once; it must not re-enter here.
   *
   * The answer to `truncated` is a NARROWER FILTER (`area` / `domain` / `entityId` — see `ActionFilter`),
   * not a bigger limit. A surface that shows the catalog must say it is partial and offer the narrowing.
   */
  truncated: boolean;
}

/**
 * Narrowing for `GET /api/actions`. `area`/`domain`/`entityId` are passed VERBATIM to the connector,
 * which owns their meaning (Home Assistant joins them against its cached entity×service catalog).
 * `limit` is validated by core, so a bad value surfaces as core's typed 400 naming the field rather
 * than being coerced into a different question.
 *
 * `entityId` goes on the wire as `entity_id` — the ONE name mapping on this route, exactly as the MCP
 * tool does it. Dropping it would silently disable the filter rather than fail.
 */
export interface ActionFilter {
  area?: string;
  domain?: string;
  entityId?: string;
  limit?: number;
}

/** One connection as `describe_context` reports it (`src/core/context.ts`). */
export interface DescribeContextConnection {
  provider: string;
  sector: string;
  status: ConnectorState;
  last_synced_at: string | null;
  /** null when the provider has no registered connector (defensive). */
  mode: PolicyMode | null;
  /** Plaid-only Item health; null for every other provider. */
  health: { status: string; consentExpiresAt: string | null } | null;
  freshness: Freshness;
}

/** `GET /api/operator/context` (the Console) / `GET /api/context` (the bearer mirror) — what the caller
 *  can see. Revoked connections stay out; error/syncing/paused ones are listed (hiding a broken
 *  connection was the #39 lie). Same handler body, one shape, two resolvers. */
export interface DescribeContext {
  sectors: string[];
  connections: DescribeContextConnection[];
}

/** One REGISTRY object's published read contract (`get_schema`). */
export interface ObjectSchema {
  object: string;
  table: string;
  /** column → type name. The filter/sort/aggregate surface. */
  fields: Record<string, string>;
  primaryTime?: string;
}

/** `GET /api/operator/schema?sector=` (the Console) / `GET /api/schema?sector=` (the bearer mirror) —
 *  keyed by REGISTRY key ("finance.account", "mail", …). Filtered to the caller's granted sectors on
 *  BOTH surfaces: the operator's filter is not skipped, it runs against a granted set populated from
 *  ALL_SECTORS, so if that ever narrows both surfaces narrow together. An ungranted sector is simply
 *  absent from the result — `{}` means "nothing here for you", never "this gateway has no schema". */
export type SchemaResult = Record<string, ObjectSchema>;

/** One connection's post-sync transport truth inside a `fetch_live` sync answer (#39, ADR 0023). */
export interface FetchLiveConnection {
  connection_id: string;
  provider: string;
  mode: PolicyMode | null;
  freshness: Freshness;
}

/** `POST /api/operator/fetch_live` (the Console) / `POST /api/fetch_live` (the bearer mirror) — the ONE
 *  read-time upstream path. Sector sync-now, or a per-record live drill when `id` is supplied. The body
 *  is `.strict()` on both, so a MISNAMED `id` is a 400 rather than a drill silently degrading into a
 *  whole-sector sync (#1). Unlike the operator's cache-only reads this one IS audited: it reaches a
 *  source and mutates the cache, and the entry carries agentId `operator`. */
export type FetchLiveResult =
  | {
      sector: string;
      mode: "sync";
      synced: boolean;
      timed_out: boolean;
      last_synced_at: string | null;
      /** Per-connection failures, attributed + secret-free (sync errors AND dead push streams). */
      errors?: string[];
      connections: FetchLiveConnection[];
    }
  | { sector: string; mode: "record"; id: string; record: unknown };

// ── Public exposure (`GET/POST/DELETE /api/exposure` · ADR 0035 §D1/§D2/§D6) ──
//
// The gate's own public address. Loopback-only, like the rest of the admin group. Two facts are
// served separately and MUST NOT be collapsed: what the NEXT boot will use (`configured`) and what
// THIS process actually mounted (`serving`). The bridge reads its config once, at boot — making it
// dynamic would mean rebuilding the closure the edge hardening lives in — so a change is only real
// after a restart, and the Console says so rather than pretending.

/** Where the configured public address came from. A setting whose source is invisible is how a
 *  Console ends up quietly disagreeing with the box. */
export type BridgeSource = "db" | "env";

/**
 * A setting that EXISTS but could not be used — never the same fact as "there is no setting".
 *   · `db_unreadable` — the stored row could not be READ (a real DB fault). The gateway deliberately
 *     does NOT fall through to the env var here: "unreadable" and "absent" are different facts.
 *   · `db_invalid`    — a stored row exists but its address does not parse/validate on this build.
 *   · `env_invalid`   — `MCP_PUBLIC_URL` is set to something the gateway refuses.
 * `configured` is always null when this is set: a problem means nothing is published.
 */
export type BridgeProblem = "db_unreadable" | "db_invalid" | "env_invalid";

/** How a published route is guarded — the vocabulary ADR 0035 §D6 describes in prose. */
export type BridgeRouteAuth =
  | "open_no_user_data" // static discovery JSON, and the sign-in page itself
  | "open_write" // the unauthenticated write (DCR) — §D6's "one"
  | "code_gated" // needs a valid single-use code bound to a PKCE verifier
  | "key_login" // the agent-key login
  | "bearer_gated"; // /mcp itself

/** One route a whole-port Funnel publishes. The Console renders its disclosure FROM THIS ARRAY —
 *  never from a hardcoded list — so a bridge route cannot be published without appearing there. */
export interface BridgeRouteDescriptor {
  readonly path: string;
  readonly methods: readonly string[];
  readonly auth: BridgeRouteAuth;
}

/** `GET /api/exposure` (and the answer to POST and DELETE — one uniform row shape). */
export interface ExposureStatus {
  /** What the gateway will serve after the next restart. null = exposure is off. */
  configured: { publicUrl: string; source: BridgeSource; consentedAt: string | null } | null;
  /** What THIS running process mounted. null = nothing is published right now. */
  serving: { publicUrl: string } | null;
  /** `configured?.publicUrl !== serving?.publicUrl` — true in BOTH directions (saved-not-yet-live
   *  AND cleared-but-still-live). The Console renders a different sentence for each. */
  restartRequired: boolean;
  /** The MCP endpoint this gateway serves on the box, derived from its configured MCP port at
   *  request time; null when there is no MCP edge at all (so there is no address to hand an agent). */
  localEndpoint: string | null;
  publishedRoutes: BridgeRouteDescriptor[];
  problem: BridgeProblem | null;
  /**
   * **ADVISORY EVIDENCE — never a fact about reachability** (#119).
   *
   * Whether this process has been reached at the host of `configured.publicUrl` since it started.
   * Postern issues no `tailscale` command and holds no tailnet identity (ADR 0035 §D9), so it can
   * never answer *"can the internet get here?"*. What it CAN answer is *"has anything actually
   * arrived at the address you gave me?"* — read off the `Host` of requests its own public edge
   * has served. That is a strictly weaker claim, and it is the only one on offer.
   *
   *   · `true`      — traffic has arrived at that address since this gateway started
   *   · `false`     — this gateway has been reached since it started, but never at that address
   *   · `null`      — nothing has reached it at all (or there is no configured address to compare)
   *   · `undefined` — this gateway does not report it. **Not the same as `null`.** "Not served" is
   *                   a fact about the wire; "nothing yet" is an answer (`api/notserved.test.ts`),
   *                   and the Console must render no confirmation at all in the first case.
   *
   * The record is IN-MEMORY and starts empty again at every restart — which is correct, because the
   * question a user is asking ("is my Funnel working *now*") is about the running process. Optional
   * because a gateway older than #119 does not send the field.
   *
   * **A client-supplied `Host` is EVIDENCE, never authority** (spec §Decision 2). It may only ever
   * be shown to a human as an observation: it must never be auto-applied, never feed
   * `validatePublicUrl`, never become `configured`, and never widen any check — that is the
   * confused-deputy shape `public-edge-hardening` (U2) hardened against.
   */
  observedAtConfiguredAddress?: boolean | null;
}

// ── Health ──

export interface HealthzResult {
  ok: boolean;
}
