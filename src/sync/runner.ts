// The generic sync engine. One code path for every sector: load a connector's connection,
// resolve its token from the vault, stream raw records through normalize(), idempotently upsert
// them into the domain table, and advance the cursor. No per-sector logic.
//
// Deletions (ADR 0004): a RawRecord with deleted:true takes a dedicated tombstone UPDATE — never
// the upsert — stamping deleted_at and leaving normalized columns + raw untouched. Live upserts
// always write deleted_at = null, so the last writer of a live record resurrects.

import type { Connector, RawRecord, SyncContext } from "../connectors/types.js";
import { REGISTRY } from "../core/schema.js";
import { reconcileFinance } from "../core/finance-dedup.js";
import { pool } from "../db.js";
import { resolveAccessToken } from "../oauth/refresh.js";
import { classifySyncError, type SyncErrorClass } from "./retryability.js";
import { getConnector } from "./registry.js";

/**
 * Cross-provider finance dedup (#34b) — the final, awaited step of a finance sync/ingest, OFF the
 * response hot path. BEST-EFFORT: a reconcile hiccup must never flip a connection to 'error' after a
 * SUCCESSFUL sync (the data is fine; only the synthetic-union is momentarily stale until the next run).
 */
async function reconcileFinanceBestEffort(sector: string, userId: string): Promise<void> {
  if (sector !== "finance") return;
  try {
    await reconcileFinance(userId);
  } catch {
    // swallow — sync already succeeded; dedup converges on the next sync/ingest.
  }
}

export interface SyncResult {
  connectionId: string;
  provider: string;
  ok: boolean;
  upserted: number;
  /** Rows tombstoned this run (deletion records applied; no-op deletions NOT counted). */
  deleted: number;
  newCursor: string | null;
  error?: string; // set when ok === false; syncConnection NEVER throws (scheduler-safe)
  /**
   * Set only when ok === false AND the failure was a THROW the classifier saw (#99): how the final
   * attempt was classified. Absent on the two non-throwing early returns ('unknown connection', 'no
   * connector registered'), which never reach the retry loop.
   */
  errorClass?: SyncErrorClass;
}

/** Quote a SQL identifier (double-quote, escape embedded quotes). */
function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

// The two conflict keys never appear in the UPDATE SET clause.
const CONFLICT_KEYS = ["connection_id", "source_object_id"] as const;

// Unbounded mail connectors (envelope-only cache; ADR 0001). Only these get a recency window
// (wave 12a): ctx.windowDays = connectors.sync_window_days ?? MAIL_DEFAULT_WINDOW_DAYS. Every other
// connector caches its whole (bounded) surface, so windowDays stays null/ignored.
const MAIL_PROVIDERS = new Set(["microsoft", "gmail", "apple"]);

// The code default applied when a mail connector's sync_window_days is null (no migration backfill):
// existing + new mail connections sync the most-recent 6 months. All-history is an explicit LARGE
// value (setSyncWindow caps at 36500), never null — null always means "use this default" (#138
// reconcile: the old "null = all-history opt-in" claim here contradicted resolveWindowDays).
const MAIL_DEFAULT_WINDOW_DAYS = 180;

/**
 * Resolve the recency window (in days) for one connection from its provider + SECTOR + stored
 * sync_window_days. The ADR-0017 recency window is a MAIL-sector concept: only a mail-sector
 * connection of a mail (unbounded) provider gets one — the stored value, or the 180-day default when
 * null. A calendar/contacts connection of the SAME provider (microsoft fans out, ADR 0006) and every
 * non-mail provider get null (no window — they cache their full bounded surface). Exported for the
 * runner's unit test.
 */
export function resolveWindowDays(
  provider: string,
  sector: string,
  syncWindowDays: number | null,
): number | null {
  if (sector !== "mail") return null;
  if (!MAIL_PROVIDERS.has(provider)) return null;
  return syncWindowDays ?? MAIL_DEFAULT_WINDOW_DAYS;
}

/**
 * Find the REGISTRY entry whose `object` === objectType AND whose key's sector-prefix === sector.
 * Returns { key, table, fields }. Throws (fail-closed) if no match — never guess a table.
 *
 * Object-agnostic and pure (no Connector dependency) so the runner can route PER RECORD: a
 * multi-object connector (SimpleFIN → account + transaction) resolves the destination table for
 * each record from `rec.object`, falling back to `connector.objectType` when the record sets none.
 */
export function tableForObject(
  sector: string,
  objectType: string,
): { key: string; table: string; fields: string[] } {
  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (entry.object !== objectType) continue;
    // Sector prefix: dotted keys ("finance.transaction") -> "finance"; bare keys ("home") -> "home".
    const keySector = key.includes(".") ? key.slice(0, key.indexOf(".")) : key;
    if (keySector === sector) {
      return { key, table: entry.table, fields: Object.keys(entry.fields) };
    }
  }
  throw new Error(`no REGISTRY table for { sector: '${sector}', object: '${objectType}' }`);
}

/**
 * Generic snapshot-tombstone reconcile (finance-holding, #36) — HA's proven connection-scoped fence
 * semantics, generalized for any snapshot-complete object (both finance providers deliver the FULL
 * holdings set every sync). Tombstones (ADR 0004) every row of the object's REGISTRY-resolved table
 * that the fresh snapshot no longer contains: `connection_id = $1 AND deleted_at is null AND
 * ingested_at < startedAt AND source_object_id ∉ liveSourceIds AND source_object_id not like
 * 'union:%'`. The `ingested_at < startedAt` fence protects rows upserted DURING this sync (they carry
 * ingested_at >= startedAt and survive); an already-tombstoned row keeps its original deleted_at; a
 * later live upsert resurrects (the runner's upsert always writes deleted_at = null). `union:%` is
 * the ENGINE's reserved soid namespace (finance-dedup synthetics) — engine-owned rows are never
 * source-reported, so they MUST be invisible to the sweep (review fold, spec finance-holding: without
 * the exclusion the anchor connection's next sync tombstones the dedup winner, and the zombie's
 * unique(connection_id, source_object_id) key then collides with the next reconcile's create —
 * freezing all finance dedup). Returns the tombstoned count (synthetics never included).
 *
 * Callers MUST invoke this only after a COMPLETE enumeration — NEVER after a skipped/failed fetch —
 * so a transient miss can never mass-tombstone real rows (the connector's responsibility, mirroring
 * HA's zero-state skip). Table resolved via the REGISTRY ONLY (tableForObject throws on an unknown
 * pair — never string-built from input); both values parameterized (the SQL-safety invariant holds).
 *
 * Optional `window` (outlook-calendar-contacts, #26a): scope the sweep to rows whose `column` lies in
 * [from, to] — a windowed enumeration (Graph calendarView delta enumerates ONLY its window) is
 * complete only INSIDE its bounds, so rows outside stay untouched (accumulated history). The column
 * is validated against the REGISTRY `fields` of the object's table (fail-closed throw on an unknown
 * column — never string-built into SQL from input); the bounds are parameterized.
 *
 * `window.resurrectPresent` (gmail-recency-window BLOCK fold #2): a census enumeration is a LIVE
 * sighting, and ADR 0004 says every live sighting clears a tombstone. When true, BEFORE the
 * tombstone pass a second UPDATE clears `deleted_at` on rows whose soid IS in `liveSourceIds`,
 * currently tombstoned, inside the same window scope — never `union:%` (engine-owned synthetics are
 * invisible to the sweep in BOTH directions). This closes the resurrect gap for UNCHANGED messages
 * (a changed message already resurrects via its upsert, so resurrect-by-census can never serve
 * stale data). The return value stays the TOMBSTONED count; existing callers are unchanged.
 */
export async function reconcileObjectSnapshot(
  connectionId: string,
  sector: string,
  object: string,
  liveSourceIds: Set<string>,
  startedAt: Date,
  window?: { column: string; from: Date; to: Date; resurrectPresent?: boolean },
): Promise<number> {
  const { table, fields } = tableForObject(sector, object); // fail-closed REGISTRY resolution
  if (window && !fields.includes(window.column)) {
    throw new Error(
      `reconcileObjectSnapshot: unknown window column '${window.column}' for table ${table}`,
    );
  }
  if (window?.resurrectPresent) {
    // Resurrect census-present tombstoned rows FIRST (parameterized; column REGISTRY-validated
    // above). Window-scoped like the sweep itself; `union:%` synthetics are never touched.
    await pool.query(
      `update ${quoteIdent(table)} set deleted_at = null
        where connection_id = $1 and deleted_at is not null
          and source_object_id = any($2)
          and source_object_id not like 'union:%'
          and ${quoteIdent(window.column)} >= $3 and ${quoteIdent(window.column)} <= $4`,
      [connectionId, [...liveSourceIds], window.from, window.to],
    );
  }
  const params: unknown[] = [connectionId, startedAt, [...liveSourceIds]];
  let windowClause = "";
  if (window) {
    params.push(window.from, window.to);
    windowClause = ` and ${quoteIdent(window.column)} >= $4 and ${quoteIdent(window.column)} <= $5`;
  }
  const res = await pool.query(
    `update ${quoteIdent(table)} set deleted_at = now()
      where connection_id = $1 and deleted_at is null and ingested_at < $2
        and not (source_object_id = any($3))
        and source_object_id not like 'union:%'${windowClause}`,
    params,
  );
  return res.rowCount ?? 0;
}

/**
 * Build an idempotent upsert: insert ... on conflict (connection_id, source_object_id) do update set ...
 * All values parameterized; all identifiers quoted. Requires `source_object_id` in the row, else throws.
 */
export function buildUpsert(table: string, row: Record<string, unknown>): { sql: string; values: unknown[] } {
  const cols = Object.keys(row);
  if (!cols.includes("source_object_id")) {
    throw new Error("buildUpsert: row is missing required column 'source_object_id'");
  }

  const values = cols.map((col) => row[col]);
  const colList = cols.map(quoteIdent).join(", ");
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

  const updateCols = cols.filter((col) => !CONFLICT_KEYS.includes(col as (typeof CONFLICT_KEYS)[number]));
  const updateSet = updateCols
    .map((col) => `${quoteIdent(col)} = excluded.${quoteIdent(col)}`)
    .join(", ");

  const conflictList = CONFLICT_KEYS.map(quoteIdent).join(", ");

  const sql =
    `insert into ${quoteIdent(table)} (${colList}) values (${placeholders}) ` +
    `on conflict (${conflictList}) do update set ${updateSet}`;

  return { sql, values };
}

/**
 * The shared per-record path: stream raw records -> normalize -> REGISTRY-validate -> generic upsert
 * (or, for deletion records, the dedicated tombstone UPDATE). The destination table is resolved PER
 * RECORD from rec.object (falling back to connector.objectType) and the CONNECTION's sector — not the
 * connector's static one — so one connector can fan a single stream out across multiple domain tables
 * (SimpleFIN: finance_accounts + finance_transactions) AND one connector instance can serve multiple
 * sectors (google: calendar + contacts connections). The cursor stays GLOBAL per connection (it tracks
 * progress through the source stream, not per table).
 *
 * Drives BOTH the pull path (syncConnection, recs = connector.sync(ctx)) and the push path
 * (ingestRecords, recs = a pushed batch) off ONE implementation — no duplication. THROWS (fail-closed)
 * on an unknown (sector, object), a deletion record without an externalId, a normalized record missing
 * source_object_id, or an unknown normalized column; the caller's try/catch flips status='error'.
 */
async function applyRecords(
  connector: Connector,
  connectionId: string,
  userId: string,
  sector: string,
  recs: AsyncIterable<RawRecord> | Iterable<RawRecord>,
): Promise<{ upserted: number; deleted: number; lastCursor: string | null }> {
  let upserted = 0;
  let deleted = 0;
  let lastCursor: string | null = null;
  for await (const rec of recs) {
    const objectType = rec.object ?? connector.objectType;
    // Throws (fail-closed) for an unknown (sector, object) — the caller's catch flips status='error'.
    const { table, fields } = tableForObject(sector, objectType);

    if (rec.deleted === true) {
      // Deletion record (ADR 0004): skip normalize() entirely and take a dedicated UPDATE —
      // never the upsert. A deletion stub must not overwrite normalized columns/raw, and an
      // unknown id must not insert a ghost row. The `deleted_at is null` guard keeps the
      // original tombstone timestamp on re-delivery. Table name is REGISTRY-derived; both
      // values parameterized (the SQL-safety invariant is unchanged).
      if (typeof rec.externalId !== "string" || rec.externalId === "") {
        throw new Error("deletion record missing externalId");
      }
      // 'union:' is the finance-dedup engine's reserved soid namespace (#37; see the sweep exemption
      // in reconcileObjectSnapshot). A provider deletion record must never tombstone an engine-owned
      // synthetic winner (synthetics carry a real member connection_id, so the UPDATE would match).
      // Exact-case check on purpose: only the exact 'union:' prefix is sweep-exempt/engine-visible,
      // so a case-variant has no forgery value.
      if (rec.externalId.startsWith("union:")) {
        throw new Error(`deletion externalId '${rec.externalId}' uses the reserved 'union:' namespace`);
      }
      const res = await pool.query(
        `update ${quoteIdent(table)} set deleted_at = now() where connection_id = $1 and source_object_id = $2 and deleted_at is null`,
        [connectionId, rec.externalId],
      );
      if ((res.rowCount ?? 0) > 0) deleted++;
      if (rec.cursor != null) {
        lastCursor = rec.cursor;
        // Incremental checkpoint (ADR 0016) — OPT-IN. Persist the connector cursor IMMEDIATELY as
        // records stream (not only at cycle end) ONLY when the connector declares its cursor is
        // committed-through, so a mid-enumeration failure resumes from here instead of restarting
        // from zero. For that connector's contract a cursor on a record means everything streamed
        // up to AND including it is committed. Connectors that emit a batch/window-END cursor on
        // every record (Plaid/SimpleFIN/Whoop) DON'T set the flag → cursor written once at cycle
        // end on success (today's safe behaviour). Parameterized; targeted to this connection.
        if (connector.policy.cursorCommittedThrough === true) {
          await pool.query(`update connectors set cursor = $2 where id = $1`, [connectionId, rec.cursor]);
        }
      }
      continue;
    }

    const allowed = new Set(fields);
    const norm = connector.normalize(rec) as Record<string, unknown>;
    if (norm.source_object_id == null || norm.source_object_id === "") {
      throw new Error("normalized record missing source_object_id");
    }
    // Reserved-namespace rejection (#37): a provider payload must never PLANT a 'union:%' row — a
    // forged synthetic would be exempt from snapshot sweeps AND read as a dedup winner. Checked on
    // the NORMALIZED soid (connectors derive it from raw, so a poisoned raw with a clean externalId
    // would bypass an externalId-only check). Exact-case, matching the sweep's literal.
    if (String(norm.source_object_id).startsWith("union:")) {
      throw new Error(
        `source_object_id '${String(norm.source_object_id)}' uses the reserved 'union:' namespace`,
      );
    }
    for (const col of Object.keys(norm)) {
      if (!allowed.has(col)) {
        throw new Error(`normalized record has unknown column '${col}' for table ${table}`);
      }
    }
    const insertRow = {
      connection_id: connectionId,
      user_id: userId,
      ...norm,
      raw: rec.raw,
      ingested_at: new Date(),
      deleted_at: null, // last writer of a live record RESURRECTS a tombstoned row (ADR 0004 #3)
    };
    const { sql, values } = buildUpsert(table, insertRow);
    await pool.query(sql, values);
    upserted++;
    if (rec.cursor != null) {
      lastCursor = rec.cursor;
      // Incremental checkpoint (ADR 0016) — OPT-IN; see the deletion branch above. Persist the
      // connector cursor IMMEDIATELY ONLY when the connector declares its cursor committed-through
      // (resumable large initial syncs without restarting from zero); otherwise cursor is written
      // once at cycle end on success (today's safe behaviour for non-opted-in connectors).
      if (connector.policy.cursorCommittedThrough === true) {
        await pool.query(`update connectors set cursor = $2 where id = $1`, [connectionId, rec.cursor]);
      }
    }
  }
  return { upserted, deleted, lastCursor };
}

/** Injectable seam so the retry loop is unit-testable without real elapsed time. */
export interface SyncOptions {
  /** Total attempts including the first. Default MAX_SYNC_ATTEMPTS (3). Clamped to >= 1. */
  attempts?: number;
  /** Backoff sleeper. Default: a real (unref'd) timer. Tests inject a recorder. */
  sleep?: (ms: number) => Promise<void>;
}

/** 1 initial attempt + 2 retries. */
export const MAX_SYNC_ATTEMPTS = 3;
/** Backoff before retry i (0-based); the last entry repeats if the budget ever grows. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 4_000];
/** ± this fraction of the nominal backoff. Same thundering-herd reason as scheduler.ts:76. */
export const RETRY_JITTER_FRACTION = 0.25;

/** Jittered backoff for retry `i` (0-based), floored at 0. */
function backoffFor(i: number): number {
  const base = RETRY_BACKOFF_MS[Math.min(i, RETRY_BACKOFF_MS.length - 1)] ?? 0;
  const jittered = base * (1 + (Math.random() * 2 - 1) * RETRY_JITTER_FRACTION);
  return Math.max(0, jittered);
}

/**
 * The default sleeper. `unref` matters: a pending retry timer must never hold the process open
 * through buildShutdown (src/index.ts).
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * Is this connection still worth hitting the provider for? Stops a retry budget from hammering a
 * source after an operator pause/revoke landed MID-RETRY. Best-effort like markError: a DB failure
 * here returns true — bookkeeping must never change the sync outcome. A vanished row (deleted
 * connection) is NOT schedulable.
 */
async function stillSchedulable(connectionId: string): Promise<boolean> {
  try {
    const res = await pool.query(`select status from connectors where id = $1`, [connectionId]);
    const status = res.rows[0]?.status as string | undefined;
    return status === "active" || status === "error" || status === "syncing";
  } catch {
    return true; // never let a bookkeeping read decide the outcome
  }
}

/**
 * ONE sync attempt, end to end: resolve secret -> sync() -> normalize() -> generic upsert (or, for
 * deletion records, the dedicated tombstone UPDATE) -> cursor + last_synced_at write-back. RETHROWS
 * on failure — the retry loop in syncConnection owns classification and the status write. Reports
 * the loaded provider through `ctxOut` so the caller can name it even when a later attempt throws.
 */
async function attemptSync(connectionId: string, ctxOut: { provider: string }): Promise<SyncResult> {
  let provider = "";
  {
    // 1. Load the connection + its credential's token refs (access/refresh) + expiry + custody. The
    //    refresh fields feed resolveAccessToken's proactive OAuth refresh; static credentials ignore them.
    const connRes = await pool.query(
      `select c.id, c.user_id, c.provider, c.sector, c.cursor, c.last_synced_at, c.sync_window_days,
              c.credential_id, pc.secret_ref, pc.refresh_ref, pc.expires_at, pc.custody, pc.username
         from connectors c
         join provider_credentials pc on pc.id = c.credential_id
        where c.id = $1`,
      [connectionId],
    );
    const row = connRes.rows[0];
    if (!row) {
      return { connectionId, provider, ok: false, upserted: 0, deleted: 0, newCursor: null, error: "unknown connection" };
    }
    provider = row.provider as string;
    ctxOut.provider = provider; // so a later attempt's throw can still be reported by provider
    const userId = row.user_id as string;
    const sector = row.sector as string;
    const credentialId = row.credential_id as string;
    const secretRef = (row.secret_ref ?? null) as string | null;
    const refreshRef = (row.refresh_ref ?? null) as string | null;
    const expiresAt = (row.expires_at ?? null) as Date | null;

    // 2. Resolve the connector.
    const connector = getConnector(provider);
    if (!connector) {
      const error = `no connector registered for ${provider}`;
      await markError(connectionId, error);
      return {
        connectionId,
        provider,
        ok: false,
        upserted: 0,
        deleted: 0,
        newCursor: null,
        error,
      };
    }

    // 3. Resolve the credential token (plaintext, never logged). For OAuth credentials this
    //    proactively refreshes + re-seals a near-expiry access token before handing it on; static
    //    credentials open as before. A refresh failure throws → the outer catch flips status='error'.
    const resolved = await resolveAccessToken({
      credentialId,
      userId,
      provider,
      secretRef,
      refreshRef,
      expiresAt,
    });

    // 4. Build the connector's context. secretRef is the CURRENT vault ref (new after a refresh —
    //    the boot-loaded one is retired then); sector is the CONNECTION's (one google connector
    //    instance serves calendar AND contacts connections); username is the credential's static
    //    identity (e.g. the Gmail IMAP email).
    const ctx: SyncContext = {
      userId,
      connectionId,
      secretRef: resolved.secretRef,
      secret: resolved.token,
      cursor: row.cursor ?? undefined,
      since: row.last_synced_at ?? undefined,
      sector,
      username: row.username ?? null,
      // wave 12a: a recency window for MAIL-sector connections of mail providers only (default 180d
      // when null); null elsewhere — incl. calendar/contacts connections of a mail provider (#26a).
      windowDays: resolveWindowDays(provider, sector, (row.sync_window_days ?? null) as number | null),
    };

    // 5. Stream raw records -> normalize -> upsert (or tombstone) via the shared per-record path.
    const { upserted, deleted, lastCursor } = await applyRecords(
      connector,
      connectionId,
      userId,
      sector,
      connector.sync(ctx),
    );

    // 6. Advance cursor + freshness, mark active, and CLEAR any prior last_error (the connection recovered).
    //    Status guard (#41, the markError pattern): a slow sync that lands AFTER an operator
    //    pause/revoke must not resurrect the row — the operator verb wins, the whole write is skipped.
    await pool.query(
      `update connectors set cursor = coalesce($2, cursor), last_synced_at = now(), status = 'active',
              last_error = null, last_error_at = null
        where id = $1 and status not in ('paused', 'revoked')`,
      [connectionId, lastCursor],
    );

    // 7. Cross-provider finance dedup — final awaited step (best-effort, off the hot path).
    await reconcileFinanceBestEffort(sector, userId);

    // 8. Done.
    return { connectionId, provider, ok: true, upserted, deleted, newCursor: lastCursor };
  }
}

/**
 * Run ONE connector end to end, with a BOUNDED in-run retry for TRANSIENT failures (#99, ADR 0034).
 * NEVER throws — the scheduler depends on this (scheduler.ts:179).
 *
 * The point of the retry: before this, EVERY error that was not a RetryableError went straight to
 * markError → connectors.status='error' → deriveFreshness 'error' → the Console rendered
 * "needs you / Reconnect". Only microsoft ever threw RetryableError, so a single 503 from Plaid,
 * SimpleFIN, Whoop or Google flipped a perfectly healthy connection to "needs you" for a whole
 * cadence (6h for finance). Now a transient blip is retried inside the run and, in the common case,
 * never reaches a status write at all.
 *
 * Each retry re-runs the WHOLE attempt including the connection-row load. That is deliberate: a
 * `cursorCommittedThrough` connector (Microsoft) persists its cursor mid-stream (runner.ts:264,:307),
 * so a retry reusing attempt 1's ctx.cursor would restart the delta chain from a stale checkpoint.
 * Re-loading costs one indexed SELECT and picks up the committed cursor; every upsert is idempotent
 * (buildUpsert), so a partial attempt followed by a full one is safe by construction.
 *
 * A TERMINAL error is retried ZERO times — a dead credential must reach "Reconnect" immediately, and
 * hammering a provider over one is strictly worse than failing fast.
 *
 * Latency: both non-scheduler call sites already race this against a bounded wait
 * (core/context.ts:277 FETCH_LIVE_WAIT_MS, core/lifecycle.ts:507 SYNC_NOW_WAIT_MS), so the added
 * retry time can never extend a user- or agent-facing wait — only the background run.
 */
export async function syncConnection(connectionId: string, opts?: SyncOptions): Promise<SyncResult> {
  const ctxOut = { provider: "" };
  const attempts = Math.max(1, opts?.attempts ?? MAX_SYNC_ATTEMPTS);
  const sleep = opts?.sleep ?? defaultSleep;
  let lastErr: unknown;

  try {
    for (let i = 0; i < attempts; i++) {
      try {
        return await attemptSync(connectionId, ctxOut); // success (or a non-throwing early return)
      } catch (err) {
        lastErr = err;
        if (classifySyncError(ctxOut.provider, err) === "terminal") break; // never retry terminal
        if (i === attempts - 1) break; // budget exhausted
        if (!(await stillSchedulable(connectionId))) break; // operator verb landed mid-retry
        await sleep(backoffFor(i));
      }
    }
  } catch (err) {
    // Nothing above is supposed to throw (classifySyncError never throws, stillSchedulable swallows,
    // an injected sleep might not) — but syncConnection's no-throw contract is absolute, so any
    // escape lands on the failure path below rather than on the scheduler.
    lastErr = err;
  }

  // Best-effort: flag the connection + record the (masked) reason so the scheduler/Console can
  // surface it. A TRANSIENT final failure is a RESUMABLE mid-sync, not a broken connector: it reads
  // status='syncing' (ADR 0016 — the scheduler keeps re-polling, the next run resumes from the
  // checkpointed cursor, deriveFreshness maps it to the quiet 'syncing' state) while still recording
  // the reason. TERMINAL stays status='error' (today's behaviour) so the Console offers Reconnect.
  const error = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const errorClass = classifySyncError(ctxOut.provider, lastErr);
  if (errorClass === "transient") {
    await markSyncing(connectionId, error);
  } else {
    await markError(connectionId, error);
  }
  return {
    connectionId,
    provider: ctxOut.provider,
    ok: false,
    upserted: 0,
    deleted: 0,
    newCursor: null,
    error,
    errorClass,
  };
}

/**
 * Run a pushed batch through the SAME per-record path as a pull sync (normalize→validate→upsert/
 * tombstone), with a LIGHT connection load (user_id/provider/sector only — NO credential join, NO
 * vault/token resolve: pushed data carries its own payload and needs neither). The destination table,
 * connection_id, and user_id come from the connectors ROW — never from the pushed records — so a
 * pusher cannot choose its own owner/table. NEVER throws (returns a SyncResult). `last_synced_at`
 * becomes "when the last push landed" (what describe_context surfaces); same cursor/freshness
 * write-back as syncConnection.
 *
 * NO ERROR LOCKOUT (wave 8b): unlike syncConnection, a bad/oversized batch must NOT flip the
 * connection to status='error'. The LIGHT load filters on `status = 'active'`, so flipping to 'error'
 * here would make every subsequent push 401 (an unauthenticated device can't self-heal). A malformed
 * batch returns { ok:false, error } and leaves the connection ACTIVE so the next good push succeeds.
 */
export async function ingestRecords(connectionId: string, records: RawRecord[]): Promise<SyncResult> {
  let provider = "";
  try {
    // LIGHT load — no provider_credentials join, no token resolve.
    const connRes = await pool.query(
      `select user_id, provider, sector from connectors where id = $1 and status = 'active'`,
      [connectionId],
    );
    const row = connRes.rows[0];
    if (!row) {
      return { connectionId, provider, ok: false, upserted: 0, deleted: 0, newCursor: null, error: "unknown connection" };
    }
    provider = row.provider as string;
    const userId = row.user_id as string;
    const sector = row.sector as string;

    const connector = getConnector(provider);
    if (!connector) {
      // No lockout: leave status='active' (see the no-error-lockout note above). Just report.
      return {
        connectionId,
        provider,
        ok: false,
        upserted: 0,
        deleted: 0,
        newCursor: null,
        error: `no connector registered for ${provider}`,
      };
    }

    const { upserted, deleted, lastCursor } = await applyRecords(connector, connectionId, userId, sector, records);

    // Same write-back as syncConnection: advance cursor + freshness ("last push landed"), mark active,
    // and clear any prior last_error (a good push means the connection recovered). Status guard (#41):
    // a pause/revoke landing mid-batch (the light load checked 'active' BEFORE the records streamed)
    // must not be resurrected by this write — the operator verb wins.
    await pool.query(
      `update connectors set cursor = coalesce($2, cursor), last_synced_at = now(), status = 'active',
              last_error = null, last_error_at = null
        where id = $1 and status not in ('paused', 'revoked')`,
      [connectionId, lastCursor],
    );

    // Cross-provider finance dedup — final awaited step (best-effort, off the hot path).
    await reconcileFinanceBestEffort(sector, userId);

    return { connectionId, provider, ok: true, upserted, deleted, newCursor: lastCursor };
  } catch (err) {
    // No lockout: a malformed/oversized batch must NOT disable the connection (it would 401 every
    // later push). Report the error but leave status='active'. Never rethrow (the push edge must not
    // 500 on a bad record).
    const error = err instanceof Error ? err.message : String(err);
    return { connectionId, provider, ok: false, upserted: 0, deleted: 0, newCursor: null, error };
  }
}

/**
 * Mask a sync error message before it is PERSISTED to connectors.last_error. Connector/refresh
 * messages are secret-free by construction, but last_error is operator-visible and durable, so we
 * redact defensively: strip URL userinfo (the SimpleFIN access URL embeds basic-auth as
 * `https://user:pass@host`) and obvious secret query params, then cap the length. Never logs.
 */
export function maskError(msg: string): string {
  return msg
    .replace(/\/\/[^/\s@]+@/g, "//***@") // scheme://user:pass@host -> scheme://***@host
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|secret|password|auth)=)[^&\s]+/gi, "$1***")
    .slice(0, 500);
}

/**
 * Best-effort status flip to 'error'; swallows its own failure so syncConnection can't throw. When a
 * reason is supplied it is MASKED (secret-free) and recorded with a timestamp into last_error /
 * last_error_at (cleared by the next successful sync write-back). Exported (#39) for the HA
 * connector's mid-run terminal auth death — status='error' is what makes the Console offer Reconnect.
 */
export async function markError(connectionId: string, error?: string): Promise<void> {
  try {
    const masked = error != null && error !== "" ? maskError(error) : null;
    await pool.query(
      // status guard: an event-driven writer (HA mid-run death) can race an operator pause/revoke —
      // the operator verb must win, and a revoked row must never re-enter the push scan via 'error'.
      `update connectors set status = 'error', last_error = $2, last_error_at = now()
        where id = $1 and status not in ('paused', 'revoked')`,
      [connectionId, masked],
    );
  } catch {
    // best-effort only — never let bookkeeping escape syncConnection
  }
}

/**
 * Push-stream health write-back (#39/#40, ADR 0023). Persists the stream's transport state into the
 * three migration-0011 columns — and ONLY those: it NEVER touches `status`, so the pause/revoke
 * resurrection guard (#4/#5) holds by construction and the scan/ingest/describe status filters keep
 * their exact semantics. `stream_error` is always MASKED (secret-free) and nulled when no reason is
 * given (a 'connected' write clears it); `stream_changed_at` re-stamps ONLY on a state TRANSITION
 * (compare-and-set against the row's current stream_state), so a retry loop re-reporting 'retrying'
 * keeps the original "since" timestamp. Best-effort like markError: swallows its own failure so
 * stream bookkeeping can never escape into a caller.
 */
export async function markStreamState(
  connectionId: string,
  state: "connected" | "retrying" | "down",
  error?: string | null,
): Promise<void> {
  try {
    const masked = error != null && error !== "" ? maskError(error) : null;
    await pool.query(
      `update connectors
          set stream_error = $3,
              stream_changed_at = case when stream_state is distinct from $2 then now() else stream_changed_at end,
              stream_state = $2
        where id = $1`,
      [connectionId, state, masked],
    );
  } catch {
    // best-effort only — never let stream bookkeeping escape the caller
  }
}

/**
 * Best-effort status flip to 'syncing' for a RETRYABLE mid-sync failure (ADR 0016): the connection
 * is resumable, not broken, so it reads as "Syncing…" rather than a hard error, the scheduler keeps
 * re-polling it, and the next run resumes from the incrementally-checkpointed cursor. The (masked)
 * reason is still recorded in last_error/last_error_at so the cause stays inspectable; last_synced_at
 * is left untouched (stamped ONLY on a fully-successful cycle). Swallows its own failure (never throws).
 */
async function markSyncing(connectionId: string, error?: string): Promise<void> {
  try {
    const masked = error != null && error !== "" ? maskError(error) : null;
    await pool.query(
      // Status guard (#41, the markError pattern): a retryable failure racing an operator
      // pause/revoke must not flip the row back to 'syncing' — the operator verb wins.
      `update connectors set status = 'syncing', last_error = $2, last_error_at = now()
        where id = $1 and status not in ('paused', 'revoked')`,
      [connectionId, masked],
    );
  } catch {
    // best-effort only — never let bookkeeping escape syncConnection
  }
}
