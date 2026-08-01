// The ONE freshness derivation (#39/#40, ADR 0023). Every surface — GET /api/connectors,
// describe_context, operator sync-now, sector fetch_live — serves the SAME derived tuple computed
// here, so no adapter (and no FE) ever re-derives freshness from raw status+timestamps again (the
// three divergent Console derivations and the two-week "Live"-while-dead lie are the bug class this
// kills). Transport-only: this is "when did we last hear from the source", never data recency
// (each object's primaryTime) — two clocks, never conflated (docs/design/freshness-grammar.md).
//
// Pure and DB-free: callers load the row (+ the registered connector's policy/push-kind) and pass
// the inputs; `now` is injectable so staleness is unit-testable without sleeps.

/** The one server-side state word per connection. There is deliberately NO live/fresh split —
 *  transport mechanism is not a health state; a healthy stream's connectedness is a caption fact
 *  carried by `stream_state` (operator decision 2026-07-09). */
export type FreshnessState =
  | "ok"
  | "syncing"
  | "stale"
  | "unreachable"
  | "error"
  | "paused"
  | "disconnected"
  | "never_synced";

export interface Freshness {
  state: FreshnessState;
  /** The one "last synced" clock (connectors.last_synced_at), every mode. */
  last_heard_at: string | null;
  /** Poll only — the computed next_sync_at. null MEANS something per mode: stream → "Instant —
   *  connected" (see stream_state), webhook → "Device controlled". */
  next_expected_at: string | null;
  /** Push-stream transport fact (feeds captions, never the badge). null for non-stream connections. */
  stream_state: "connected" | "retrying" | "down" | null;
  error: { message: string; since: string | null } | null;
}

/** Stream-silence fallback for a push-stream row with NO persisted stream_state (pre-migration /
 *  never-started): older than this since last_synced_at reads stale. */
export const PUSH_STREAM_STALE_MS = 15 * 60 * 1000;
/** Webhook silence is ADVISORY only (the device makes no promise; we can never reach out). */
export const WEBHOOK_STALE_MS = 48 * 60 * 60 * 1000;

// ── Poll staleness: TWO thresholds, because "late" and "broken" are different facts (#116) ──
//
// Three Microsoft connections whose syncs had all SUCCEEDED sat in the Console's NEEDS ATTENTION
// band at 8–9 minutes old, beside genuinely broken sources. `sync_interval_sec` is NULL on them, so
// the cadence is microsoft.ts's 300 s default — the shortest of any connector — and a single scale
// -free 1.5× grace put the alarm 2.5 minutes past the tick. One late scheduler tick is not an
// outage, and a band that reports connections that work teaches its reader to ignore it.
//
// So the poll expectation is split in two, and BOTH survive:
//
//   · the NEAR threshold ends "ok" — we no longer claim the data is current, and the Console says
//     so quietly (tone `idle`). Nothing here is evidence that anything is broken.
//   · the FAR threshold is where OUR OWN SCHEDULER, not the source, becomes the suspect. That one
//     carries an `error` on the tuple, which is what earns the red band (apps/web/src/api/
//     freshness.ts `toneFor`). It exists because a pure "alarm only when an attempt failed" rule
//     reopens the silent-outage class: a dead scheduler attempts nothing, fails nothing, and would
//     never alarm — issue #25 (the scheduler that never caught up after a restart) and issue #40
//     (a dead push connector invisible for two weeks), both real, both closed at real cost.
//
// Each threshold is `max(factor × cadence, cadence + floor)`. The FLOOR is the load-bearing half: a
// purely multiplicative grace is scale-free across cadences spanning 300 s to 21600 s, so Microsoft
// got 2.5 minutes of slack where Plaid got three hours — while the causes of lateness (tick jitter,
// sync duration, a container restart, a slow provider) are roughly CONSTANT in absolute time.

/** A poll connection stops reading `ok` past this multiple of its declared cadence. Its meaning is
 *  narrowed by #116: this is the end of "current", NOT the start of the alarm. */
export const POLL_STALE_FACTOR = 1.5;
/** Absolute floor under the near grace, so a short cadence is not tripped by one late tick. */
export const POLL_STALE_MIN_GRACE_MS = 10 * 60 * 1000;
/** Past this multiple of cadence the schedule has been missed repeatedly — the gateway is suspect. */
export const POLL_ALARM_FACTOR = 4;
/** Absolute floor under the far grace, for the same scale-free reason as the near one. */
export const POLL_ALARM_MIN_GRACE_MS = 2 * 60 * 60 * 1000;

/** The message the far threshold states on the tuple. Secret-free and provider-agnostic. */
export const POLL_ALARM_MESSAGE = "scheduled sync overdue by several cadences";
/** The message a silent, unstamped push stream states on the tuple (the #40 state). */
export const PUSH_STREAM_SILENT_MESSAGE = "push stream silent — the socket is not reporting";

/** Age past which a poll connection stops reading `ok` (still calm — see the block comment). */
export function pollStaleGraceMs(intervalSec: number): number {
  const ms = intervalSec * 1000;
  return Math.max(POLL_STALE_FACTOR * ms, ms + POLL_STALE_MIN_GRACE_MS);
}

/** Age past which a poll connection's lateness is itself the complaint (#25/#40). */
export function pollAlarmGraceMs(intervalSec: number): number {
  const ms = intervalSec * 1000;
  return Math.max(POLL_ALARM_FACTOR * ms, ms + POLL_ALARM_MIN_GRACE_MS);
}

/** Worst-first severity order (ADR 0023) for sector/tile rollups. `disconnected` sits between
 *  `paused` and `ok` — a revoked link is quieter than a pause but still not healthy. */
export const FRESHNESS_SEVERITY: readonly FreshnessState[] = [
  "error",
  "unreachable",
  "stale",
  "syncing",
  "never_synced",
  "paused",
  "disconnected",
  "ok",
];

/** The rollup: the worst state present, by FRESHNESS_SEVERITY. Empty input → null. */
export function worstFreshness(states: FreshnessState[]): FreshnessState | null {
  let worst: FreshnessState | null = null;
  for (const s of states) {
    if (worst === null || FRESHNESS_SEVERITY.indexOf(s) < FRESHNESS_SEVERITY.indexOf(worst)) worst = s;
  }
  return worst;
}

/** Normalize a pg timestamp (Date | string | null) to an ISO string or null. */
function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

/** How a `push` connection transports, duck-typed from the registered connector's shape (`start`
 *  is deliberately not on the Connector interface): has start → stream (HA); has decodePush →
 *  webhook (Apple Health). Null for non-push / unregistered providers. */
export function pushKindOf(
  connector: { policy?: { mode?: string }; start?: unknown; decodePush?: unknown } | null | undefined,
): "stream" | "webhook" | null {
  if (connector?.policy?.mode !== "push") return null;
  if (typeof connector.start === "function") return "stream";
  if (typeof connector.decodePush === "function") return "webhook";
  return null;
}

export function deriveFreshness(
  input: {
    status: string;
    mode: "poll" | "push" | "on_demand" | null;
    pushKind: "stream" | "webhook" | null;
    lastSyncedAt: Date | string | null;
    nextSyncAt: string | null;
    intervalSec: number | null;
    cachedCount: number | null;
    streamState: string | null;
    streamError: string | null;
    streamChangedAt: Date | string | null;
    lastError: string | null;
    lastErrorAt: Date | string | null;
  },
  now?: Date,
): Freshness {
  const nowMs = (now ?? new Date()).getTime();
  const lastHeardAt = toIso(input.lastSyncedAt);
  const streamState =
    input.streamState === "connected" || input.streamState === "retrying" || input.streamState === "down"
      ? input.streamState
      : null;

  const tuple = (
    state: FreshnessState,
    over?: Partial<Pick<Freshness, "next_expected_at" | "stream_state" | "error">>,
  ): Freshness => ({
    state,
    last_heard_at: lastHeardAt,
    next_expected_at: over?.next_expected_at ?? null,
    stream_state: over && "stream_state" in over ? (over.stream_state ?? null) : streamState,
    error: over?.error ?? null,
  });

  // ── Non-active statuses win outright (the row's own word about itself). ──
  if (input.status === "revoked") return tuple("disconnected");
  if (input.status === "paused") return tuple("paused");
  if (input.status === "error") {
    return tuple("error", {
      error: { message: input.lastError ?? "sync failed", since: toIso(input.lastErrorAt) },
    });
  }
  if (input.status === "syncing") return tuple("syncing");

  // ── active + never-heard fallback (shared): first sync running vs never started. ──
  const neverHeard = (): Freshness =>
    tuple((input.cachedCount ?? 0) > 0 ? "syncing" : "never_synced");

  if (input.mode === "push") {
    // Webhook (device POSTs at will): silence is ambiguous — ADVISORY stale, never unreachable,
    // no stream concept (stream columns are ignored even if present).
    if (input.pushKind === "webhook") {
      if (lastHeardAt == null) return tuple("never_synced", { stream_state: null });
      const stale = nowMs - new Date(lastHeardAt).getTime() > WEBHOOK_STALE_MS;
      return tuple(stale ? "stale" : "ok", { stream_state: null });
    }
    // Stream (or unknown push kind — the stream semantics are the honest default: the columns are
    // only ever written by a stream connector).
    if (streamState === "connected") return tuple("ok");
    if (streamState === "retrying" || streamState === "down") {
      return tuple("unreachable", {
        error: {
          message: input.streamError ?? `push stream ${streamState}`,
          since: toIso(input.streamChangedAt),
        },
      });
    }
    // stream_state null (pre-migration / never-started): last_synced_at age fallback.
    if (lastHeardAt == null) return neverHeard();
    if (nowMs - new Date(lastHeardAt).getTime() > PUSH_STREAM_STALE_MS) {
      // A socket WE hold open that has said nothing for a quarter hour and never stamped a
      // stream_state IS evidence of a problem — this is the #40 state, and it keeps its alarm by
      // stating that evidence rather than by the renderer guessing from the transport kind.
      return tuple("stale", {
        error: { message: PUSH_STREAM_SILENT_MESSAGE, since: lastHeardAt },
      });
    }
    return tuple("ok");
  }

  // ── poll / on_demand / unregistered: cadence expectation where one is declared. ──
  if (lastHeardAt == null) return neverHeard();
  const nextExpected = input.mode === "poll" ? input.nextSyncAt : null;
  if (input.mode === "poll" && input.intervalSec != null) {
    const age = nowMs - new Date(lastHeardAt).getTime();
    // FAR first: past this, the schedule has been missed repeatedly and the gateway itself is the
    // suspect. The `error` is OUR complaint about OUR scheduler, not a provider failure — it is
    // what the Console reads to earn the red band, and it is why a dead scheduler that never
    // attempts (and so never sets last_error) still surfaces (#25/#40).
    if (age > pollAlarmGraceMs(input.intervalSec)) {
      return tuple("stale", {
        next_expected_at: nextExpected,
        error: { message: POLL_ALARM_MESSAGE, since: lastHeardAt },
      });
    }
    // NEAR: no longer current, but nothing is broken on our side — the sync that ran last SUCCEEDED
    // and this is a late tick. Same word on the wire, no complaint attached, so the Console renders
    // it calm (#116).
    if (age > pollStaleGraceMs(input.intervalSec)) {
      return tuple("stale", { next_expected_at: nextExpected });
    }
  }
  return tuple("ok", { next_expected_at: nextExpected });
}
