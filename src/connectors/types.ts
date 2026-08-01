/** A single raw record pulled from a source, before normalization. */
export interface RawRecord {
  externalId: string;
  raw: unknown;
  /** Incremental checkpoint emitted after this record; the runner persists the last non-null value. */
  cursor?: string;
  /**
   * Destination object type. Unset → falls back to connector.objectType. Lets one connector yield
   * multiple object types (SimpleFIN: account + transaction), each routed to its own REGISTRY table.
   */
  object?: string;
  /** Deletion record: the source removed this object. The runner tombstones instead of upserting. */
  deleted?: boolean;
}

export interface SyncContext {
  userId: string;
  connectionId: string;
  secretRef: string | null; // pointer into the vault; the runner resolves `secretRef` -> `secret`.
  /** Resolved credential plaintext, populated by the runner from `secretRef` (never logged). */
  secret?: string | null;
  cursor?: string;
  since?: Date;
  /**
   * The CONNECTION's sector (from the connectors row). One connector instance can serve multiple
   * sectors (google: calendar + contacts); a multi-sector connector branches on this. Optional —
   * single-sector connectors ignore it. (Wave 5 `connector-wave-enablers` threads it.)
   */
  sector?: string;
  /** Static identity for username-bearing credentials (e.g. the Gmail IMAP email). */
  username?: string | null;
  /**
   * The per-connection recency window in DAYS, resolved by the runner from connectors.sync_window_days
   * (wave 12a). Bounds an unbounded mail fetch (Microsoft/Gmail): the connector pulls only messages
   * within the window. null/undefined = NO window (all history — today's behaviour / back-compat).
   * The runner sets it ONLY for mail connectors (default 180 when the column is null); non-mail
   * connectors leave it null and ignore it.
   */
  windowDays?: number | null;
}

export type SyncMode = "push" | "poll" | "on_demand";

/**
 * How freshness arrives for a source — declared data, never logic. The generic scheduler reads
 * this and orchestrates every connector the same way: `poll` runs sync() on the interval; `push`
 * registers the source's subscription/webhook; `on_demand` never auto-syncs.
 */
export interface SyncPolicy {
  mode: SyncMode;
  /**
   * How a `push` connector transports (#41, additive): `stream` = a live socket WE hold open (Home
   * Assistant WS), `webhook` = the device POSTs at will (Apple Health ingest). Declared data, never
   * logic — it drives the served `push_kind` on the connectors list/detail rows (the Console's
   * caption vocabulary: a webhook row says "Device controlled", a stream row never does). Push
   * connectors only; poll/on_demand connectors leave it undefined.
   */
  pushKind?: "stream" | "webhook";
  defaultIntervalSec?: number;
  /**
   * The FLOOR for user cadence overrides (ADR 0025): connectors.sync_interval_sec is clamped to at
   * least this many seconds by the one effectiveIntervalSec helper (scheduler, next_sync_at, and
   * freshness all share it). Declared policy-not-code because the constraint belongs to the SOURCE
   * (rate limits, billing, update-frequency reality). Poll connectors SHOULD declare it; absent →
   * the connector's defaultIntervalSec is also its floor, i.e. users may only slow down.
   */
  minIntervalSec?: number;
  freshnessToleranceSec?: number;
  supportsIncremental: boolean;
  /**
   * When true, EVERY rec.cursor this connector emits means all records up to AND including the
   * cursor-bearing record are committed, so the runner may persist it mid-stream. Default false.
   * Connectors that emit a batch/window-END cursor on every record (Plaid/SimpleFIN/Whoop) MUST
   * NOT set this.
   */
  cursorCommittedThrough?: boolean;
}

/** A typed parameter of an action — the schema-as-contract for writes. */
export interface ActionParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
}

/**
 * A capability a connector exposes to act ON the source (not read it). Declared, typed, and
 * discoverable via list_actions; the core validates params against it before dispatch. Read-only
 * connectors declare an empty catalog. Gated by the same domain grant that gates reads.
 */
export interface ActionSpec {
  /** Stable id, namespaced by sector, e.g. "home.turn_on" | "mail.send" | "home.<domain>.<service>". */
  id: string;
  description: string;
  params: ActionParam[];
  // ── Optional fields for the DYNAMIC, cache-served catalog (Home Assistant). ──
  // A static catalog leaves these undefined; existing connectors/stubs keep compiling.
  /** The sector's source domain (HA: the entity domain, e.g. "light", "lock", "scene"). */
  domain?: string;
  /** The source service this action invokes (HA: e.g. "turn_on", "lock"). */
  service?: string;
  /** Hint describing how this action is targeted (HA: which selector keys apply). */
  target?: { area?: boolean; entity?: boolean; domain?: string };
}

export interface ActionContext {
  userId: string;
  connectionId: string;
  secretRef: string | null;
  /**
   * Resolved credential plaintext, populated by the action runtime from `secretRef` (never logged).
   * Mirrors SyncContext.secret so the dispatch path has the token it needs.
   */
  secret?: string | null;
}

export interface ActionResult {
  ok: boolean;
  /** Provider response or error summary — recorded in the (async) audit trail. */
  detail?: unknown;
}

/**
 * The one unit of extension. A connector authenticates, syncs + normalizes reads, declares strong
 * keys and a sync policy, and — where the source supports it — declares an action catalog and
 * executes them. Reads fill the normalized store; actions dispatch OUT to the source (then a
 * targeted re-sync reflects the result). It never correlates or derives. Permission is
 * domain-level: a granted sector covers read AND act, across every provider in it.
 */
export interface Connector<TNormalized = unknown> {
  readonly provider: string;
  readonly sector: string;
  readonly objectType: string;

  /** How the generic scheduler should keep this source fresh. */
  readonly policy: SyncPolicy;

  /** Actions this connector can perform on the source. Empty for read-only connectors. */
  readonly actions: ActionSpec[];

  /**
   * Dynamic, cache-served action catalog. Where the static `actions` array can't enumerate the
   * surface ahead of time (Home Assistant: the catalog is the cached entity×service join), a
   * connector implements this to serve it from cache — no live source call. Read-only connectors
   * and static-catalog connectors omit it. Optional ⇒ additive (existing connectors keep compiling).
   */
  listActions?(
    ctx: ActionContext,
    filter?: { area?: string; domain?: string; entityId?: string },
  ): Promise<ActionSpec[]>;

  /** Pull raw records from the source since the cursor. */
  sync(ctx: SyncContext): AsyncIterable<RawRecord>;

  /**
   * Fetch ONE object live from the source by its provider id (the `fetch_live {id}` drill).
   * Returns the raw provider payload; `null` means the source says the object is gone.
   * Optional — never required; footprint-limited connectors (mail) return without storing.
   * (Wave 5 `fetch-live` dispatches to it; HA is the proving implementation.)
   */
  fetchRecordLive?(ctx: SyncContext, sourceObjectId: string): Promise<unknown>;

  /**
   * Decode a pushed webhook payload into RawRecords for ingestRecords. Push-ingest connectors
   * implement this; pull connectors omit it. Pure: no I/O, no secrets. The connector owns its
   * payload shape (and, for sources without native ids, synthesizes a deterministic externalId so
   * overlapping re-exports upsert idempotently); the generic ingest route stays payload-agnostic.
   * Optional ⇒ additive (existing connectors keep compiling).
   */
  decodePush?(rawBody: unknown): RawRecord[];

  /** Map a raw record to the normalized per-domain row shape. */
  normalize(raw: RawRecord): TNormalized;

  /** Deterministic strong keys — recorded now, used later for chapter-3 resolution. */
  strongKeys(raw: RawRecord): Record<string, string>;

  /** Dispatch a declared action to the source. Only ever called for an id present in `actions`. */
  execute(actionId: string, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult>;
}
