// Connection lifecycle + status — the operator's control plane over a connection's *liveness* and a
// *credential's* validity (wave 10A). Three independent verbs plus operator sync-now and an enriched
// status read:
//   - pause/resume  — stop/restart sync, keep data, reversible.
//   - revoke        — kill the account link (credential + all its connectors → 'revoked'; delete the
//                     vault secret(s)); the cached domain rows are KEPT as read-only orphaned cache,
//                     and the credential row LINGERS (deleting it would FK-cascade away connectors →
//                     domain rows, breaking verb independence). Erase (10B) destroys data separately.
//   - sync-now      — operator-initiated pull for poll/on_demand connectors (push reconciles itself).
//
// Every op is user_id-scoped: an operator only ever touches their OWN rows — a foreign/unknown id is
// a NotFoundError (→ 404), never a cross-user mutation. Each successful destructive op writes ONE
// async audit entry. No secret/token/plaintext is ever logged or returned.

import { pool } from "../db.js";
import { NotFoundError } from "./context.js";
import { QueryValidationError } from "./query.js";
import { tablesForSector, allDomainTables } from "./schema.js";
import { deriveFreshness, pushKindOf, type Freshness } from "./freshness.js";
import { reconcileFinance } from "./finance-dedup.js";
import {
  getConnector,
  syncConnection,
  maskError,
  effectiveIntervalSec,
  intervalFloorSec,
  type SyncResult,
} from "../sync/index.js";
import { removePlaidItem } from "../connectors/plaid.js";
import { deleteSecret } from "../secrets/store.js";
import { audit, type AuditTool } from "../audit/index.js";
import type { AuthContext } from "../auth/index.js";

/** A lifecycle op was rejected because the connector is in the wrong state (REST: 409). */
export class ConflictError extends Error {
  override name = "ConflictError";
}

/** uuid syntax guard — a malformed id is a typed NotFoundError, never a bare pg cast error (22P02). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bounded WAIT on an operator sync-now (mirrors fetch_live's FETCH_LIVE_WAIT_MS). */
const SYNC_NOW_WAIT_MS = 30_000;

/** The admin verbs recorded in audit_log.tool. The column is free text; the AuditTool union only
 *  enumerates the seven read/act primitives, so these widen the recorded vocabulary via a cast. */
export type AdminAuditTool =
  | "pause"
  | "resume"
  | "revoke"
  | "sync_now"
  | "disconnect"
  | "set_plaid_app"
  | "delete_plaid_app"
  | "set_sync_interval"
  | "set_exposure"
  | "clear_exposure";

/** Fire one async audit line for an operator admin op (decision always 'allow' — loopback-trusted).
 *  Exported so the loopback REST handlers (e.g. plaid_app set/delete) reuse the ONE admin-audit shape
 *  rather than forking a second helper. */
export function auditAdmin(userId: string, tool: AdminAuditTool, args: unknown, outcome: "ok" | "error"): void {
  audit({
    userId,
    agentId: "operator",
    tool: tool as unknown as AuditTool,
    decision: "allow",
    args,
    outcome,
  });
}

/** Normalize a pg timestamp (Date | string | null) to an ISO string or null. */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Best-effort: close a push connector's live socket on pause/revoke. Never throws (duck-typed stop). */
function bestEffortStop(provider: string, connectionId: string): void {
  try {
    const connector = getConnector(provider);
    if (connector?.policy.mode === "push") {
      (connector as { stop?: (id: string) => void }).stop?.(connectionId);
    }
  } catch {
    // best-effort only — a failed socket close must not fail the lifecycle op.
  }
}

// ── Status read ───────────────────────────────────────────────────────────────

/**
 * How this connection is RECONNECTED when its credential dies — the server-named discriminant the
 * attention banner switches on (#89 item 1, build-notes §16.1). The server names the state, the
 * client renders it (the ADR 0023 / dedup-`bankKey` discipline).
 *
 *   repaste_token     — the operator pastes a fresh token/app-password (POST /api/credentials).
 *   reauth_oauth      — re-run provider consent (GET /api/oauth/:provider/start).
 *   plaid_update_link — Plaid update-mode Link, carrying the stored token (POST /api/plaid/relink).
 *   device_push       — nothing to re-auth upstream: re-mint the webhook secret and re-point the
 *                       device (POST /api/connectors/:id/webhook).
 *   none              — this gateway can name no reconnect flow for this row (unrecognised custody
 *                       on an unregistered provider). NOT "nothing is wrong" — it is "we don't know",
 *                       so a client must fall back to the generic manage-this-connection route.
 */
export type ReconnectKind =
  | "repaste_token"
  | "reauth_oauth"
  | "plaid_update_link"
  | "device_push"
  | "none";

/**
 * Derive `reconnect_kind` from the STORED credential custody plus the connector's DECLARED transport.
 * Pure + exported so the rule is testable on its own.
 *
 * Custody alone is NOT sufficient, and that is the whole reason this is derived server-side rather
 * than mapped in the front end:
 *   - Device push is onboarded through POST /api/credentials with a sentinel secret, so its row is
 *     stamped custody `static_token` (apps/web/.../connectApi.ts). Trusting custody would tell the
 *     operator to "paste a fresh token" for a source that has no token at all. The connector's
 *     declared `push`+`webhook` transport is code truth and wins. Home Assistant is `push`+`stream`
 *     and therefore does NOT take that branch — its reconnect really is a re-pasted long-lived token.
 *   - Plaid stores custody `byo_app`, the same value a BYO OAuth app stores, so the Plaid branch must
 *     be taken BEFORE the OAuth branch. It keys on `external_item_id` (the per-Item DB fact) with the
 *     provider as the pre-exchange fallback. This is not the forbidden provider→custody map: it names
 *     the reconnect MECHANISM (update-mode Link, which only Plaid has and which we already serve at
 *     POST /api/plaid/relink), decided from this user's own rows, on the server.
 *   - `first_party` and `byo_app` deliberately collapse to ONE answer: whichever the callback stamped,
 *     the operator reconnects by re-running consent. That is why the discriminant is served instead of
 *     raw custody — it is correct either way, and does not wait on the open "is `first_party` right
 *     for a BYO-app consent?" question (#89 item 1, still open).
 */
export function reconnectKindOf(input: {
  custody: string | null;
  provider: string;
  externalItemId: string | null;
  mode: "poll" | "push" | "on_demand" | null;
  pushKind: "stream" | "webhook" | null;
}): ReconnectKind {
  // 1. Device push: the declared transport, or a correctly-stamped on-device credential.
  if ((input.mode === "push" && input.pushKind === "webhook") || input.custody === "on_device") {
    return "device_push";
  }
  // 2. Plaid, BEFORE the OAuth branch (Plaid's stored custody is 'byo_app').
  if (input.externalItemId != null || input.provider === "plaid") return "plaid_update_link";
  // 3. Any OAuth consent, however its custody was stamped.
  if (input.custody === "first_party" || input.custody === "byo_app") return "reauth_oauth";
  // 4. A pasted secret.
  if (input.custody === "static_token") return "repaste_token";
  // 5. Unknown — say so rather than guess a flow.
  return "none";
}

export interface ConnectorStatus {
  connectionId: string;
  /** The owning provider_credentials id — keys the Revoke action (#8). */
  credentialId: string;
  provider: string;
  sector: string;
  status: "active" | "paused" | "error" | "revoked";
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  policy_mode: "poll" | "push" | "on_demand";
  /**
   * How a push connection transports (#41, additive): from the registered connector's declared
   * `SyncPolicy.pushKind` (duck-typed fallback for undeclared push connectors); null for
   * poll/on_demand or unregistered providers. The Console's caption vocabulary hangs off this —
   * `webhook` → "Device controlled", `stream` → never that caption.
   */
  push_kind: "stream" | "webhook" | null;
  next_sync_at: string | null;
  scopes: string[];
  credential: { status: string; expires_at: string | null };
  webhook_secret_set_at: string | null;
  /**
   * The per-connection recency window in days (wave 12a) — mail connectors only; null = all-history
   * (or non-mail). Surfaces the stored connectors.sync_window_days verbatim (the runner applies the
   * 180-day default at sync time when null; this exposes the raw setting the Console edits).
   */
  sync_window_days: number | null;
  /** The per-connection poll cadence override in SECONDS (ADR 0025), stored verbatim; null = the
   *  connector's default. next_sync_at/freshness always use the EFFECTIVE (floor-clamped) value. */
  sync_interval_sec: number | null;
  /** The connector-declared cadence floor (poll only; null otherwise) — the Console builds the
   *  picker from these two, never hardcoding per-provider numbers. */
  min_interval_sec: number | null;
  /** The EFFECTIVE default cadence — policy.defaultIntervalSec FLOOR-CLAMPED (what the scheduler
   *  actually runs with no override), so the Console's "Default (…)" label can never understate
   *  reality. null for non-poll connections. */
  default_interval_sec: number | null;
  /** Count of LIVE domain rows cached for this connection (deleted_at is null) — the progress signal. */
  cached_count: number;
  /** The one server-derived freshness tuple (ADR 0023) — the Console renders THIS, never re-derives. */
  freshness: Freshness;
  /**
   * How this connection is reconnected (#89 item 1) — ALWAYS served, on every row, healthy or not:
   * it is a property of the credential's custody, never of the connection's state, so a client picks
   * the button from this one field and the freshness tuple independently. `none` = we cannot name a
   * flow (never "nothing to do"). See reconnectKindOf for why custody alone is not enough.
   */
  reconnect_kind: ReconnectKind;
}

/** The connectors⋈credential row shape the enriched status is built from. */
interface StatusRow {
  id: string;
  credential_id: string;
  provider: string;
  sector: string;
  status: string;
  last_synced_at: unknown;
  last_error: string | null;
  last_error_at: unknown;
  scopes: unknown;
  webhook_secret_set_at: unknown;
  sync_window_days: number | null;
  sync_interval_sec: number | null;
  stream_state: string | null;
  stream_error: string | null;
  stream_changed_at: unknown;
  cred_status: string;
  cred_expires_at: unknown;
  /** provider_credentials.custody — the reconnect_kind input (#89 item 1); read-only here. */
  cred_custody: string | null;
  /** provider_credentials.external_item_id — the per-Item Plaid fact reconnect_kind keys on. */
  cred_external_item_id: string | null;
}

/** SELECT list shared by the list + detail reads (connectors joined to their credential). */
const STATUS_SELECT = `
  select c.id, c.credential_id, c.provider, c.sector, c.status, c.last_synced_at, c.last_error,
         c.last_error_at, c.scopes, c.webhook_secret_set_at, c.sync_window_days, c.sync_interval_sec,
         c.stream_state, c.stream_error, c.stream_changed_at,
         pc.status as cred_status, pc.expires_at as cred_expires_at,
         pc.custody as cred_custody, pc.external_item_id as cred_external_item_id
    from connectors c
    join provider_credentials pc on pc.id = c.credential_id`;

/**
 * Count LIVE domain rows (deleted_at is null) cached for one connection across its sector's tables.
 * A connection only holds rows in its OWN sector's tables; table names come from the frozen REGISTRY
 * (never raw input) and all values are parameterized. One query per sector table (single-operator
 * scale — every sector has 1–2 tables). The cached-count progress signal (wave 12a).
 */
async function cachedRowCount(userId: string, connectionId: string, sector: string): Promise<number> {
  let total = 0;
  for (const t of tablesForSector(sector)) {
    const cr = await pool.query(
      `select count(*)::int as n from "${t.table}" where connection_id = $1 and user_id = $2 and deleted_at is null`,
      [connectionId, userId],
    );
    total += cr.rows[0].n as number;
  }
  return total;
}

/** Map one row (+ its live cached-row count) to a ConnectorStatus, resolving policy_mode + next_sync_at. */
function toStatus(r: StatusRow, cachedCount: number): ConnectorStatus {
  const connector = getConnector(r.provider);
  const mode = connector?.policy.mode ?? "poll";
  // The ONE cadence derivation (ADR 0025): floor-clamped user override, else the connector default.
  // null for push/on_demand/unregistered — so the timer, next_sync_at, and staleness always agree.
  const intervalSec = effectiveIntervalSec(connector?.policy, r.sync_interval_sec);
  const lastSyncedAt = toIso(r.last_synced_at);
  // ONE resolved push kind, shared by the served `push_kind` field and reconnect_kind, so the two can
  // never disagree about the transport (the declared pushKind wins; pushKindOf duck-types an
  // undeclared push connector; null for poll/on_demand — the mode guard keeps a misdeclared non-push
  // pushKind from leaking through).
  const pushKind =
    connector?.policy.mode === "push" ? (connector.policy.pushKind ?? pushKindOf(connector)) : null;
  // next_sync_at is meaningful only for cadence (poll) connectors with a known interval + a prior sync.
  const nextSyncAt =
    mode === "poll" && intervalSec != null && lastSyncedAt != null
      ? new Date(new Date(lastSyncedAt).getTime() + intervalSec * 1000).toISOString()
      : null;
  return {
    connectionId: r.id,
    credentialId: r.credential_id,
    provider: r.provider,
    sector: r.sector,
    status: r.status as ConnectorStatus["status"],
    last_synced_at: lastSyncedAt,
    last_error: r.last_error ?? null,
    last_error_at: toIso(r.last_error_at),
    policy_mode: mode,
    // #41: resolved once above and shared with reconnect_kind.
    push_kind: pushKind,
    next_sync_at: nextSyncAt,
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
    credential: { status: r.cred_status, expires_at: toIso(r.cred_expires_at) },
    webhook_secret_set_at: toIso(r.webhook_secret_set_at),
    sync_window_days: r.sync_window_days ?? null,
    sync_interval_sec: r.sync_interval_sec ?? null,
    min_interval_sec: intervalFloorSec(connector?.policy),
    // The effective default = clamp(defaultIntervalSec, floor) — exactly effectiveIntervalSec with
    // no stored override, so the served label and the no-override scheduler can never disagree.
    default_interval_sec: effectiveIntervalSec(connector?.policy, null),
    cached_count: cachedCount,
    freshness: deriveFreshness({
      status: r.status,
      mode: connector?.policy.mode ?? null,
      pushKind: pushKindOf(connector),
      lastSyncedAt: lastSyncedAt,
      nextSyncAt,
      intervalSec: intervalSec ?? null,
      cachedCount,
      streamState: r.stream_state ?? null,
      streamError: r.stream_error ?? null,
      streamChangedAt: (r.stream_changed_at ?? null) as Date | string | null,
      lastError: r.last_error ?? null,
      lastErrorAt: (r.last_error_at ?? null) as Date | string | null,
    }),
    // #89 item 1 — the stored custody + the DECLARED transport, never a provider→custody map.
    reconnect_kind: reconnectKindOf({
      custody: r.cred_custody ?? null,
      provider: r.provider,
      externalItemId: r.cred_external_item_id ?? null,
      mode: connector ? mode : null,
      pushKind,
    }),
  };
}

/** Every connector for the operator, with freshness, error reason, scopes, policy + credential status. */
export async function listConnectorsEnriched(ctx: AuthContext): Promise<ConnectorStatus[]> {
  const res = await pool.query(`${STATUS_SELECT} where c.user_id = $1 order by c.created_at desc`, [
    ctx.userId,
  ]);
  // Per-connector live cached-row count (the progress signal). One count query per connector's
  // sector table(s) — single-operator scale; fine. Serialized to keep the pool calm.
  const out: ConnectorStatus[] = [];
  for (const raw of res.rows) {
    const r = raw as StatusRow;
    const count = await cachedRowCount(ctx.userId, r.id, r.sector);
    out.push(toStatus(r, count));
  }
  return out;
}

/** One connection's enriched status PLUS per-domain-table live-row counts (the detail-only count). */
export async function getConnectionDetail(
  ctx: AuthContext,
  connectionId: string,
): Promise<ConnectorStatus & { counts: Record<string, number> }> {
  if (!UUID_RE.test(connectionId)) throw new NotFoundError(`no connection with id '${connectionId}'`);
  const res = await pool.query(`${STATUS_SELECT} where c.id = $1 and c.user_id = $2`, [
    connectionId,
    ctx.userId,
  ]);
  const row = res.rows[0] as StatusRow | undefined;
  if (!row) throw new NotFoundError(`no connection with id '${connectionId}'`);

  // A connection only ever holds rows in its OWN sector's tables; count live rows there (tombstones
  // excluded). Table names come from the frozen REGISTRY (never raw input); values are parameterized.
  const counts: Record<string, number> = {};
  let cachedCount = 0;
  for (const t of tablesForSector(row.sector)) {
    const cr = await pool.query(
      `select count(*)::int as n from "${t.table}" where connection_id = $1 and user_id = $2 and deleted_at is null`,
      [connectionId, ctx.userId],
    );
    counts[t.key] = cr.rows[0].n as number;
    cachedCount += cr.rows[0].n as number;
  }
  const status = toStatus(row, cachedCount);
  return { ...status, counts };
}

// ── Lifecycle verbs ─────────────────────────────────────────────────────────────

/**
 * Pause a connection (active|error → paused), so the scheduler/push re-scan (both select
 * status in ('active','error')) drops it within ~60s. Push connectors also get a best-effort
 * stop() to close the live socket. Already-paused → 200 no-op; revoked → 409; unknown → 404.
 */
export async function pauseConnection(
  ctx: AuthContext,
  connectionId: string,
): Promise<{ connectionId: string; status: "paused" }> {
  if (!UUID_RE.test(connectionId)) throw new NotFoundError(`no connection with id '${connectionId}'`);
  const res = await pool.query(
    `update connectors set status = 'paused'
       where id = $1 and user_id = $2 and status in ('active', 'error')
       returning provider`,
    [connectionId, ctx.userId],
  );
  if (!res.rows[0]) {
    // No flip — either the connector doesn't exist (for this user), is already paused, or revoked.
    const existing = await pool.query(
      `select status from connectors where id = $1 and user_id = $2`,
      [connectionId, ctx.userId],
    );
    const row = existing.rows[0];
    if (!row) throw new NotFoundError(`no connection with id '${connectionId}'`);
    if (row.status === "paused") return { connectionId, status: "paused" }; // idempotent no-op
    throw new ConflictError(`cannot pause a ${row.status} connection`);
  }
  bestEffortStop(res.rows[0].provider as string, connectionId);
  auditAdmin(ctx.userId, "pause", { connectionId }, "ok");
  return { connectionId, status: "paused" };
}

/**
 * Resume a connection — ONLY from paused (a revoked connection requires re-onboarding). The re-scan
 * picks it up within ~60s (poll + push); no proactive start. Not-paused → 409; unknown → 404.
 */
export async function resumeConnection(
  ctx: AuthContext,
  connectionId: string,
): Promise<{ connectionId: string; status: "active" }> {
  if (!UUID_RE.test(connectionId)) throw new NotFoundError(`no connection with id '${connectionId}'`);
  const res = await pool.query(
    `update connectors set status = 'active'
       where id = $1 and user_id = $2 and status = 'paused'
       returning id`,
    [connectionId, ctx.userId],
  );
  if (!res.rows[0]) {
    const existing = await pool.query(
      `select status from connectors where id = $1 and user_id = $2`,
      [connectionId, ctx.userId],
    );
    const row = existing.rows[0];
    if (!row) throw new NotFoundError(`no connection with id '${connectionId}'`);
    throw new ConflictError(`cannot resume a ${row.status} connection (resume only from paused)`);
  }
  auditAdmin(ctx.userId, "resume", { connectionId }, "ok");
  return { connectionId, status: "active" };
}

/**
 * Revoke a credential — kill the account link. In one transaction: flip the credential AND all its
 * connectors to 'revoked' and null the credential's vault refs (so the secrets can be deleted without
 * violating the FK); after commit, best-effort stop() each push connector and deleteSecret each ref.
 * KEEPS the cached domain rows (read-only orphaned cache) and the credential row itself (deleting it
 * would FK-cascade connectors → domain rows). Unknown/foreign id → 404.
 */
export async function revokeCredential(
  ctx: AuthContext,
  credentialId: string,
): Promise<{ credentialId: string; provider: string; revokedConnectors: string[]; secretsDeleted: number }> {
  if (!UUID_RE.test(credentialId)) throw new NotFoundError(`no credential with id '${credentialId}'`);

  const client = await pool.connect();
  let provider: string;
  let refs: string[];
  let revokedRows: Array<{ id: string; provider: string }>;
  try {
    await client.query("begin");
    const credRes = await client.query(
      `select provider, secret_ref, refresh_ref, client_app_ref
         from provider_credentials where id = $1 and user_id = $2 for update`,
      [credentialId, ctx.userId],
    );
    const cred = credRes.rows[0];
    if (!cred) {
      await client.query("rollback");
      throw new NotFoundError(`no credential with id '${credentialId}'`);
    }
    provider = cred.provider as string;
    // Distinct, non-null refs — the secrets this credential owns (access / refresh / byo client app).
    refs = [
      ...new Set(
        [cred.secret_ref, cred.refresh_ref, cred.client_app_ref].filter(
          (r): r is string => typeof r === "string" && r.length > 0,
        ),
      ),
    ];
    // Revoke the credential + null its refs (so deleteSecret won't trip the secrets FK), keep the row.
    await client.query(
      `update provider_credentials
         set status = 'revoked', secret_ref = null, refresh_ref = null, client_app_ref = null
       where id = $1 and user_id = $2`,
      [credentialId, ctx.userId],
    );
    // Revoke every connector on this credential; capture ids/providers for the response + stop().
    const connRes = await client.query(
      `update connectors set status = 'revoked' where credential_id = $1 and user_id = $2
         returning id, provider`,
      [credentialId, ctx.userId],
    );
    revokedRows = connRes.rows.map((r) => ({ id: r.id as string, provider: r.provider as string }));
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Post-commit side-effects: close live sockets, delete the vault secret(s). Both best-effort —
  // deleteSecret is idempotent and the credential no longer references the secrets after commit.
  for (const c of revokedRows) bestEffortStop(c.provider, c.id);
  let secretsDeleted = 0;
  for (const ref of refs) {
    try {
      await deleteSecret(ref);
      secretsDeleted++;
    } catch {
      // best-effort: the credential is already revoked + its refs nulled (the token is functionally
      // dead), so a failed delete only leaves an orphaned, now-unreferenced encrypted blob — never
      // block the revoke response or skip the audit line over it (the blob still needs the master key).
    }
  }

  // Cross-provider finance dedup (#34b): a revoked finance credential removes a provider from the
  // overlap, so re-reconcile — a group that fell below 2 providers DROPS its synthetic and the sole
  // survivor un-shadows immediately. Best-effort: never fail the revoke over a reconcile hiccup.
  if (provider === "plaid" || provider === "simplefin") {
    try {
      await reconcileFinance(ctx.userId);
    } catch {
      // best-effort — the survivor still auto-un-shadows via the shadowed_by_id FK on the next sync.
    }
  }

  auditAdmin(ctx.userId, "revoke", { credentialId }, "ok");
  return { credentialId, provider, revokedConnectors: revokedRows.map((r) => r.id), secretsDeleted };
}

export interface SyncNowResult {
  connectionId: string;
  provider: string;
  mode: "poll" | "on_demand" | "push";
  ran: boolean;
  ok?: boolean;
  upserted?: number;
  deleted?: number;
  timed_out?: boolean;
  error?: string;
  note?: string;
  /** Push-stream transport truth (#39): connected | retrying | down (absent for non-stream connections). */
  stream_state?: string;
  /** When the stream entered its current state (stream_changed_at). */
  stream_since?: string | null;
}

/**
 * Operator sync-now for ONE connection. poll/on_demand → run syncConnection with a 30s bounded WAIT
 * (the syncs continue in the background past the bound, like fetch_live) and return its result.
 * push → no manual pull, but the answer is HONEST (#39): a live stream (or a webhook connection)
 * reports ok:true with the stream fields; a retrying/down stream reports ok:false + the masked
 * stream_error — no active probe (the retry loop already probes every ≤60s; the row IS the freshest
 * truth). revoked → 409; unknown → 404.
 */
export async function syncNowConnection(ctx: AuthContext, connectionId: string): Promise<SyncNowResult> {
  if (!UUID_RE.test(connectionId)) throw new NotFoundError(`no connection with id '${connectionId}'`);
  const res = await pool.query(
    `select provider, status, stream_state, stream_error, stream_changed_at
       from connectors where id = $1 and user_id = $2`,
    [connectionId, ctx.userId],
  );
  const row = res.rows[0];
  if (!row) throw new NotFoundError(`no connection with id '${connectionId}'`);
  const provider = row.provider as string;
  if (row.status === "revoked") throw new ConflictError("cannot sync a revoked connection");

  const connector = getConnector(provider);
  const mode = connector?.policy.mode ?? "poll";

  if (mode === "push") {
    const streamState = (row.stream_state ?? null) as string | null;
    const streamSince = toIso(row.stream_changed_at);
    if (streamState === "retrying" || streamState === "down") {
      auditAdmin(ctx.userId, "sync_now", { connectionId }, "error");
      return {
        connectionId,
        provider,
        mode,
        ran: false,
        ok: false,
        error: row.stream_error ? maskError(row.stream_error as string) : `push stream ${streamState}`,
        stream_state: streamState,
        stream_since: streamSince,
        note: "push stream down — reconnect the source",
      };
    }
    auditAdmin(ctx.userId, "sync_now", { connectionId }, "ok");
    return {
      connectionId,
      provider,
      mode,
      ran: false,
      ok: true,
      ...(streamState != null ? { stream_state: streamState, stream_since: streamSince } : {}),
      note: "event-driven connector; no manual pull",
    };
  }

  // poll / on_demand: a bounded wait on syncConnection (which never throws — returns a SyncResult).
  let timer: NodeJS.Timeout | undefined;
  const running = syncConnection(connectionId);
  const wait = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SYNC_NOW_WAIT_MS);
  });
  const raced = await Promise.race([running, wait]);
  if (timer) clearTimeout(timer);

  if (raced === "timeout") {
    void running.catch(() => {}); // background sync continues; never an unhandled rejection
    auditAdmin(ctx.userId, "sync_now", { connectionId }, "error");
    return { connectionId, provider, mode, ran: true, timed_out: true, note: "sync still running" };
  }

  const result = raced as SyncResult;
  auditAdmin(ctx.userId, "sync_now", { connectionId }, result.ok ? "ok" : "error");
  return {
    connectionId,
    provider,
    mode,
    ran: true,
    ok: result.ok,
    upserted: result.upserted,
    deleted: result.deleted,
    ...(result.ok ? {} : { error: result.error ? maskError(result.error) : result.error }),
  };
}

export interface DisconnectResult {
  connectionId: string;
  /** Per backing-table deleted row counts (non-zero only, like erase). */
  deleted: Record<string, number>;
  /** True ONLY when this was the credential's LAST connector (credential + vault secret removed). */
  credentialRemoved: boolean;
}

/**
 * Disconnect a connection — the clean-slate, connectionId-scoped HARD remove (#18). NOT a tombstone:
 * an intentional operator delete, like erase (ADR 0012). Order:
 *   1. uuid-shape + ownership: the connector must be THIS user's, else NotFoundError (404) — no
 *      cross-user reach, no existence oracle (mirrors erase.ts).
 *   2. confirm token: a fat-finger guard (must echo the connectionId — the SAME convention erase uses
 *      for scope 'connection'), NOT auth — a mismatch is a QueryValidationError (400) BEFORE any read
 *      or delete. Reaching this loopback path already implies operator trust.
 *   3. best-effort stop() the live connector (close a push socket so it doesn't linger).
 *   4. delete every domain row for the connection (per frozen REGISTRY table; counted, like erase).
 *   5. delete the connectors row.
 *   6. if this was the credential's LAST connector, delete the provider_credentials row AND its vault
 *      secret(s) — best-effort + guarded, so vault bookkeeping can never throw past the delete.
 * Returns the per-table delete counts + whether the shared credential was removed. One async audit.
 */
export async function disconnectConnection(
  ctx: AuthContext,
  connectionId: string,
  opts: { confirmToken?: string } = {},
): Promise<DisconnectResult> {
  if (!UUID_RE.test(connectionId)) throw new NotFoundError(`no connection with id '${connectionId}'`);

  // Fat-finger guard FIRST (before any read/delete): the operator must echo the connectionId. This is
  // the SAME confirm convention erase uses for scope 'connection' (mint + echo); it is NOT authz —
  // loopback is the only authz. A bad/absent token is a 400 with ZERO rows touched.
  if (opts.confirmToken !== connectionId) {
    throw new QueryValidationError("confirmation token does not match the connection");
  }

  // Ownership — the connection must belong to ctx.userId, else 404 (no cross-user delete / no oracle).
  const owns = await pool.query(
    `select credential_id, provider, sector from connectors where id = $1 and user_id = $2`,
    [connectionId, ctx.userId],
  );
  const row = owns.rows[0];
  if (!row) throw new NotFoundError(`no connection with id '${connectionId}'`);
  const credentialId = row.credential_id as string;
  const provider = row.provider as string;
  const sector = row.sector as string;

  // Close a live push socket (e.g. HA WS) so it doesn't linger past the row's deletion. Never throws.
  bestEffortStop(provider, connectionId);

  // Plaid OUT-bound /item/remove BEFORE dropping rows (wave 13): invalidate the token + STOP the paid
  // Production monthly Transactions subscription — deleting local rows alone leaves a billable zombie
  // Item. Best-effort (returns false on failure); the disconnect proceeds regardless. NOT an agent action.
  if (provider === "plaid") {
    const credForRemove = await pool.query(
      `select secret_ref from provider_credentials where id = $1 and user_id = $2`,
      [credentialId, ctx.userId],
    );
    await removePlaidItem((credForRemove.rows[0]?.secret_ref ?? null) as string | null, ctx.userId);
  }

  // Delete every domain row for THIS connection (live + tombstoned), counted per backing table. Only
  // frozen REGISTRY table names ever reach SQL; all values are parameterized. The connectors → domain
  // FK is ON DELETE CASCADE, but we delete explicitly first for an accurate count.
  const deleted: Record<string, number> = {};
  for (const t of allDomainTables()) {
    const res = await pool.query(`delete from "${t.table}" where connection_id = $1 and user_id = $2`, [
      connectionId,
      ctx.userId,
    ]);
    const n = res.rowCount ?? 0;
    if (n > 0) deleted[t.table] = n;
  }

  // Delete the connector row itself (user-scoped).
  await pool.query(`delete from connectors where id = $1 and user_id = $2`, [connectionId, ctx.userId]);

  // Shared-credential rule: remove the credential (+ its vault secret(s)) ONLY when this was its last
  // connector. The count is taken AFTER the connector delete, so a concurrent sibling-disconnect is
  // observed; a credential is removed only when ZERO connectors remain → a LIVE sibling can never be
  // FK-cascaded away (deleting the credential cascades connectors, but there are none left to cascade).
  let credentialRemoved = false;
  const siblings = await pool.query(
    `select count(*)::int as n from connectors where credential_id = $1 and id <> $2`,
    [credentialId, connectionId],
  );
  if ((siblings.rows[0]?.n ?? 0) === 0) {
    // Read the refs BEFORE deleting the credential row; delete the row (which drops the secrets FK
    // reference) and only THEN deleteSecret each ref — so a failed vault delete leaves at most an
    // orphaned, now-unreferenced encrypted blob, never a half-deleted credential or a leaked secret.
    const credRes = await pool.query(
      `select secret_ref, refresh_ref, client_app_ref from provider_credentials where id = $1 and user_id = $2`,
      [credentialId, ctx.userId],
    );
    const cred = credRes.rows[0];
    await pool.query(`delete from provider_credentials where id = $1 and user_id = $2`, [
      credentialId,
      ctx.userId,
    ]);
    credentialRemoved = true;
    if (cred) {
      const refs = [
        ...new Set(
          [cred.secret_ref, cred.refresh_ref, cred.client_app_ref].filter(
            (r): r is string => typeof r === "string" && r.length > 0,
          ),
        ),
      ];
      for (const ref of refs) {
        try {
          await deleteSecret(ref);
        } catch {
          // best-effort: the credential row is already gone, so a failed delete only leaves an
          // orphaned, unreferenced encrypted blob (still useless without the master key) — never
          // block the disconnect or leave a half state over vault bookkeeping.
        }
      }
    }
  }

  // Cross-provider finance dedup (#34b): this connection's rows were just HARD-removed, so re-reconcile
  // — a dedup group that fell below 2 providers DROPS its synthetic and the sole survivor un-shadows and
  // serves IMMEDIATELY (no waiting for a sync), a still-2+ group RECOMPUTES. Best-effort (the survivor
  // also auto-un-shadows via the shadowed_by_id FK if the dropped synthetic lived on this connection).
  if (sector === "finance") {
    try {
      await reconcileFinance(ctx.userId);
    } catch {
      // best-effort — never fail the disconnect over a reconcile hiccup.
    }
  }

  auditAdmin(ctx.userId, "disconnect", { connectionId, sector }, "ok");
  return { connectionId, deleted, credentialRemoved };
}

// ── Sync window (wave 12a) ───────────────────────────────────────────────────────

/** Inclusive bounds on a recency window in days: a week … ~100 years ("All history" = a large value). */
export const MIN_SYNC_WINDOW_DAYS = 7;
export const MAX_SYNC_WINDOW_DAYS = 36500;

/**
 * Set a connection's recency window (wave 12a) — `days` is an integer in [7, 36500], or null to
 * clear the override. Persists connectors.sync_window_days (the runner reads it at the next sync and
 * threads it into SyncContext.windowDays; a mail connection with null falls back to the 180-day code
 * default — all-history is an explicit large `days`, e.g. 36500, never null; non-mail ignores it).
 * Non-destructive (shrink keeps already-cached older rows; grow widens the next delta). User-scoped:
 * an unknown/foreign id → NotFoundError (404); a bad value → QueryValidationError (400) BEFORE any write.
 *
 * A window change ALSO clears the delta cursor (`cursor = null`): the stored Graph deltaLink encodes the
 * OLD narrow filter, so without this reset GROWING the window would be a silent no-op (the next delta
 * keeps the old narrow range). Clearing the cursor makes the next sync issue a FRESH windowed delta with
 * the new filter — grow backfills the wider range, shrink re-pulls the narrower range — both reconcile via
 * the idempotent upsert. The cursor reset deletes NO domain rows, so shrink KEEPS already-cached older rows.
 */
export async function setSyncWindow(
  ctx: AuthContext,
  connectionId: string,
  days: number | null,
): Promise<{ connectionId: string; sync_window_days: number | null }> {
  if (!UUID_RE.test(connectionId)) throw new NotFoundError(`no connection with id '${connectionId}'`);
  if (days !== null) {
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < MIN_SYNC_WINDOW_DAYS ||
      days > MAX_SYNC_WINDOW_DAYS
    ) {
      throw new QueryValidationError(
        `days must be an integer between ${MIN_SYNC_WINDOW_DAYS} and ${MAX_SYNC_WINDOW_DAYS}, or null`,
      );
    }
  }
  const res = await pool.query(
    `update connectors set sync_window_days = $3, cursor = null where id = $1 and user_id = $2 returning id`,
    [connectionId, ctx.userId, days],
  );
  if (!res.rows[0]) throw new NotFoundError(`no connection with id '${connectionId}'`);
  return { connectionId, sync_window_days: days };
}

// ── Sync cadence (ADR 0025) ─────────────────────────────────────────────────────

/** Anti-typo upper bound on a cadence override: long cadences are legitimate (the freshness grammar
 *  recalibrates), but nothing sane exceeds 14 days. Also hard-required, not just hygiene: Node's
 *  setTimeout/setInterval overflow past 2^31−1 ms (~24.8 days) and fire every ~1ms, so the API bound
 *  must sit comfortably below that ceiling (the scheduler carries its own belt-clamp for
 *  hand-edited rows). */
export const MAX_SYNC_INTERVAL_SEC = 14 * 24 * 3600;

/**
 * Set a connection's poll cadence override (ADR 0025) — `intervalSec` is an integer in
 * [connector floor, 14 days], or null to reset to the connector's default. POLL connections only
 * (push/webhook/on_demand cadence is not ours to control → ConflictError, 409). Below-floor
 * explicit input is REJECTED with a typed 400 naming the field and the floor — never silently
 * clamped (#1/#2 discipline); the scheduler's read-time clamp guards hand-edited rows separately.
 * The scheduler's ~60s re-scan picks the change up without a restart (reschedule-on-drift);
 * next_sync_at + freshness recalibrate immediately via the shared effectiveIntervalSec. Audited.
 */
export async function setSyncInterval(
  ctx: AuthContext,
  connectionId: string,
  intervalSec: number | null,
): Promise<void> {
  if (!UUID_RE.test(connectionId)) throw new NotFoundError(`no connection with id '${connectionId}'`);
  const res = await pool.query(`select provider from connectors where id = $1 and user_id = $2`, [
    connectionId,
    ctx.userId,
  ]);
  const row = res.rows[0];
  if (!row) throw new NotFoundError(`no connection with id '${connectionId}'`);

  const connector = getConnector(row.provider as string);
  if (connector?.policy.mode !== "poll") {
    throw new ConflictError("cadence applies only to poll connections");
  }

  if (intervalSec !== null) {
    const floor = intervalFloorSec(connector.policy) ?? 1;
    if (typeof intervalSec !== "number" || !Number.isInteger(intervalSec) || intervalSec < floor) {
      throw new QueryValidationError(
        `interval_sec must be an integer ≥ ${floor} (the ${row.provider} floor), or null to reset to the default`,
      );
    }
    if (intervalSec > MAX_SYNC_INTERVAL_SEC) {
      throw new QueryValidationError(
        `interval_sec must be ≤ ${MAX_SYNC_INTERVAL_SEC} (14 days), or null to reset to the default`,
      );
    }
  }

  await pool.query(`update connectors set sync_interval_sec = $3 where id = $1 and user_id = $2`, [
    connectionId,
    ctx.userId,
    intervalSec,
  ]);
  auditAdmin(ctx.userId, "set_sync_interval", { connectionId, intervalSec }, "ok");
}
