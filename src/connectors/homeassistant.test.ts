// Home Assistant connector tests.
//   * catalog join (pure): cached entities × the service registry, supported_features gating,
//     admin/system exclusion, area/domain/entity filtering.
//   * dispatch (mocked WS + mocked selector): the correct call_service is built, ok:true from a
//     stubbed response, EXACTLY ONE dispatch (no retry on failure), and an async re-sync is fired.
//   * state→row mapping and area inheritance.
//   * removals (ADR 0004, mocked pool): state_changed→null and registry 'remove' issue the
//     dedicated tombstone UPDATE; live writes carry the resurrect; the reconnect path re-fetches
//     the cache, re-snapshots, and reconciles with the states ∪ registry union + zero-state guard.
//     (Real-SQL behavior is verified in homeassistant.db.test.ts.)

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the shared pool so upserts/queries are inert and observable.
const query = vi.fn(async () => ({ rows: [] as unknown[] }));
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => (query as (...x: unknown[]) => unknown)(...a) } }));

// Mock the selector so the dispatch test controls the resolved target deterministically.
const resolveSelector = vi.fn();
vi.mock("../core/selector.js", () => ({
  resolveSelector: (...a: unknown[]) => (resolveSelector as (...x: unknown[]) => unknown)(...a),
}));

const {
  HomeAssistantConnector,
  buildCatalog,
  buildCapabilityCache,
  stateToRow,
  resolveArea,
  isAdminService,
  parseActionId,
  splitParams,
} = await import("./homeassistant.js");

import type { HomeEntityRow, CapabilityCache } from "./homeassistant.js";

// ── A representative service registry (the shape get_services returns) ──────────
const SERVICES = {
  light: {
    turn_on: {
      description: "Turn on a light",
      fields: {
        brightness: { description: "0-255", selector: { number: {} }, filter: { supported_features: [1] } },
        rgb_color: { description: "color", selector: { object: {} }, filter: { supported_features: [16] } },
        transition: { description: "fade", selector: { number: {} } },
      },
    },
    turn_off: { description: "Turn off a light", fields: {} },
  },
  lock: {
    lock: { description: "Lock", fields: {} },
    unlock: { description: "Unlock", fields: {} },
  },
  scene: {
    turn_on: { description: "Activate a scene", fields: {} },
    reload: { description: "Reload scenes (admin)", fields: {} },
  },
  homeassistant: {
    restart: { description: "Restart HA (admin)", fields: {} },
    stop: { description: "Stop HA (admin)", fields: {} },
    turn_on: { description: "Generic turn_on", fields: {} },
  },
  hassio: {
    host_reboot: { description: "Reboot host (admin)", fields: {} },
  },
};

// ── Cached entities: a feature-rich light, a lock, a scene ──────────────────────
const ENTITIES: HomeEntityRow[] = [
  {
    source_object_id: "light.kitchen",
    entity_id: "light.kitchen",
    domain: "light",
    area: "Kitchen",
    state: "on",
    unit: null,
    availability: "online",
    state_timestamp: null,
    // supported_features 1|16 = 17 (brightness + color).
    attributes: { supported_features: 17, friendly_name: "Kitchen Light" },
  },
  {
    source_object_id: "lock.front",
    entity_id: "lock.front",
    domain: "lock",
    area: "Entry",
    state: "locked",
    unit: null,
    availability: "online",
    state_timestamp: null,
    attributes: { supported_features: 0 },
  },
  {
    source_object_id: "scene.movie_night",
    entity_id: "scene.movie_night",
    domain: "scene",
    area: null,
    state: "scening",
    unit: null,
    availability: "online",
    state_timestamp: null,
    attributes: {},
  },
];

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  resolveSelector.mockReset();
});

describe("policy declaration (#41)", () => {
  it("declares a push-STREAM policy — the served push_kind / caption vocabulary word", () => {
    const conn = new HomeAssistantConnector();
    expect(conn.policy.mode).toBe("push");
    expect(conn.policy.pushKind).toBe("stream"); // a live WS we hold open — never "Device controlled"
  });
});

describe("buildCatalog — the dynamic join", () => {
  it("offers light.turn_on (with brightness+color), lock.lock/unlock, scene.turn_on", () => {
    const catalog = buildCatalog(ENTITIES, SERVICES as never);
    const ids = catalog.map((a) => a.id);

    expect(ids).toContain("home.light.turn_on");
    expect(ids).toContain("home.light.turn_off");
    expect(ids).toContain("home.lock.lock");
    expect(ids).toContain("home.lock.unlock");
    expect(ids).toContain("home.scene.turn_on");

    const turnOn = catalog.find((a) => a.id === "home.light.turn_on")!;
    const paramNames = turnOn.params.map((p) => p.name);
    // feature 1 (brightness) + feature 16 (color) are present → both fields offered; transition is ungated.
    expect(paramNames).toContain("brightness");
    expect(paramNames).toContain("rgb_color");
    expect(paramNames).toContain("transition");
    expect(turnOn.domain).toBe("light");
    expect(turnOn.service).toBe("turn_on");
  });

  it("EXCLUDES admin/system services (homeassistant.restart/stop, hassio.*, *.reload)", () => {
    const ids = buildCatalog(ENTITIES, SERVICES as never).map((a) => a.id);
    expect(ids).not.toContain("home.homeassistant.restart");
    expect(ids).not.toContain("home.homeassistant.stop");
    expect(ids).not.toContain("home.hassio.host_reboot");
    expect(ids).not.toContain("home.scene.reload");
  });

  it("gates a feature-only field out when no entity supports it", () => {
    // A light with supported_features 1 (brightness only, no color bit 16).
    const dimOnly: HomeEntityRow[] = [{ ...ENTITIES[0], attributes: { supported_features: 1 } }];
    const turnOn = buildCatalog(dimOnly, SERVICES as never).find((a) => a.id === "home.light.turn_on")!;
    const names = turnOn.params.map((p) => p.name);
    expect(names).toContain("brightness");
    expect(names).not.toContain("rgb_color"); // color feature absent
    expect(names).toContain("transition"); // ungated field stays
  });

  it("filters by domain", () => {
    const ids = buildCatalog(ENTITIES, SERVICES as never, { domain: "lock" }).map((a) => a.id);
    expect(ids).toEqual(["home.lock.lock", "home.lock.unlock"]);
  });

  it("filters by entityId", () => {
    const ids = buildCatalog(ENTITIES, SERVICES as never, { entityId: "scene.movie_night" }).map((a) => a.id);
    expect(ids).toEqual(["home.scene.turn_on"]);
  });

  it("filters by area", () => {
    const ids = buildCatalog(ENTITIES, SERVICES as never, { area: "Entry" }).map((a) => a.id);
    expect(ids).toEqual(["home.lock.lock", "home.lock.unlock"]);
  });
});

describe("isAdminService", () => {
  it("denies the admin set, allows real control services", () => {
    expect(isAdminService("homeassistant", "restart")).toBe(true);
    expect(isAdminService("homeassistant", "stop")).toBe(true);
    expect(isAdminService("hassio", "host_reboot")).toBe(true);
    expect(isAdminService("scene", "reload")).toBe(true);
    expect(isAdminService("automation", "reload")).toBe(true);
    expect(isAdminService("light", "turn_on")).toBe(false);
    expect(isAdminService("scene", "turn_on")).toBe(false);
    expect(isAdminService("automation", "trigger")).toBe(false);
  });
});

describe("parseActionId / splitParams", () => {
  it("parses home.<domain>.<service>", () => {
    expect(parseActionId("home.light.turn_on")).toEqual({ domain: "light", service: "turn_on" });
    expect(() => parseActionId("light.turn_on")).toThrow();
    expect(() => parseActionId("home.light")).toThrow();
  });

  it("splits selector keys from service_data", () => {
    const { selector, serviceData } = splitParams({
      area: "kitchen",
      domain: "light",
      brightness: 128,
      transition: 2,
    });
    expect(selector).toEqual({ area: "kitchen", domain: "light" });
    expect(serviceData).toEqual({ brightness: 128, transition: 2 });
  });
});

describe("stateToRow / resolveArea", () => {
  it("maps an HA state → a HomeEntityRow (domain from prefix, attributes preserved)", () => {
    const row = stateToRow({
      entity_id: "light.kitchen",
      state: "on",
      attributes: { brightness: 200, unit_of_measurement: "%", supported_features: 17 },
      last_changed: "2026-06-06T00:00:00Z",
    });
    expect(row.domain).toBe("light");
    expect(row.state).toBe("on");
    expect(row.unit).toBe("%");
    expect(row.availability).toBe("online");
    expect(row.attributes?.supported_features).toBe(17);
    expect(row.state_timestamp).toBe("2026-06-06T00:00:00Z");
  });

  it("maps unavailable/unknown to availability", () => {
    expect(stateToRow({ entity_id: "x.y", state: "unavailable", attributes: {} }).availability).toBe("unavailable");
    expect(stateToRow({ entity_id: "x.y", state: "unknown", attributes: {} }).availability).toBe("unknown");
  });

  it("resolves area via entity→device→area inheritance", () => {
    const cache: CapabilityCache = buildCapabilityCache(
      {},
      [{ area_id: "kitchen", name: "Kitchen" }],
      [{ id: "dev1", area_id: "kitchen" }],
      [{ entity_id: "light.k", device_id: "dev1", area_id: null }],
    );
    expect(resolveArea("light.k", cache)).toBe("Kitchen");
    // direct entity area_id wins over the device's
    const cache2: CapabilityCache = buildCapabilityCache(
      {},
      [{ area_id: "den", name: "Den" }],
      [{ id: "dev1", area_id: "kitchen" }],
      [{ entity_id: "light.k", device_id: "dev1", area_id: "den" }],
    );
    expect(resolveArea("light.k", cache2)).toBe("Den");
  });
});

// ── Dispatch: a fake WS injected via registerConnection ─────────────────────────
function fakeWs(opts: { onCall?: (fields: Record<string, unknown>) => unknown; throwOnCall?: boolean }) {
  const calls: { type: string; fields: Record<string, unknown> }[] = [];
  return {
    calls,
    command: vi.fn(async (type: string, fields: Record<string, unknown> = {}) => {
      calls.push({ type, fields });
      if (type === "call_service") {
        if (opts.throwOnCall) throw new Error("ws boom");
        return opts.onCall ? opts.onCall(fields) : { context: { id: "ctx-1" } };
      }
      if (type === "get_states") return []; // re-sync fetch
      return [];
    }),
    close: vi.fn(),
  };
}

function cacheWith(areas: { area_id: string; name: string }[] = [{ area_id: "kitchen", name: "Kitchen" }]): CapabilityCache {
  return buildCapabilityCache(SERVICES as never, areas, [], []);
}

const CTX = { userId: "u1", connectionId: "c1", secretRef: null as string | null };

describe("execute — single dispatch, no retry, async re-sync", () => {
  it("builds the correct call_service from a selector + service_data and returns ok:true", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWs({ onCall: () => ({ context: { id: "ctx-9" } }) });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    resolveSelector.mockResolvedValue({ area_id: "Kitchen", entity_id: ["light.kitchen"] });

    const res = await conn.execute("home.light.turn_on", { area: "kitchen", brightness: 128 }, CTX);

    expect(res.ok).toBe(true);
    const call = ws.calls.find((c) => c.type === "call_service")!;
    expect(call.fields.domain).toBe("light");
    expect(call.fields.service).toBe("turn_on");
    // area name → area_id; entity list preserved.
    expect((call.fields.target as Record<string, unknown>).area_id).toBe("kitchen");
    expect((call.fields.target as Record<string, unknown>).entity_id).toEqual(["light.kitchen"]);
    // selector keys stripped from service_data; the real data passed through.
    expect(call.fields.service_data).toEqual({ brightness: 128 });
  });

  it("dispatches EXACTLY ONCE and does NOT retry on failure → ok:false 'unknown — not retried'", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWs({ throwOnCall: true });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");
    resolveSelector.mockResolvedValue({ entity_id: ["light.kitchen"] });

    const res = await conn.execute("home.light.turn_on", { entityId: "light.kitchen" }, CTX);

    expect(res.ok).toBe(false);
    expect(res.detail).toBe("unknown — not retried");
    const callServiceCount = ws.calls.filter((c) => c.type === "call_service").length;
    expect(callServiceCount).toBe(1); // exactly one dispatch, no retry
  });

  it("a selector that does not resolve → ok:false, never dispatches", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWs({});
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");
    resolveSelector.mockRejectedValue(new Error("selector: no entity matches"));

    const res = await conn.execute("home.light.turn_on", { area: "garage" }, CTX);
    expect(res.ok).toBe(false);
    expect(ws.calls.filter((c) => c.type === "call_service").length).toBe(0);
  });

  it("fires an async targeted re-sync (a get_states) after a successful dispatch", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWs({ onCall: () => ({ ok: true }) });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");
    resolveSelector.mockResolvedValue({ entity_id: ["light.kitchen"] });

    await conn.execute("home.light.turn_on", { entityId: "light.kitchen" }, CTX);
    // let the non-blocking re-sync microtask run
    await new Promise((r) => setTimeout(r, 0));

    const getStates = ws.calls.filter((c) => c.type === "get_states").length;
    expect(getStates).toBeGreaterThanOrEqual(1);
  });

  // #105 item 2 / #98 item 9: this pre-dispatch failure used to answer 'unknown — not retried',
  // which tells an agent "the gateway does not know what happened" when it actually means "nothing
  // was sent". Nothing keys off the string (core/actions.ts names its own conditions the same way),
  // so this is a display change — the ok:false contract and the no-dispatch behaviour are unchanged.
  it("no live connection → ok:false (never throws), NAMING the condition instead of 'unknown'", async () => {
    const conn = new HomeAssistantConnector();
    const res = await conn.execute("home.light.turn_on", { entityId: "light.kitchen" }, CTX);
    expect(res.ok).toBe(false);
    expect(res.detail).toBe(
      "home assistant: no live connection for this connection id — nothing was dispatched",
    );
    // The whole point: it must NOT claim the outcome is unknown, because nothing reached HA. That
    // wording is reserved for a throw from the one call_service, where the outcome really is unknown.
    expect(String(res.detail)).not.toContain("unknown");
    // …and it still leaks nothing: no token, no HA address.
    expect(String(res.detail)).not.toMatch(/tok|http/i);
  });
});

// ── FIX 1 (HIGH): admin/system services must be excluded from DISPATCH, not just the catalog. ──
describe("execute — admin/system denylist enforced on dispatch", () => {
  it.each([
    "home.homeassistant.restart",
    "home.hassio.host_reboot",
    "home.scene.reload",
  ])("denies %s → ok:false and NEVER calls call_service", async (actionId) => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWs({});
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");
    // A resolvable selector — proving the denial happens BEFORE selector/dispatch, not because of it.
    resolveSelector.mockResolvedValue({ entity_id: ["scene.movie_night"] });

    const res = await conn.execute(actionId, { entityId: "scene.movie_night" }, CTX);

    expect(res.ok).toBe(false);
    expect(res.detail).toBe("admin/system service not permitted (device/entity control only)");
    // The live dispatch must never fire for an admin/system service.
    expect(ws.calls.filter((c) => c.type === "call_service").length).toBe(0);
  });
});

// ── FIX 2 (MEDIUM): raw HA targeting keys must not smuggle a target past the resolved selector. ──
describe("execute — raw targeting keys are stripped from service_data", () => {
  it("drops area_id/device_id/label_id/target; the target comes only from the resolved selector", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWs({ onCall: () => ({ ok: true }) });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");
    // The resolved selector is the ONLY source of the target.
    resolveSelector.mockResolvedValue({ entity_id: ["light.kitchen"] });

    const res = await conn.execute(
      "home.light.turn_on",
      {
        entityId: "light.kitchen",
        brightness: 128,
        // Raw HA targeting keys an agent might try to smuggle:
        area_id: "garage",
        device_id: "dev-evil",
        label_id: "label-evil",
        target: { entity_id: ["lock.front"] },
      },
      CTX,
    );

    expect(res.ok).toBe(true);
    const call = ws.calls.find((c) => c.type === "call_service")!;
    // service_data carries ONLY the real service data — none of the raw targeting keys leak through.
    expect(call.fields.service_data).toEqual({ brightness: 128 });
    const sd = call.fields.service_data as Record<string, unknown>;
    expect(sd).not.toHaveProperty("area_id");
    expect(sd).not.toHaveProperty("device_id");
    expect(sd).not.toHaveProperty("label_id");
    expect(sd).not.toHaveProperty("target");
    // The target is exactly what the resolved selector produced (no smuggled garage/lock).
    expect(call.fields.target).toEqual({ entity_id: ["light.kitchen"] });
  });
});

// ── Removals (ADR 0004) — tombstone writes, resurrect, and the reconnect path ───
/** The connector's private write/read paths the removal tests drive directly. */
interface HaPrivate {
  onEvent(connectionId: string, ev: { event_type: string; data: unknown }): Promise<void>;
  onWsReconnect(connectionId: string): Promise<void>;
}

/** A fake WS rich enough for the reconnect path (capability-cache commands + get_states). */
function fakeWsSnapshot(opts: { states?: unknown[]; registryEntities?: unknown[] }) {
  const calls: { type: string; fields: Record<string, unknown> }[] = [];
  return {
    calls,
    command: vi.fn(async (type: string, fields: Record<string, unknown> = {}) => {
      calls.push({ type, fields });
      if (type === "get_states") return opts.states ?? [];
      if (type === "get_services") return {};
      if (type === "config/area_registry/list") return [];
      if (type === "config/device_registry/list") return [];
      if (type === "config/entity_registry/list") return opts.registryEntities ?? [];
      return [];
    }),
    close: vi.fn(),
  };
}

/** The mocked pool's calls as { sql, params } for SQL-level assertions. */
function sqlCalls(): { sql: string; params: unknown[] }[] {
  return query.mock.calls.map((c: unknown[]) => ({
    sql: String(c[0]),
    params: (c[1] as unknown[]) ?? [],
  }));
}

const isTombstone = (c: { sql: string }) =>
  /update home_entities set deleted_at = now\(\)/.test(c.sql) && c.sql.includes("source_object_id = $2");
const isReconcile = (c: { sql: string }) =>
  /update home_entities set deleted_at = now\(\)/.test(c.sql) && c.sql.includes("any($3)");
const isUpsert = (c: { sql: string }) => /insert into home_entities/.test(c.sql);

describe("onEvent — removal signals tombstone (ADR 0004)", () => {
  it("state_changed with new_state:null issues the dedicated tombstone UPDATE, never the upsert", async () => {
    const conn = new HomeAssistantConnector();
    conn.registerConnection("c1", fakeWsSnapshot({}) as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onEvent("c1", {
      event_type: "state_changed",
      data: { entity_id: "light.gone", new_state: null },
    });

    const calls = sqlCalls();
    const tombstones = calls.filter(isTombstone);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].params).toEqual(["c1", "light.gone"]);
    expect(tombstones[0].sql).toContain("deleted_at is null"); // preserves an existing timestamp
    expect(calls.filter(isUpsert)).toHaveLength(0); // a deletion stub never inserts a ghost row
  });

  it("a later state_changed WITH a state writes the resurrecting upsert (deleted_at = null, both arms)", async () => {
    const conn = new HomeAssistantConnector();
    conn.registerConnection("c1", fakeWsSnapshot({}) as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onEvent("c1", {
      event_type: "state_changed",
      data: { entity_id: "light.gone", new_state: { entity_id: "light.gone", state: "on", attributes: {} } },
    });

    const upserts = sqlCalls().filter(isUpsert);
    expect(upserts).toHaveLength(1);
    // INSERT arm carries the literal null; the conflict arm clears it on every live write.
    expect(upserts[0].sql).toMatch(/now\(\), null/);
    expect(upserts[0].sql).toMatch(/deleted_at = null/);
  });

  it("entity_registry_updated action:'remove' tombstones AND still rebuilds the capability cache", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({});
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onEvent("c1", {
      event_type: "entity_registry_updated",
      data: { action: "remove", entity_id: "lock.front" },
    });

    const tombstones = sqlCalls().filter(isTombstone);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].params).toEqual(["c1", "lock.front"]);
    // The existing registry-event behavior is preserved: the cache is re-fetched.
    expect(ws.calls.map((c) => c.type)).toContain("get_services");
    expect(ws.calls.map((c) => c.type)).toContain("config/entity_registry/list");
  });

  it("entity_registry_updated with a non-remove action rebuilds the cache WITHOUT tombstoning", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({});
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onEvent("c1", {
      event_type: "entity_registry_updated",
      data: { action: "update", entity_id: "lock.front" },
    });

    expect(sqlCalls().filter(isTombstone)).toHaveLength(0);
    expect(ws.calls.map((c) => c.type)).toContain("get_services");
  });
});

describe("onWsReconnect — re-fetch the cache, re-snapshot, reconcile", () => {
  it("upserts the snapshot and reconciles against states ∪ registry with the time fence", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({
      states: [{ entity_id: "light.kitchen", state: "on", attributes: {} }],
      // In the registry but missing from the state snapshot (a slow-loading integration).
      registryEntities: [{ entity_id: "sensor.slow", device_id: null, area_id: null }],
    });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");
    const before = new Date();

    await (conn as unknown as HaPrivate).onWsReconnect("c1");

    // The capability cache was re-fetched and the snapshot re-pulled.
    const types = ws.calls.map((c) => c.type);
    expect(types).toContain("get_services");
    expect(types).toContain("config/entity_registry/list");
    expect(types).toContain("get_states");

    const calls = sqlCalls();
    expect(calls.filter(isUpsert)).toHaveLength(1); // the one live state
    const reconciles = calls.filter(isReconcile);
    expect(reconciles).toHaveLength(1);
    const [connectionId, fence, liveIds] = reconciles[0].params as [string, Date, string[]];
    expect(connectionId).toBe("c1");
    // The fence was captured immediately before get_states (a real timestamp, not a string).
    expect(fence).toBeInstanceOf(Date);
    expect(fence.getTime()).toBeGreaterThanOrEqual(before.getTime());
    // The union: the snapshot's states AND the registry's ids both count as live.
    expect(liveIds).toContain("light.kitchen");
    expect(liveIds).toContain("sensor.slow");
    // Guards in the SQL itself: never re-stamp a tombstone, never cross the fence.
    expect(reconciles[0].sql).toContain("deleted_at is null");
    expect(reconciles[0].sql).toContain("ingested_at < $2");
  });

  it("a zero-state snapshot SKIPS the reconcile entirely (a fault, never mass-tombstone)", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({
      states: [],
      registryEntities: [{ entity_id: "sensor.slow", device_id: null, area_id: null }],
    });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onWsReconnect("c1");

    expect(sqlCalls().filter(isReconcile)).toHaveLength(0);
    expect(sqlCalls().filter(isUpsert)).toHaveLength(0);
  });

  it("no registered connection → a no-op (never throws)", async () => {
    const conn = new HomeAssistantConnector();
    await (conn as unknown as HaPrivate).onWsReconnect("c-unknown");
    expect(sqlCalls()).toHaveLength(0);
  });
});

// ── #5 freshness: markSynced stamps connectors.last_synced_at on snapshot + throttled on events ──
const isMarkSynced = (c: { sql: string }) =>
  /update connectors set last_synced_at = now\(\)/.test(c.sql);

describe("markSynced — freshness stamping (#5)", () => {
  const stateChanged = {
    event_type: "state_changed",
    data: {
      entity_id: "light.kitchen",
      new_state: { entity_id: "light.kitchen", state: "on", attributes: {} },
    },
  };

  it("stamps connectors.last_synced_at (status='active', errors cleared) on a snapshot", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({ states: [{ entity_id: "light.kitchen", state: "on", attributes: {} }] });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onWsReconnect("c1");

    const marks = sqlCalls().filter(isMarkSynced);
    expect(marks).toHaveLength(1); // the first-sync signal fired once on the snapshot
    expect(marks[0].params).toEqual(["c1"]);
    expect(marks[0].sql).toContain("status = 'active'");
    expect(marks[0].sql).toContain("last_error = null");
    expect(marks[0].sql).toContain("last_error_at = null");
  });

  it("markSynced is guarded to active/error — cannot resurrect a paused/revoked connection", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({ states: [{ entity_id: "light.kitchen", state: "on", attributes: {} }] });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onWsReconnect("c1");

    const marks = sqlCalls().filter(isMarkSynced);
    expect(marks).toHaveLength(1);
    // The WHERE carries the status guard: an in-flight onEvent racing a pause/revoke can never
    // flip a 'paused'/'revoked' row back to false-healthy 'active' (mirrors bootstrap.ts).
    expect(marks[0].sql).toMatch(/status in \('active',\s*'error'\)/);
    // …while still doing its job: stamping freshness.
    expect(marks[0].sql).toMatch(/last_synced_at = now\(\)/);
  });

  it("does NOT stamp last_synced_at on a zero-state snapshot (a fault, never claim fresh)", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({ states: [] });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    await (conn as unknown as HaPrivate).onWsReconnect("c1");

    expect(sqlCalls().filter(isMarkSynced)).toHaveLength(0);
  });

  it("throttles markSynced to at most once per 5s across rapid state_changed events", async () => {
    const conn = new HomeAssistantConnector();
    conn.registerConnection("c1", fakeWsSnapshot({}) as never, cacheWith(), "u1");
    const nowSpy = vi.spyOn(Date, "now");
    const T0 = 1_700_000_000_000; // a realistic epoch ms so the (?? 0) default always fires first

    // t=T0: first live event stamps (T0 - 0 ≫ 5s).
    nowSpy.mockReturnValue(T0);
    await (conn as unknown as HaPrivate).onEvent("c1", stateChanged);
    // t=T0+1000 and t=T0+4999: inside the 5s window → throttled (no extra stamp).
    nowSpy.mockReturnValue(T0 + 1_000);
    await (conn as unknown as HaPrivate).onEvent("c1", stateChanged);
    nowSpy.mockReturnValue(T0 + 4_999);
    await (conn as unknown as HaPrivate).onEvent("c1", stateChanged);
    expect(sqlCalls().filter(isMarkSynced)).toHaveLength(1);

    // t=T0+5000: window elapsed → a second stamp fires.
    nowSpy.mockReturnValue(T0 + 5_000);
    await (conn as unknown as HaPrivate).onEvent("c1", stateChanged);
    expect(sqlCalls().filter(isMarkSynced)).toHaveLength(2);

    // Every state_changed still upserts the entity regardless of the freshness throttle.
    expect(sqlCalls().filter(isUpsert).length).toBe(4);
    nowSpy.mockRestore();
  });

  it("throttles per connection independently", async () => {
    const conn = new HomeAssistantConnector();
    conn.registerConnection("c1", fakeWsSnapshot({}) as never, cacheWith(), "u1");
    conn.registerConnection("c2", fakeWsSnapshot({}) as never, cacheWith(), "u1");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await (conn as unknown as HaPrivate).onEvent("c1", stateChanged);
    await (conn as unknown as HaPrivate).onEvent("c2", stateChanged);

    const marks = sqlCalls().filter(isMarkSynced);
    expect(marks).toHaveLength(2); // c1 and c2 each stamp once — separate throttle windows
    expect(marks.map((m) => m.params[0]).sort()).toEqual(["c1", "c2"]);
    nowSpy.mockRestore();
  });
});

// ── fetchRecordLive — the fetch_live {id} drill (Wave 5) ────────────────────────
describe("fetchRecordLive — one get_states, upsert-or-tombstone", () => {
  const SCTX = { userId: "u1", connectionId: "c1", secretRef: null as string | null, secret: "tok-live" };

  it("a live entity returns the raw state AND writes the resurrecting upsert (deleted_at cleared)", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({
      states: [
        { entity_id: "light.kitchen", state: "on", attributes: { brightness: 100 } },
        { entity_id: "lock.front", state: "locked", attributes: {} },
      ],
    });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    const out = await conn.fetchRecordLive(SCTX, "light.kitchen");

    // The raw provider payload, client-side filtered from ONE get_states (no per-entity read exists).
    expect(out).toMatchObject({ entity_id: "light.kitchen", state: "on" });
    expect(ws.calls.filter((c) => c.type === "get_states")).toHaveLength(1);

    // Live truth lands in the cache: exactly one upsert (the found entity only), resurrect arms intact.
    const upserts = sqlCalls().filter(isUpsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].params).toContain("light.kitchen");
    expect(upserts[0].sql).toMatch(/now\(\), null/); // INSERT arm: deleted_at null
    expect(upserts[0].sql).toMatch(/deleted_at = null/); // conflict arm: every live write resurrects
    expect(sqlCalls().filter(isTombstone)).toHaveLength(0);
  });

  it("an entity ABSENT from the snapshot is tombstoned and null is returned ('the source says gone')", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWsSnapshot({
      states: [{ entity_id: "light.kitchen", state: "on", attributes: {} }],
    });
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");

    const out = await conn.fetchRecordLive(SCTX, "light.gone");

    expect(out).toBeNull();
    const tombstones = sqlCalls().filter(isTombstone);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].params).toEqual(["c1", "light.gone"]);
    // The dedicated UPDATE, never the upsert — a deletion never inserts a ghost row (ADR 0004 #4).
    expect(sqlCalls().filter(isUpsert)).toHaveLength(0);
  });

  it("no live WS connection -> throws naming the condition, NEVER the token", async () => {
    const conn = new HomeAssistantConnector();
    const err = await conn
      .fetchRecordLive({ ...SCTX, secret: "super-secret-token" }, "light.kitchen")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("no live connection");
    expect((err as Error).message).not.toContain("super-secret-token");
    expect(sqlCalls()).toHaveLength(0); // no write on the failure path
  });
});

describe("listActions — cache-only", () => {
  it("returns [] when no live connection/cache exists (no live HA call)", async () => {
    const conn = new HomeAssistantConnector();
    const out = await conn.listActions(CTX);
    expect(out).toEqual([]);
  });

  it("serves the join from the cache + the DB-loaded entities", async () => {
    const conn = new HomeAssistantConnector();
    const ws = fakeWs({});
    conn.registerConnection("c1", ws as never, cacheWith(), "u1");
    // The connector loads cached entities from the DB (mocked pool).
    query.mockResolvedValueOnce({
      rows: ENTITIES.map((e) => ({ ...e })),
    });
    const out = await conn.listActions(CTX);
    const ids = out.map((a) => a.id);
    expect(ids).toContain("home.light.turn_on");
    expect(ids).toContain("home.lock.lock");
    // it served from cache: no call_service / get_states hit the WS during listActions.
    expect(ws.calls.length).toBe(0);
  });
});
