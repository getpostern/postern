// Home Assistant connector — the action-rich, push-mode source.
//
// It is self-managed (policy: push, NOT poll-scheduled). On start() it opens one authenticated
// WebSocket, fetches the entity states + the capability surface (the service registry + the three
// registries), upserts entities into home_entities, and keeps both fresh via state_changed +
// registry-update events. The capability cache (services + the area/device/entity graph) is
// IN-MEMORY per connection — rebuilt on connect.
//
// listActions() serves the DYNAMIC catalog from that cache (the entity×service join, gated by
// supported_features, with admin/system services dropped) — no live HA call. execute() performs a
// SINGLE call_service dispatch (NO retry), then fires an async targeted re-sync of the affected
// entities. Scenes/scripts/automations/buttons/helpers are just services — first-class.
//
// Source removals tombstone (ADR 0004): a state_changed→null and a registry 'remove' stamp
// deleted_at; every (re)connect snapshot reconciles against get_states ∪ the registry (with a
// zero-state guard + an ingested_at fence); every live write resurrects. Tombstoned entities are
// neither catalog entries nor action targets.

import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionContext,
  ActionResult,
} from "./types.js";
import { HaWsClient } from "./homeassistant-ws.js";
import { markError, markStreamState } from "../sync/index.js";
import { pool } from "../db.js";
import { resolveSelector, type Selector, type ResolvedTarget } from "../core/selector.js";

/** Normalized home entity row (matches home_entities). */
export interface HomeEntityRow {
  source_object_id: string; // HA entity_id, e.g. 'light.kitchen'
  entity_id: string;
  domain: string;
  area: string | null;
  state: string | null;
  unit: string | null;
  availability: string | null;
  state_timestamp: string | null;
  attributes: Record<string, unknown> | null;
}

// ── HA raw shapes (the subset we read) ──────────────────────────────────────────
interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}
interface HaServiceField {
  required?: boolean;
  description?: string;
  selector?: unknown;
  filter?: { supported_features?: number[]; attribute?: Record<string, unknown> };
}
interface HaService {
  name?: string;
  description?: string;
  fields?: Record<string, HaServiceField>;
  target?: unknown;
}
/** get_services result: { [domain]: { [service]: HaService } }. */
type HaServiceRegistry = Record<string, Record<string, HaService>>;
interface HaAreaEntry {
  area_id: string;
  name: string;
  aliases?: string[];
}
interface HaDeviceEntry {
  id: string;
  area_id: string | null;
}
interface HaEntityEntry {
  entity_id: string;
  device_id: string | null;
  area_id: string | null;
}

/** The in-memory capability cache, rebuilt on every WS connect. */
export interface CapabilityCache {
  services: HaServiceRegistry;
  areas: Map<string, HaAreaEntry>; // area_id → entry
  devices: Map<string, HaDeviceEntry>; // device_id → entry
  /** entity_id → its registry entry (device/area linkage). */
  entities: Map<string, HaEntityEntry>;
}

// ── Admin/system service denylist (ADR 0003) ───────────────────────────────────
// These are excluded from the dynamic catalog: not entity control, and out of V0 scope.
const DENY_DOMAINS = new Set(["hassio", "update", "backup"]);
const DENY_EXACT = new Set([
  "homeassistant.restart",
  "homeassistant.stop",
  "homeassistant.reload_all",
  "homeassistant.reload_core_config",
  "homeassistant.reload_config_entry",
  "homeassistant.reload_custom_templates",
]);

/** True when `<domain>.<service>` is an admin/system service that must NOT appear in the catalog. */
export function isAdminService(domain: string, service: string): boolean {
  if (DENY_DOMAINS.has(domain)) return true;
  const full = `${domain}.${service}`;
  if (DENY_EXACT.has(full)) return true;
  if (service === "reload" || service.startsWith("reload_")) return true; // *.reload, *.reload_*
  if (service.startsWith("set_location")) return true; // homeassistant.set_location (admin)
  return false;
}

/** Parse "home.<domain>.<service>" → { domain, service }. Throws on a malformed id. */
export function parseActionId(actionId: string): { domain: string; service: string } {
  const parts = actionId.split(".");
  if (parts.length !== 3 || parts[0] !== "home" || !parts[1] || !parts[2]) {
    throw new Error(`invalid actionId '${actionId}': expected home.<domain>.<service>`);
  }
  return { domain: parts[1], service: parts[2] };
}

/** The selector keys the agent may pass in params (everything else is service_data). */
const SELECTOR_KEYS = ["area", "domain", "name", "entityId", "entity_id"] as const;

/**
 * Raw HA targeting keys that must NEVER reach service_data. The resolved selector is the ONLY thing
 * allowed to set the call_service target — these would smuggle a target past it, so they are dropped.
 */
const RAW_TARGET_KEYS = new Set(["target", "area_id", "device_id", "label_id"]);

/**
 * #5 freshness: throttle the per-event `last_synced_at` stamp to at most once per this window, per
 * connection, so a high-frequency state_changed stream doesn't amplify into a write per event.
 * (The issue's `freshnessToleranceSec` = 5s; no config knob in V0.)
 */
const MARK_SYNCED_THROTTLE_MS = 5_000;

/** Split invoke params into the selector and the residual service_data. */
export function splitParams(params: Record<string, unknown>): {
  selector: Selector;
  serviceData: Record<string, unknown>;
} {
  const selector: Selector = {};
  const serviceData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    switch (k) {
      case "area":
        selector.area = v as string;
        break;
      case "name":
        selector.name = v as string;
        break;
      case "entityId":
      case "entity_id":
        selector.entityId = v as string;
        break;
      case "domain":
        // `domain` scopes the selector; it is not service_data.
        selector.domain = v as string;
        break;
      default:
        // Drop raw HA targeting keys: only the resolved selector may set the target (no smuggling).
        if (RAW_TARGET_KEYS.has(k)) break;
        serviceData[k] = v;
    }
  }
  return { selector, serviceData };
}

/**
 * The catalog JOIN (pure, testable): the user's cached entities × the cached service registry,
 * gated by supported_features. Produces ActionSpec[] with ids `home.<domain>.<service>`.
 * Admin/system services are dropped. Filterable by area/domain/entity.
 */
export function buildCatalog(
  entities: HomeEntityRow[],
  services: HaServiceRegistry,
  filter?: { area?: string; domain?: string; entityId?: string },
): ActionSpec[] {
  // Which (domain) appear among the (filtered) cached entities, and the union of features per domain.
  const filtered = entities.filter((e) => {
    if (filter?.entityId && e.entity_id !== filter.entityId) return false;
    if (filter?.domain && e.domain !== filter.domain) return false;
    if (filter?.area && (e.area ?? "") !== filter.area) return false;
    return true;
  });

  // Per domain: the set of supported_features bits seen across its entities (so a service whose
  // field requires a feature is offered when ANY entity in that domain supports it).
  const featuresByDomain = new Map<string, number>();
  const presentDomains = new Set<string>();
  for (const e of filtered) {
    presentDomains.add(e.domain);
    const sf = Number((e.attributes?.supported_features as number | undefined) ?? 0);
    featuresByDomain.set(e.domain, (featuresByDomain.get(e.domain) ?? 0) | sf);
  }

  const specs: ActionSpec[] = [];
  for (const domain of presentDomains) {
    const domainServices = services[domain];
    if (!domainServices) continue;
    const domainFeatures = featuresByDomain.get(domain) ?? 0;
    for (const [service, def] of Object.entries(domainServices)) {
      if (isAdminService(domain, service)) continue;
      const params = serviceFields(def, domainFeatures);
      specs.push({
        id: `home.${domain}.${service}`,
        description: def.description ?? `${domain}.${service}`,
        params,
        domain,
        service,
        target: { area: true, entity: true, domain },
      });
    }
  }
  // Stable order so the catalog is deterministic.
  specs.sort((a, b) => a.id.localeCompare(b.id));
  return specs;
}

/** Map an HA service's fields → ActionParams, dropping fields gated by an unsupported feature. */
function serviceFields(def: HaService, domainFeatures: number): ActionSpec["params"] {
  const out: ActionSpec["params"] = [];
  for (const [name, f] of Object.entries(def.fields ?? {})) {
    // supported_features gate: if the field is feature-gated and NONE of its features are present, skip it.
    const need = f.filter?.supported_features;
    if (Array.isArray(need) && need.length > 0) {
      const anySupported = need.some((bit) => (domainFeatures & bit) === bit && bit !== 0);
      if (!anySupported) continue;
    }
    out.push({
      name,
      type: paramType(f),
      required: f.required === true,
      description: f.description,
    });
  }
  return out;
}

/** Coarse type from an HA field selector (we only model string/number/boolean). */
function paramType(f: HaServiceField): "string" | "number" | "boolean" {
  const sel = f.selector as Record<string, unknown> | undefined;
  if (sel) {
    if ("number" in sel) return "number";
    if ("boolean" in sel) return "boolean";
  }
  return "string";
}

/**
 * Map an HA state + the capability cache → a HomeEntityRow.
 * domain = entity_id prefix; area resolved via entity→device→area inheritance; supported_features
 * and attributes preserved in attributes; state + availability.
 */
export function stateToRow(state: HaState, cache?: CapabilityCache): HomeEntityRow {
  const entityId = state.entity_id;
  const domain = entityId.includes(".") ? entityId.slice(0, entityId.indexOf(".")) : entityId;
  const attrs = state.attributes ?? {};
  const raw = state.state;
  const availability =
    raw === "unavailable" || raw === "unknown" ? raw : "online";
  return {
    source_object_id: entityId,
    entity_id: entityId,
    domain,
    area: cache ? resolveArea(entityId, cache) : null,
    state: raw ?? null,
    unit: (attrs["unit_of_measurement"] as string | undefined) ?? null,
    availability,
    state_timestamp: state.last_changed ?? state.last_updated ?? null,
    attributes: attrs,
  };
}

/** Resolve an entity's area via entity→(area_id | device→area_id) inheritance → the area NAME. */
export function resolveArea(entityId: string, cache: CapabilityCache): string | null {
  const ent = cache.entities.get(entityId);
  let areaId: string | null = ent?.area_id ?? null;
  if (!areaId && ent?.device_id) {
    areaId = cache.devices.get(ent.device_id)?.area_id ?? null;
  }
  if (!areaId) return null;
  return cache.areas.get(areaId)?.name ?? areaId;
}

/** Build the capability cache from get_services + the three registry lists. */
export function buildCapabilityCache(
  services: HaServiceRegistry,
  areas: HaAreaEntry[],
  devices: HaDeviceEntry[],
  entities: HaEntityEntry[],
): CapabilityCache {
  return {
    services,
    areas: new Map(areas.map((a) => [a.area_id, a])),
    devices: new Map(devices.map((d) => [d.id, d])),
    entities: new Map(entities.map((e) => [e.entity_id, e])),
  };
}

/** Resolve an area NAME (selector input) back to its area_id for an HA target. */
export function areaNameToId(cache: CapabilityCache, areaName: string): string | undefined {
  const want = areaName.trim().toLowerCase();
  for (const a of cache.areas.values()) {
    if (a.name.trim().toLowerCase() === want) return a.area_id;
    if (a.aliases?.some((al) => al.trim().toLowerCase() === want)) return a.area_id;
  }
  return undefined;
}

/** A live connection's runtime state (WS client + the in-memory capability cache). */
interface Connection {
  ws: HaWsClient;
  cache: CapabilityCache;
  userId: string;
}

/** Home Assistant connector (Phase 1). Long-lived token + WebSocket, local-reaching. Action-rich. */
export class HomeAssistantConnector implements Connector<HomeEntityRow> {
  readonly provider = "home_assistant";
  readonly sector = "home";
  readonly objectType = "home_entity";

  // Push source: self-managed WebSocket; NOT driven by the poll scheduler.
  readonly policy: SyncPolicy = {
    mode: "push",
    pushKind: "stream", // a live WS we hold open — the Console's stream caption vocabulary (#41)
    freshnessToleranceSec: 5,
    supportsIncremental: false,
  };

  // The static array is empty: the action surface is DYNAMIC (served by listActions from the cache).
  readonly actions: ActionSpec[] = [];

  /** Live connections, keyed by connectionId. The capability cache lives here (in-memory). */
  private readonly connections = new Map<string, Connection>();

  /** #5: per-connection last `markSynced` wall-clock (Date.now() ms) — the live-event throttle. */
  private readonly lastMarkMs = new Map<string, number>();

  /**
   * Start the self-managed connection: open the WS, fetch the registries + services → capability
   * cache, get_states → upsert home_entities, then subscribe to state_changed + registry events.
   * Idempotent per connectionId. The token comes from ctx.secret (never logged).
   */
  async start(ctx: SyncContext & { haUrl?: string }): Promise<void> {
    if (this.connections.has(ctx.connectionId)) return;
    const token = ctx.secret;
    if (!token) throw new Error("home assistant: missing token");
    const haUrl = ctx.haUrl ?? process.env.HA_URL;
    if (!haUrl) throw new Error("home assistant: missing haUrl");

    const ws = new HaWsClient({ haUrl, token });
    await ws.connect();

    const cache = await this.fetchCapabilityCache(ws);
    const conn: Connection = { ws, cache, userId: ctx.userId };
    this.connections.set(ctx.connectionId, conn);

    // After a drop + re-auth: re-fetch the capability cache, re-snapshot, reconcile. Failures are
    // swallowed (the next event/reconnect self-heals); never crash the process.
    ws.onReconnect(() => void this.onWsReconnect(ctx.connectionId).catch(() => {}));

    // #39 stream-state honesty: persist every mid-run transition (drop → 'retrying', re-auth →
    // 'connected', terminal auth death → 'down' + status='error'). Wired AFTER connect() resolved,
    // so the INITIAL attempt's outcome stays the bootstrap starter's to report; from here on the
    // client's own reconnect loop — previously invisible (#39, the 2-week outage) — self-reports.
    ws.onUp(() => void this.handleStreamUp(ctx.connectionId).catch(() => {}));
    ws.onDown((reason) => void this.handleStreamDown(ctx.connectionId, reason).catch(() => {}));

    // Initial state snapshot → upsert, then reconcile source removals (ADR 0004).
    await this.snapshotAndReconcile(ctx.connectionId, conn);

    // Stay fresh: state changes + registry updates.
    ws.onEvent((ev) => void this.onEvent(ctx.connectionId, ev).catch(() => {}));
    await ws.subscribe({ event_type: "state_changed" });
    for (const et of [
      "area_registry_updated",
      "device_registry_updated",
      "entity_registry_updated",
      "service_registered",
      "service_removed",
    ]) {
      await ws.subscribe({ event_type: et }).catch(() => {});
    }
  }

  /** Fetch get_services + the three registries and assemble the capability cache. */
  private async fetchCapabilityCache(ws: HaWsClient): Promise<CapabilityCache> {
    const [services, areas, devices, entities] = await Promise.all([
      ws.command("get_services") as Promise<HaServiceRegistry>,
      ws.command("config/area_registry/list") as Promise<HaAreaEntry[]>,
      ws.command("config/device_registry/list") as Promise<HaDeviceEntry[]>,
      ws.command("config/entity_registry/list") as Promise<HaEntityEntry[]>,
    ]);
    return buildCapabilityCache(services, areas, devices, entities);
  }

  /**
   * Fenced snapshot: capture snapshotStartedAt → get_states → upsert every state → reconcile
   * tombstones against get_states ∪ the entity registry (the registry — loaded from storage early
   * in HA boot — protects slow-loading integrations whose states miss an early snapshot). Runs on
   * the initial start() AND after every WS re-auth. A zero-state snapshot SKIPS the reconcile
   * entirely (a fault, never mass-tombstone).
   */
  private async snapshotAndReconcile(connectionId: string, conn: Connection): Promise<void> {
    const snapshotStartedAt = new Date(); // captured immediately BEFORE issuing get_states
    const states = (await conn.ws.command("get_states")) as HaState[];
    for (const s of states) {
      await this.upsertEntity(connectionId, conn.userId, stateToRow(s, conn.cache), s);
    }
    if (states.length === 0) return; // zero states = a fault — never mass-tombstone
    const liveIds = new Set<string>(states.map((s) => s.entity_id));
    for (const id of conn.cache.entities.keys()) liveIds.add(id);
    await this.reconcileSnapshot(connectionId, liveIds, snapshotStartedAt);
    // #5: the first-sync freshness signal (covers start() AND onWsReconnect()) — flips the badge to
    // "Live" and makes describe_context's last_synced_at honest for this push connector.
    await this.markSynced(connectionId);
  }

  /** #39: a (re)established stream → stream_state='connected' (stream_error cleared, status untouched). */
  private async handleStreamUp(connectionId: string): Promise<void> {
    await markStreamState(connectionId, "connected");
  }

  /**
   * #39: the stream went down mid-run. A normal drop enters the client's own reconnect loop →
   * 'retrying' (status untouched — the loop probes every backoff tick). 'auth invalid' is the
   * terminal RE-auth death: the client stays closed forever, so persist 'down' AND flip
   * status='error' via the runner helper — that is what makes the Console offer Reconnect.
   */
  private async handleStreamDown(connectionId: string, reason: string): Promise<void> {
    if (reason === "auth invalid") {
      await markStreamState(connectionId, "down", reason);
      await markError(connectionId, "auth invalid: token revoked mid-run");
      return;
    }
    await markStreamState(connectionId, "retrying", reason);
  }

  /** Re-sync after a WS re-auth: rebuild the capability cache, re-snapshot, reconcile. */
  private async onWsReconnect(connectionId: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.cache = await this.fetchCapabilityCache(conn.ws);
    await this.snapshotAndReconcile(connectionId, conn);
  }

  /**
   * Handle a live event: a state_changed upserts the entity (or tombstones it when new_state is
   * null — the removal signal for non-registry entities like template/MQTT); a registry event
   * refreshes the capability cache, with an entity 'remove' also tombstoning the entity row.
   */
  private async onEvent(
    connectionId: string,
    ev: { event_type: string; data: unknown },
  ): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    if (ev.event_type === "state_changed") {
      const data = ev.data as { entity_id?: string; new_state?: HaState | null };
      if (data?.new_state) {
        await this.upsertEntity(
          connectionId,
          conn.userId,
          stateToRow(data.new_state, conn.cache),
          data.new_state,
        );
        // #5: stamp freshness from the live stream, throttled so high-frequency sensors don't
        // amplify into a connectors write per event.
        await this.markSyncedThrottled(connectionId);
      } else if (data?.entity_id) {
        // new_state:null = the source removed this entity → tombstone (ADR 0004).
        await this.tombstoneEntity(connectionId, data.entity_id);
      }
      return;
    }
    if (ev.event_type === "entity_registry_updated") {
      const data = ev.data as { action?: string; entity_id?: string };
      if (data?.action === "remove" && data.entity_id) {
        // Tombstone IN ADDITION to the capability-cache rebuild below.
        await this.tombstoneEntity(connectionId, data.entity_id);
      }
    }
    // Any registry/service change → rebuild the in-memory capability cache.
    conn.cache = await this.fetchCapabilityCache(conn.ws);
  }

  /**
   * Idempotent upsert of one entity into home_entities (state sync + post-action re-sync).
   * Every live write clears deleted_at — "last writer of a live record resurrects" (ADR 0004 #3),
   * so a wrong or stale tombstone self-heals on the next live sighting.
   */
  private async upsertEntity(
    connectionId: string,
    userId: string,
    row: HomeEntityRow,
    raw: unknown,
  ): Promise<void> {
    // 'union:' is the finance-dedup engine's reserved soid namespace (#37) — this self-managed write
    // path must never plant a row there. Skip-with-warn, NEVER throw: a throw would abort a whole
    // snapshot/stream handler for one poisoned entity (no legit HA entity_id starts with 'union:',
    // and reconcileSnapshot has no 'union:%' exemption, so a planted row is swept regardless).
    if (row.source_object_id.startsWith("union:")) {
      console.warn(`homeassistant: skipping upsert of reserved 'union:'-prefixed entity '${row.source_object_id}'`);
      return;
    }
    await pool.query(
      `insert into home_entities
         (connection_id, user_id, source_object_id, entity_id, domain, area, state, unit,
          availability, state_timestamp, attributes, raw, ingested_at, deleted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), null)
       on conflict (connection_id, source_object_id) do update set
         entity_id = excluded.entity_id, domain = excluded.domain, area = excluded.area,
         state = excluded.state, unit = excluded.unit, availability = excluded.availability,
         state_timestamp = excluded.state_timestamp, attributes = excluded.attributes,
         raw = excluded.raw, ingested_at = excluded.ingested_at, deleted_at = null`,
      [
        connectionId,
        userId,
        row.source_object_id,
        row.entity_id,
        row.domain,
        row.area,
        row.state,
        row.unit,
        row.availability,
        row.state_timestamp,
        row.attributes ? JSON.stringify(row.attributes) : null,
        JSON.stringify(raw),
      ],
    );
  }

  /**
   * Tombstone one entity from a provider removal signal. A dedicated UPDATE, never the upsert
   * (ADR 0004 #4): a deletion stub must not overwrite normalized columns/raw, and an unknown id
   * must not insert a ghost row. `deleted_at is null` preserves an existing tombstone's timestamp.
   */
  private async tombstoneEntity(connectionId: string, entityId: string): Promise<void> {
    // Reserved 'union:' namespace (#37): a removal signal must never tombstone an engine-owned
    // synthetic. Skip-with-warn, NEVER throw (same rationale as upsertEntity above).
    if (entityId.startsWith("union:")) {
      console.warn(`homeassistant: skipping tombstone of reserved 'union:'-prefixed entity '${entityId}'`);
      return;
    }
    await pool.query(
      `update home_entities set deleted_at = now()
        where connection_id = $1 and source_object_id = $2 and deleted_at is null`,
      [connectionId, entityId],
    );
  }

  /**
   * #5 freshness: stamp connectors.last_synced_at = now() for this push connection (and assert the
   * healthy lifecycle — status='active', last_error/last_error_at cleared). HA reaches NEITHER the
   * poll runner NOR the push-ingest webhook (the only other writers of last_synced_at/status), so
   * without this its live cache sits behind a permanently-NULL last_synced_at and describe_context /
   * the Console lie about freshness. Idempotent; on a good snapshot this also subsumes the bootstrap
   * clear-to-active recovery for HA. Mirrors the poll path's runner.ts write-back.
   */
  private async markSynced(connectionId: string): Promise<void> {
    await pool.query(
      `update connectors set last_synced_at = now(), status = 'active', last_error = null,
              last_error_at = null where id = $1 and status in ('active', 'error')`,
      [connectionId],
    );
  }

  /**
   * The live-event variant of markSynced: stamp freshness from a state_changed upsert, THROTTLED to
   * at most once per MARK_SYNCED_THROTTLE_MS per connection (an in-memory last-mark timestamp). The
   * timestamp is recorded BEFORE the await so overlapping events inside the window can't all slip
   * through. Date.now() is fine here — this is product code, not a workflow script.
   */
  private async markSyncedThrottled(connectionId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastMarkMs.get(connectionId) ?? 0) < MARK_SYNCED_THROTTLE_MS) return;
    this.lastMarkMs.set(connectionId, now);
    await this.markSynced(connectionId);
  }

  /**
   * Tombstone every row the snapshot no longer sees: not in liveIds (get_states ∪ the entity
   * registry) AND ingested before the snapshot started (the fence protects rows upserted by
   * events racing the snapshot). Callers skip this entirely on a zero-state snapshot.
   */
  private async reconcileSnapshot(
    connectionId: string,
    liveIds: Set<string>,
    snapshotStartedAt: Date,
  ): Promise<void> {
    await pool.query(
      `update home_entities set deleted_at = now()
        where connection_id = $1 and deleted_at is null and ingested_at < $2
          and not (source_object_id = any($3))`,
      [connectionId, snapshotStartedAt, [...liveIds]],
    );
  }

  // ── Connector contract: sync()/normalize() are unused (push connector, self-managed). ──
  // eslint-disable-next-line require-yield
  async *sync(_ctx: SyncContext): AsyncIterable<RawRecord> {
    // HA is push-mode and self-managed via start(); the poll runner never drives it.
    return;
  }

  normalize(raw: RawRecord): HomeEntityRow {
    return stateToRow(raw.raw as HaState);
  }

  /**
   * The fetch_live {id} drill: ONE get_states over the existing live WS (the WS API has no
   * per-entity read; the client-side filter is intentional — no REST call path). Entity FOUND →
   * upsert (live truth; resurrects per ADR 0004) and return the raw state. Entity ABSENT from the
   * snapshot → tombstone via the dedicated UPDATE (a provider-snapshot deletion signal) and return
   * null — "the source says gone". No live connection → throw (names the condition, never the token).
   */
  async fetchRecordLive(ctx: SyncContext, sourceObjectId: string): Promise<unknown> {
    const conn = this.connections.get(ctx.connectionId);
    if (!conn) {
      throw new Error("home assistant: no live connection for this connection id — cannot fetch live");
    }
    const states = (await conn.ws.command("get_states")) as HaState[];
    const found = states.find((s) => s.entity_id === sourceObjectId);
    if (found) {
      await this.upsertEntity(ctx.connectionId, conn.userId, stateToRow(found, conn.cache), found);
      return found;
    }
    await this.tombstoneEntity(ctx.connectionId, sourceObjectId);
    return null;
  }

  strongKeys(raw: RawRecord): Record<string, string> {
    return { entity_id: raw.externalId };
  }

  /**
   * The DYNAMIC catalog: the user's cached entities × the cached service registry, gated by
   * supported_features, admin/system services dropped. Served from CACHE only — no live HA call.
   */
  async listActions(
    ctx: ActionContext,
    filter?: { area?: string; domain?: string; entityId?: string },
  ): Promise<ActionSpec[]> {
    const conn = this.connections.get(ctx.connectionId);
    const services = conn?.cache.services;
    if (!services) {
      // No live connection / cache yet — nothing to offer (don't reach out to HA on the read path).
      return [];
    }
    const entities = await this.loadCachedEntities(ctx.connectionId, ctx.userId);
    return buildCatalog(entities, services, filter);
  }

  /** Load this user+connection's LIVE cached entities (tombstoned rows are not catalog material). */
  private async loadCachedEntities(connectionId: string, userId: string): Promise<HomeEntityRow[]> {
    const res = await pool.query(
      `select source_object_id, entity_id, domain, area, state, unit, availability,
              state_timestamp, attributes
         from home_entities
        where connection_id = $1 and user_id = $2 and deleted_at is null`,
      [connectionId, userId],
    );
    return res.rows.map((r) => ({
      source_object_id: r.source_object_id,
      entity_id: r.entity_id,
      domain: r.domain,
      area: r.area,
      state: r.state,
      unit: r.unit,
      availability: r.availability,
      state_timestamp: r.state_timestamp,
      attributes: (r.attributes as Record<string, unknown> | null) ?? null,
    }));
  }

  /**
   * SINGLE dispatch, NO retry. Parse the actionId → {domain, service}; resolve the selector from
   * params → target; call_service(domain, service, target, service_data). Then fire an ASYNC
   * targeted re-sync of the affected entities (non-blocking — the agent already has its
   * confirmation).
   *
   * Two kinds of failure, and the detail distinguishes them because the agent's next move differs:
   * a PRE-dispatch failure names its condition (nothing reached HA, so nothing happened), while a
   * throw from the one call_service is genuinely 'unknown — not retried' — we cannot tell whether HA
   * acted before the wire broke, and re-sending could double-act a device (#105 item 2 / #98 item 9).
   */
  async execute(
    actionId: string,
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    const conn = this.connections.get(ctx.connectionId);
    // PRE-dispatch: no live WS for this connection (never started — no instance URL / boot has not
    // reached it yet, in start()-retry backoff, terminal auth death, or paused/revoked/deleted).
    // Nothing was sent, so the outcome is NOT unknown — say so, matching every other pre-dispatch
    // condition here and `fetchRecordLive`'s wording. Never names the token or the URL.
    if (!conn) {
      return {
        ok: false,
        detail: "home assistant: no live connection for this connection id — nothing was dispatched",
      };
    }

    let domain: string;
    let service: string;
    try {
      ({ domain, service } = parseActionId(actionId));
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "invalid action" };
    }

    // Admin/system services are excluded from the catalog AND from dispatch (ADR 0003 — device/entity
    // control only). Enforce the denylist here so a "home"-granted agent cannot invoke them directly.
    if (isAdminService(domain, service)) {
      return { ok: false, detail: "admin/system service not permitted (device/entity control only)" };
    }

    // Resolve the selector against the cache → an HA target (area_id preferred where applicable).
    const { selector, serviceData } = splitParams(params);
    let target: ResolvedTarget;
    try {
      target = await resolveSelector(ctx.userId, ctx.connectionId, selector);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "selector did not resolve" };
    }
    // Map the area NAME the selector returns back to an HA area_id.
    const haTarget = this.toHaTarget(conn.cache, target);

    // ONE dispatch. No auto-retry: any throw → "unknown — not retried".
    let result: unknown;
    try {
      result = await conn.ws.command("call_service", {
        domain,
        service,
        target: haTarget,
        service_data: serviceData,
        return_response: serviceReturnsData(conn.cache, domain, service),
      });
    } catch {
      // Never include the token; never retry.
      return { ok: false, detail: "unknown — not retried" };
    }

    // Async targeted re-sync of the affected entities — non-blocking.
    void this.resyncTargets(ctx.connectionId, conn, haTarget).catch(() => {});

    return { ok: true, detail: result ?? null };
  }

  /** Translate the selector's ResolvedTarget (area NAME) into an HA target (area_id). */
  private toHaTarget(cache: CapabilityCache, target: ResolvedTarget): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (target.area_id) {
      const id = areaNameToId(cache, target.area_id) ?? target.area_id;
      out.area_id = id;
    }
    if (target.entity_id && target.entity_id.length > 0) out.entity_id = target.entity_id;
    return out;
  }

  /** Re-fetch the affected entities' state → upsert (post-action reconciliation). */
  private async resyncTargets(
    connectionId: string,
    conn: Connection,
    haTarget: Record<string, unknown>,
  ): Promise<void> {
    const states = (await conn.ws.command("get_states")) as HaState[];
    const wantEntities = new Set((haTarget.entity_id as string[] | undefined) ?? []);
    const wantArea = haTarget.area_id as string | undefined;
    for (const s of states) {
      const row = stateToRow(s, conn.cache);
      const matchEntity = wantEntities.has(s.entity_id);
      const matchArea =
        wantArea != null && row.area != null &&
        (conn.cache.areas.get(wantArea)?.name === row.area || wantArea === row.area);
      if (matchEntity || matchArea) {
        await this.upsertEntity(connectionId, conn.userId, row, s);
      }
    }
  }

  /** Inject a live connection (tests / a bootstrap that already opened a WS). */
  registerConnection(connectionId: string, ws: HaWsClient, cache: CapabilityCache, userId: string): void {
    this.connections.set(connectionId, { ws, cache, userId });
  }

  /** Close + drop a connection (and stop its WS). */
  stop(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    conn?.ws.close();
    this.connections.delete(connectionId);
  }
}

/** True when the service declares a response (so call_service should set return_response). */
function serviceReturnsData(cache: CapabilityCache, domain: string, service: string): boolean {
  const def = cache.services[domain]?.[service] as (HaService & { response?: unknown }) | undefined;
  return def != null && (def as { response?: unknown }).response != null;
}
