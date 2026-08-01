import { pool } from "../db.js";
import { REGISTRY, UUID_RE, tablesForSector } from "./schema.js";
import { QueryValidationError, unknownSectorError } from "./query.js";
import { deriveFreshness, pushKindOf, type Freshness } from "./freshness.js";
import { assertSector, ALL_SECTORS, type AuthContext } from "../auth/index.js";
import { getConnector, syncConnection, maskError, effectiveIntervalSec } from "../sync/index.js";
import { resolveAccessToken } from "../oauth/refresh.js";
import { timed } from "../obs/duration.js";

/** Normalize a pg timestamp (Date | string | null) to an ISO string or null. */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** The connectors columns every freshness derivation reads (describe_context + fetch_live). */
const FRESHNESS_COLS = `c.id, c.provider, c.sector, c.status, c.last_synced_at, c.last_error,
       c.last_error_at, c.sync_interval_sec, c.stream_state, c.stream_error, c.stream_changed_at`;

interface FreshnessRow {
  id: string;
  provider: string;
  sector: string;
  status: string;
  last_synced_at: unknown;
  last_error: string | null;
  last_error_at: unknown;
  sync_interval_sec: number | null;
  stream_state: string | null;
  stream_error: string | null;
  stream_changed_at: unknown;
}

/**
 * Derive one connection's freshness tuple from its row + its registered connector's policy. The
 * cached-row count is loaded ONLY when last_synced_at is null (the sole branch that reads it —
 * syncing-vs-never_synced), so the common path adds zero count queries.
 */
async function freshnessForRow(userId: string, row: FreshnessRow): Promise<Freshness> {
  const connector = getConnector(row.provider);
  const mode = connector?.policy.mode ?? null;
  const intervalSec = effectiveIntervalSec(connector?.policy, row.sync_interval_sec);
  const lastSyncedAt = toIso(row.last_synced_at);
  const nextSyncAt =
    mode === "poll" && intervalSec != null && lastSyncedAt != null
      ? new Date(new Date(lastSyncedAt).getTime() + intervalSec * 1000).toISOString()
      : null;
  let cachedCount: number | null = null;
  if (lastSyncedAt == null) {
    cachedCount = 0;
    for (const t of tablesForSector(row.sector)) {
      const cr = await pool.query(
        `select count(*)::int as n from "${t.table}" where connection_id = $1 and user_id = $2 and deleted_at is null`,
        [row.id, userId],
      );
      cachedCount += cr.rows[0].n as number;
    }
  }
  return deriveFreshness({
    status: row.status,
    mode,
    pushKind: pushKindOf(connector),
    lastSyncedAt,
    nextSyncAt,
    intervalSec,
    cachedCount,
    streamState: row.stream_state ?? null,
    streamError: row.stream_error ?? null,
    streamChangedAt: (row.stream_changed_at ?? null) as Date | string | null,
    lastError: row.last_error ?? null,
    lastErrorAt: (row.last_error_at ?? null) as Date | string | null,
  });
}

/**
 * One connection as describe_context serves it. Declared as a TYPE ALIAS, not an interface, on
 * purpose: existing callers assert the array to `Array<Record<string, unknown>>`, and only an object
 * type alias carries the implicit index signature that assertion needs.
 */
export type DescribeContextConnection = {
  /** connectors.id — the id every other surface keys on (fetch_live connections[], the Console). */
  connection_id: string;
  provider: string;
  sector: string;
  status: string;
  /**
   * Best-effort human name for THIS connection ("Chase", the account email) so an agent can say
   * WHICH source it means. Derived at read time from the user's own cached rows and returned in the
   * response — never written to any table (the no-derived-data invariant holds). null when unknown.
   */
  label: string | null;
  last_synced_at: unknown;
  mode: "poll" | "push" | "on_demand" | null;
  health: { status: string; consentExpiresAt: string | null } | null;
  freshness: Freshness;
};

/**
 * Best-effort connection labels, in a SEPARATE query on purpose. The connectors SELECT below is
 * wrapped in a catch that degrades to an empty list; folding finance_accounts into it would let one
 * bad table blank every connection — re-creating the #39 vanishing-connections lie. On failure here
 * every label is simply null and the list still serves. min() makes the pick deterministic.
 */
async function institutionLabels(userId: string, connectionIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (connectionIds.length === 0) return out;
  try {
    const r = await pool.query(
      `select connection_id, min(institution_name) as institution_name
         from finance_accounts
        where user_id = $1 and connection_id = any($2)
          and institution_name is not null and deleted_at is null
        group by connection_id`,
      [userId, connectionIds],
    );
    for (const row of r.rows) {
      const name = row.institution_name as string | null;
      if (name) out.set(row.connection_id as string, name);
    }
  } catch {
    // Labels are decoration; the connection list is the product. Never let one table blank it.
  }
  return out;
}

/**
 * What this caller can see: the sectors it's granted, and only its own user's connectors in those
 * sectors. An agent never sees another user's connections, nor sectors it wasn't granted. Non-active
 * connections (error/syncing/paused) ARE listed — cached reads still serve for them, and hiding a
 * broken connection was the #39 lie (grammar ban #4); only revoked stays out (its cache is orphaned
 * history, not a live source).
 *
 * `sectors` is the GRANTED list, NOT the connected list — a granted sector can have no connection at
 * all. The name is load-bearing for apps/web and every REST client; the tool description is what
 * teaches an agent to read `connections` alongside it.
 */
export async function describeContext(
  ctx: AuthContext,
): Promise<{ sectors: string[]; connections: DescribeContextConnection[] }> {
  const sectors = ALL_SECTORS.filter((s) => ctx.grantedSectors.has(s));
  const connections: DescribeContextConnection[] = [];
  if (sectors.length > 0) {
    let rows: Array<
      FreshnessRow & { item_status: string | null; consent_expiration_time: unknown; username: string | null }
    > = [];
    try {
      // Join the credential so a Plaid connection can carry its connection HEALTH (sub-unit B): a
      // broken Item makes /transactions/sync go quiet (empty arrays — last_synced_at keeps advancing
      // and lies), so the agent needs item_status/consent to tell "action needed" from "no new data".
      const r = await pool.query(
        `select ${FRESHNESS_COLS},
                pc.item_status, pc.consent_expiration_time, pc.username
           from connectors c
           join provider_credentials pc on pc.id = c.credential_id
          where c.user_id = $1 and c.status in ('active', 'error', 'syncing', 'paused')
            and c.sector = any($2)`,
        [ctx.userId, sectors],
      );
      rows = r.rows as typeof rows;
    } catch {
      // Scoped to the connectors SELECT ONLY (#41 item 4): the table may not exist yet in a fresh
      // checkout → empty list. Per-row derivation failures are handled below — one bad row must
      // degrade, never blank the whole list (the vanishing-connections lie stays dead).
    }
    // ONE extra query per describe_context call (not per connection), and only when a finance
    // connection is actually present. Everything else falls back to the credential username.
    const financeIds = rows.filter((r) => r.sector === "finance").map((r) => r.id);
    const labels = await institutionLabels(ctx.userId, financeIds);
    /** Deterministic fallback chain: cached institution name → credential username → null. */
    const labelFor = (row: { id: string; username: string | null }): string | null =>
      labels.get(row.id) ?? (row.username || null);
    // Annotate each connection with its connector's declared sync mode (push|poll|on_demand) AND
    // the ONE server-derived freshness tuple (ADR 0023) so the agent self-serves the freshness
    // call from the server's word, never from raw timestamps. A provider with no registered
    // connector → mode null (defensive — e.g. a reserved provider not yet wired). `health` is
    // surfaced only for Plaid (the provider with a pollable Item state); others carry health: null.
    for (const row of rows) {
      const provider = row.provider;
      try {
        const health =
          provider === "plaid"
            ? {
                status: row.item_status ?? "ok",
                consentExpiresAt: toIso(row.consent_expiration_time),
              }
            : null;
        connections.push({
          connection_id: row.id,
          provider,
          sector: row.sector,
          status: row.status,
          label: labelFor(row),
          last_synced_at: row.last_synced_at,
          mode: getConnector(provider)?.policy.mode ?? null,
          health,
          freshness: await freshnessForRow(ctx.userId, row),
        });
      } catch {
        // #41 item 4: a throwing per-row derivation (a broken connector policy, a bad count table)
        // LISTS the row degraded — {state:'error'}-shaped freshness, null mode/health/counts —
        // never vanished. The raw row facts (provider/sector/status/last_synced_at) still serve.
        const degraded: Freshness = {
          state: "error",
          last_heard_at: toIso(row.last_synced_at),
          next_expected_at: null,
          stream_state: null,
          error: { message: "freshness derivation failed", since: null },
        };
        // connection_id and label are carried on the DEGRADED row too: this is exactly when an
        // operator needs to identify WHICH connection to go fix.
        connections.push({
          connection_id: row.id,
          provider,
          sector: row.sector,
          status: row.status,
          label: labelFor(row),
          last_synced_at: row.last_synced_at,
          mode: null,
          health: null,
          freshness: degraded,
        });
      }
    }
  }
  return { sectors, connections };
}

/**
 * Fetch one record by id. Denies an ungranted sector BEFORE any SQL, then scopes to ctx.userId — a
 * different user's UUID returns null, not the row (this closes the "getRecord returns any row" hole).
 */
export async function getRecord(
  ctx: AuthContext,
  sector: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  assertSector(ctx, sector); // FIRST statement — never reorder behind the guards below
  if (!Object.hasOwn(REGISTRY, sector)) {
    // Was a bare Error → 500 at both edges, even for `get_record("finance", …)` right after
    // describe_context advertised `finance`. A QueryValidationError maps to 400 and names the keys.
    throw unknownSectorError(sector, "get_record");
  }
  const schema = REGISTRY[sector];
  // A malformed id is ABSENT, not an error: `null` is already this function's absent contract
  // (data-routes maps it to 404, the bearer mirror returns {record: null}). Throwing here would
  // change existing REST status codes. Checked BEFORE timed()/any SQL so pg never sees a 22P02.
  if (!UUID_RE.test(id)) return null;
  return timed("getRecord", { sector, mode: "record" }, async () => {
    const res = await pool.query(
      `select * from "${schema.table}" where id = $1 and user_id = $2`,
      [id, ctx.userId],
    );
    return res.rows[0] ?? null;
  });
}

/** Resource absent: no active connection in the sector, or no row with that id. (REST: 404.) */
export class NotFoundError extends Error {
  override name = "NotFoundError";
}
/** The source/connector could not serve a live request (e.g. HA WS not connected). (REST: 502.) */
export class FetchLiveUnavailableError extends Error {
  override name = "FetchLiveUnavailableError";
}

/** One connection's post-sync transport truth in a fetch_live sync answer (#39, ADR 0023). */
export interface FetchLiveConnection {
  connection_id: string;
  provider: string;
  mode: "poll" | "push" | "on_demand" | null;
  freshness: Freshness;
}

export type FetchLiveResult =
  | {
      sector: string;
      mode: "sync";
      synced: boolean;
      timed_out: boolean;
      last_synced_at: string | null;
      /** Per-connection failures, attributed + secret-free (sync errors AND dead push streams). */
      errors?: string[];
      /** Every active connection's POST-sync freshness — re-read after the bounded wait. */
      connections: FetchLiveConnection[];
    }
  | { sector: string; mode: "record"; id: string; record: unknown }; // raw payload; null = source says gone

/** The bounded WAIT on a sync-now — never a cancelled sync (the syncs continue in the background). */
const FETCH_LIVE_WAIT_MS = 30_000;

/**
 * The seventh primitive — the ONE read-time upstream path (opt-in, bounded). Two modes:
 *   - no `id`: sync-now across ALL the sector's active connections (push-mode ones have no pull to
 *     run, but their STREAM truth is reported — a dead stream forces synced:false, #39), waiting at
 *     most FETCH_LIVE_WAIT_MS for the syncs to land.
 *   - `id`: fetch THAT record live from the ROW's own connection via the connector's optional
 *     fetchRecordLive hook. `record: null` means the source says the object is gone.
 * Grant-checked FIRST (fail-closed); every failure is a typed error, never a bare Error.
 */
export async function fetchLive(
  ctx: AuthContext,
  sector: string,
  opts?: { id?: string },
): Promise<FetchLiveResult> {
  assertSector(ctx, sector); // denies an ungranted sector BEFORE any SQL (dotted keys reduce, fail-closed)
  const mode = opts?.id != null ? "record" : "sync";
  return timed("fetchLive", { sector, mode }, async () => {
    if (opts?.id != null) return fetchLiveRecord(ctx, sector, opts.id);
    // Sync mode accepts a bare sector or a dotted key — both cover the whole sector.
    return fetchLiveSync(ctx, sector.split(".")[0]);
  });
}

/**
 * Sync-now: run syncConnection over every active non-push connection in the sector, bounded by one
 * wait. No single-flight: two concurrent calls run syncConnection twice — accepted (idempotent
 * upserts). On timeout the syncs CONTINUE in the background; we only stop waiting. Push connections
 * have no pull to run, but they are NOT silently "already live" (#39): a push-stream whose stream is
 * retrying/down contributes an attributed error and forces synced:false — a dead stream means the
 * sector is NOT fully live.
 */
async function fetchLiveSync(ctx: AuthContext, sector: string): Promise<FetchLiveResult> {
  const conns = await pool.query(
    `select ${FRESHNESS_COLS} from connectors c
      where c.user_id = $1 and c.sector = $2 and c.status = 'active'`,
    [ctx.userId, sector],
  );
  if (conns.rows.length === 0) {
    throw new NotFoundError(`no active connection for sector '${sector}'`);
  }

  // Push-mode connections have no pull to run — only poll/on_demand connections get a sync-now.
  // A push-STREAM connection with a dead stream is reported honestly instead of skipped silently.
  const syncIds: string[] = [];
  const streamFailures: string[] = [];
  for (const raw of conns.rows) {
    const row = raw as FreshnessRow;
    const connector = getConnector(row.provider);
    if (connector?.policy.mode === "push") {
      if (row.stream_state === "retrying" || row.stream_state === "down") {
        const reason = row.stream_error ? ` — ${maskError(row.stream_error)}` : "";
        streamFailures.push(`${row.provider}: push stream ${row.stream_state}${reason}`);
      }
      continue;
    }
    syncIds.push(row.id);
  }

  let synced = streamFailures.length === 0;
  let timedOut = false;
  let errors: string[] | undefined = streamFailures.length > 0 ? [...streamFailures] : undefined;

  if (syncIds.length > 0) {
    // allSettled never rejects, so a timeout leaves no unhandled rejection behind.
    const settling = Promise.allSettled(syncIds.map((id) => syncConnection(id)));
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), FETCH_LIVE_WAIT_MS);
    });
    const raced = await Promise.race([settling, wait]);
    if (timer) clearTimeout(timer); // hygiene: drop the timer when the syncs settle first

    if (raced === "timeout") {
      // A bounded WAIT, not a cancelled sync — the background syncs still land when they finish.
      synced = false;
      timedOut = true;
    } else {
      const failures: string[] = [];
      for (const r of raced) {
        // Defence in depth: every OTHER consumer of a sync error masks it before it leaves the
        // process, and these two pushes land straight in the agent-visible `errors[]`. No leak is
        // reachable today; maskError keeps it that way if a connector ever widens its message.
        if (r.status === "fulfilled") {
          if (!r.value.ok) failures.push(maskError(r.value.error ?? "sync failed"));
        } else {
          // syncConnection never throws (scheduler-safe), but stay total anyway.
          failures.push(maskError(r.reason instanceof Error ? r.reason.message : String(r.reason)));
        }
      }
      if (failures.length > 0) {
        synced = false;
        errors = [...(errors ?? []), ...failures];
      }
    }
  }

  // Explicit re-SELECT after the race — also the push-only/no-poll case's freshness value.
  const ts = await pool.query(
    `select max(last_synced_at) as ts from connectors
      where user_id = $1 and sector = $2 and status = 'active'`,
    [ctx.userId, sector],
  );
  const rawTs = ts.rows[0]?.ts as Date | string | null | undefined;
  const lastSyncedAt = rawTs == null ? null : rawTs instanceof Date ? rawTs.toISOString() : String(rawTs);

  // Per-connection POST-sync freshness: re-read the SAME rows by id (never by status — a sync that
  // just failed flips its row to 'error', and dropping it here would re-create the vanishing lie).
  const post = await pool.query(
    `select ${FRESHNESS_COLS} from connectors c where c.id = any($1) and c.user_id = $2`,
    [conns.rows.map((r) => (r as FreshnessRow).id), ctx.userId],
  );
  const connections: FetchLiveConnection[] = [];
  for (const raw of post.rows) {
    const row = raw as FreshnessRow;
    connections.push({
      connection_id: row.id,
      provider: row.provider,
      mode: getConnector(row.provider)?.policy.mode ?? null,
      freshness: await freshnessForRow(ctx.userId, row),
    });
  }

  return {
    sector,
    mode: "sync",
    synced,
    timed_out: timedOut,
    last_synced_at: lastSyncedAt,
    ...(errors ? { errors } : {}),
    connections,
  };
}

/**
 * Record mode: load the cached row by uuid (the getRecord shape — REGISTRY table, id + user_id
 * params), resolve the connection FROM THE ROW (a sector can hold two providers; the row's own
 * connection is the only correct one), then dispatch to the connector's fetchRecordLive hook.
 * Tombstoned rows ARE eligible — the truthful "is it really gone?" probe (ADR 0004).
 */
async function fetchLiveRecord(ctx: AuthContext, sector: string, id: string): Promise<FetchLiveResult> {
  // Exact-key REGISTRY lookup, the getRecord rule: single-object sectors use the bare name;
  // multi-object sectors REQUIRE the full dotted key (a bare "finance" names no table to drill).
  const schema = REGISTRY[sector];
  if (!schema) {
    const base = sector.split(".")[0];
    const keys = Object.keys(REGISTRY).filter((k) => k.startsWith(`${base}.`));
    if (keys.length > 0) {
      throw new QueryValidationError(
        `fetch_live with id requires a full object key (${keys.join(" or ")}), got '${sector}'`,
      );
    }
    throw new QueryValidationError(`unknown sector: ${sector}`);
  }

  if (!UUID_RE.test(id)) throw new NotFoundError(`no ${sector} record with id '${id}'`);
  const res = await pool.query(
    `select * from "${schema.table}" where id = $1 and user_id = $2`,
    [id, ctx.userId],
  );
  const row = res.rows[0];
  if (!row) throw new NotFoundError(`no ${sector} record with id '${id}'`);

  // The ROW's own connection — never the sector's most-recent one (deterministic provider routing).
  // `pc.username` is the credential's static identity (the Gmail IMAP email): the gmail body-drill
  // needs it to authenticate. Additive — the Microsoft `/me`-based drill ignores the extra field.
  const connRes = await pool.query(
    `select c.provider, c.sector, c.user_id, c.credential_id, pc.secret_ref, pc.refresh_ref, pc.expires_at, pc.username
       from connectors c
       join provider_credentials pc on pc.id = c.credential_id
      where c.id = $1 and c.user_id = $2`,
    [row.connection_id, ctx.userId],
  );
  const conn = connRes.rows[0];
  if (!conn) throw new NotFoundError(`no connection backs ${sector} record '${id}'`);

  const provider = conn.provider as string;
  const connector = getConnector(provider);
  if (!connector?.fetchRecordLive) {
    throw new QueryValidationError(`live record fetch not supported for ${provider}`);
  }

  const credentialId = conn.credential_id as string;
  const secretRef = (conn.secret_ref ?? null) as string | null;
  const refreshRef = (conn.refresh_ref ?? null) as string | null;
  const expiresAt = (conn.expires_at ?? null) as Date | null;
  let record: unknown;
  try {
    // Resolve the credential via the wave-5 seam (the sync path's pattern): for an OAuth credential
    // at/within the expiry margin this proactively refreshes + re-seals, handing on the FRESH token
    // and the rotated vault ref; static / non-OAuth credentials open as-is, lock-free — byte-for-byte
    // the prior behaviour. Plaintext is never logged; refresh failures stay secret-free by construction.
    const resolved = await resolveAccessToken({
      credentialId,
      userId: ctx.userId,
      provider,
      secretRef,
      refreshRef,
      expiresAt,
    });
    record = await connector.fetchRecordLive(
      {
        userId: ctx.userId,
        connectionId: row.connection_id as string,
        secretRef: resolved.secretRef,
        secret: resolved.token,
        // The CONNECTION's sector — a multi-sector connector (google, microsoft #26a) routes its
        // per-record drill on it (calendar → /me/events/{id}, contacts → /me/contacts/{id}).
        // Additive: single-sector connectors ignore it.
        sector: conn.sector as string,
        username: (conn.username ?? null) as string | null,
      },
      row.source_object_id as string,
    );
  } catch (err) {
    // The source could not serve the live request; connector/refresh messages are secret-free by construction.
    throw new FetchLiveUnavailableError(err instanceof Error ? err.message : String(err));
  }

  return { sector, mode: "record", id, record };
}
