// Round-trips gated on env so CI stays green:
//   * DATABASE_URL: a real home_entities upsert + a selector read against Postgres, plus the
//     tombstone semantics (ADR 0004): removal-event tombstones, resurrect-on-upsert, the snapshot
//     reconcile (union/fence/zero-state guards), and the action-path filters.
//   * HA_URL + HA_TOKEN: a live Home Assistant WS connect → capability cache + a get_states upsert.
// All skip cleanly when their env is absent (the headline behaviors are covered DB-free elsewhere).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { lockTestResource } from "../test-support/advisory-lock.js";

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_HA = !!process.env.HA_URL && !!process.env.HA_TOKEN;
const SEED_USER = "00000000-0000-0000-0000-000000000001";

// One pool teardown for the whole file (the describes share the module-level pool).
afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

/** Create a credential + connector pair for one describe's rows; returns ids for cleanup. */
async function createConnection(): Promise<{ credentialId: string; connectionId: string }> {
  const { pool } = await import("../db.js");
  const cred = await pool.query(
    `insert into provider_credentials (user_id, provider, custody)
     values ($1, 'home_assistant', 'static_token') returning id`,
    [SEED_USER],
  );
  const credentialId = cred.rows[0].id as string;
  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status)
     values ($1, $2, 'home', 'home_assistant', 'active') returning id`,
    [SEED_USER, credentialId],
  );
  return { credentialId, connectionId: conn.rows[0].id as string };
}

describe.skipIf(!HAS_DB)("home_entities DB round-trip + selector", () => {
  let connectionId: string;
  let credentialId: string;

  beforeAll(async () => {
    ({ credentialId, connectionId } = await createConnection());
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
  });

  it("upserts entities and resolveSelector reads them back from the cache", async () => {
    const { pool } = await import("../db.js");
    const { resolveSelector } = await import("../core/selector.js");

    const rows = [
      { eid: "light.kitchen", domain: "light", area: "Kitchen", state: "on", fn: "Kitchen Light" },
      { eid: "lock.front", domain: "lock", area: "Entry", state: "locked", fn: "Front Door" },
    ];
    for (const r of rows) {
      await pool.query(
        `insert into home_entities
           (connection_id, user_id, source_object_id, entity_id, domain, area, state, availability, attributes, raw)
         values ($1,$2,$3,$3,$4,$5,$6,'online',$7,'{}')
         on conflict (connection_id, source_object_id) do update set state = excluded.state`,
        [connectionId, SEED_USER, r.eid, r.domain, r.area, r.state, JSON.stringify({ friendly_name: r.fn })],
      );
    }

    const byEntity = await resolveSelector(SEED_USER, connectionId, { entityId: "light.kitchen" });
    expect(byEntity.entity_id).toEqual(["light.kitchen"]);

    const byArea = await resolveSelector(SEED_USER, connectionId, { area: "Kitchen", domain: "light" });
    expect(byArea.area_id).toBe("Kitchen");

    await expect(
      resolveSelector(SEED_USER, connectionId, { area: "Nowhere" }),
    ).rejects.toThrow();
  });
});

// ── Tombstones (ADR 0004): real-SQL verification of the HA removal paths ────────
describe.skipIf(!HAS_DB)("home_entities tombstones (ADR 0004)", () => {
  let connectionId: string;
  let credentialId: string;

  /** The private write/read paths under test, driven on a real connector instance. */
  interface HaPrivate {
    upsertEntity(connectionId: string, userId: string, row: unknown, raw: unknown): Promise<void>;
    tombstoneEntity(connectionId: string, entityId: string): Promise<void>;
    onEvent(connectionId: string, ev: { event_type: string; data: unknown }): Promise<void>;
    onWsReconnect(connectionId: string): Promise<void>;
    reconcileSnapshot(connectionId: string, liveIds: Set<string>, snapshotStartedAt: Date): Promise<void>;
  }

  /** A minimal HomeEntityRow for upsertEntity. */
  function row(eid: string, state = "on") {
    const domain = eid.slice(0, eid.indexOf("."));
    return {
      source_object_id: eid,
      entity_id: eid,
      domain,
      area: null,
      state,
      unit: null,
      availability: "online",
      state_timestamp: null,
      attributes: {},
    };
  }

  /** Seed a row with an explicit ingested_at / deleted_at (raw SQL — the reconcile fence needs control). */
  async function seed(eid: string, ingestedAt: Date, deletedAt: Date | null): Promise<void> {
    const { pool } = await import("../db.js");
    const domain = eid.slice(0, eid.indexOf("."));
    await pool.query(
      `insert into home_entities
         (connection_id, user_id, source_object_id, entity_id, domain, state, availability,
          attributes, raw, ingested_at, deleted_at)
       values ($1,$2,$3,$3,$4,'on','online','{}','{}',$5,$6)
       on conflict (connection_id, source_object_id) do update set
         ingested_at = excluded.ingested_at, deleted_at = excluded.deleted_at`,
      [connectionId, SEED_USER, eid, domain, ingestedAt, deletedAt],
    );
  }

  async function deletedAtOf(eid: string): Promise<Date | null> {
    const { pool } = await import("../db.js");
    const res = await pool.query(
      `select deleted_at from home_entities where connection_id = $1 and source_object_id = $2`,
      [connectionId, eid],
    );
    expect(res.rows).toHaveLength(1);
    return res.rows[0].deleted_at as Date | null;
  }

  /** A fake WS answering the capability-cache commands + get_states (the reconnect path). */
  function fakeWs(states: unknown[] = [], registryEntities: unknown[] = []) {
    return {
      command: async (type: string) => {
        if (type === "get_states") return states;
        if (type === "get_services") return {};
        if (type === "config/area_registry/list") return [];
        if (type === "config/device_registry/list") return [];
        if (type === "config/entity_registry/list") return registryEntities;
        return [];
      },
      close() {},
    };
  }

  const past = (sec: number) => new Date(Date.now() - sec * 1000);

  beforeAll(async () => {
    ({ credentialId, connectionId } = await createConnection());
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
  });

  it("upsertEntity on a tombstoned row clears deleted_at (resurrection)", async () => {
    const { HomeAssistantConnector } = await import("./homeassistant.js");
    const ha = new HomeAssistantConnector() as unknown as HaPrivate;

    await ha.upsertEntity(connectionId, SEED_USER, row("light.rez"), {});
    await seed("light.rez", past(60), past(30)); // tombstone it
    expect(await deletedAtOf("light.rez")).not.toBeNull();

    await ha.upsertEntity(connectionId, SEED_USER, row("light.rez", "off"), {});
    expect(await deletedAtOf("light.rez")).toBeNull(); // last live writer resurrects
  });

  it("state_changed new_state:null tombstones; a later state_changed with a state resurrects", async () => {
    const { HomeAssistantConnector, buildCapabilityCache } = await import("./homeassistant.js");
    const ha = new HomeAssistantConnector();
    ha.registerConnection(connectionId, fakeWs() as never, buildCapabilityCache({}, [], [], []), SEED_USER);
    const priv = ha as unknown as HaPrivate;

    const state = { entity_id: "light.flicker", state: "on", attributes: {} };
    await priv.onEvent(connectionId, { event_type: "state_changed", data: { entity_id: "light.flicker", new_state: state } });
    expect(await deletedAtOf("light.flicker")).toBeNull();

    await priv.onEvent(connectionId, { event_type: "state_changed", data: { entity_id: "light.flicker", new_state: null } });
    expect(await deletedAtOf("light.flicker")).not.toBeNull();

    await priv.onEvent(connectionId, { event_type: "state_changed", data: { entity_id: "light.flicker", new_state: state } });
    expect(await deletedAtOf("light.flicker")).toBeNull();
  });

  it("entity_registry_updated action:'remove' tombstones the entity", async () => {
    const { HomeAssistantConnector, buildCapabilityCache } = await import("./homeassistant.js");
    const ha = new HomeAssistantConnector();
    ha.registerConnection(connectionId, fakeWs() as never, buildCapabilityCache({}, [], [], []), SEED_USER);
    const priv = ha as unknown as HaPrivate;

    await seed("switch.reg_gone", past(60), null);
    await priv.onEvent(connectionId, {
      event_type: "entity_registry_updated",
      data: { action: "remove", entity_id: "switch.reg_gone" },
    });
    expect(await deletedAtOf("switch.reg_gone")).not.toBeNull();
  });

  it("reconcileSnapshot: absent → tombstoned; in liveIds / behind the fence / already-tombstoned → untouched", async () => {
    const { HomeAssistantConnector } = await import("./homeassistant.js");
    const priv = new HomeAssistantConnector() as unknown as HaPrivate;

    await seed("light.gone", past(60), null); // absent from liveIds → tombstone
    await seed("light.live", past(60), null); // in liveIds → stays
    await seed("light.racer", new Date(Date.now() + 60_000), null); // ingested after the snapshot started → fenced
    await seed("light.old_tomb", past(60), past(30)); // keeps its original timestamp
    const originalTomb = await deletedAtOf("light.old_tomb");

    await priv.reconcileSnapshot(connectionId, new Set(["light.live"]), new Date());

    expect(await deletedAtOf("light.gone")).not.toBeNull();
    expect(await deletedAtOf("light.live")).toBeNull();
    expect(await deletedAtOf("light.racer")).toBeNull();
    expect((await deletedAtOf("light.old_tomb"))?.getTime()).toBe(originalTomb?.getTime());
  });

  it("reconnect path: states ∪ registry is live; registry-only survives; absent-from-both tombstones", async () => {
    const { HomeAssistantConnector, buildCapabilityCache } = await import("./homeassistant.js");
    const ha = new HomeAssistantConnector();
    // In the registry but missing from the state snapshot (slow-loading integration) → survives.
    ha.registerConnection(
      connectionId,
      fakeWs(
        [{ entity_id: "light.kitchen2", state: "on", attributes: {} }],
        [{ entity_id: "sensor.slow_reg", device_id: null, area_id: null }],
      ) as never,
      buildCapabilityCache({}, [], [], []),
      SEED_USER,
    );
    await seed("sensor.slow_reg", past(60), null);
    await seed("light.vanished", past(60), null);

    await (ha as unknown as HaPrivate).onWsReconnect(connectionId);

    expect(await deletedAtOf("light.kitchen2")).toBeNull(); // snapshot upserted + live
    expect(await deletedAtOf("sensor.slow_reg")).toBeNull(); // registry-only → NOT tombstoned
    expect(await deletedAtOf("light.vanished")).not.toBeNull(); // absent from both → tombstoned
  });

  it("a zero-state snapshot skips the reconcile (stale rows stay live)", async () => {
    const { HomeAssistantConnector, buildCapabilityCache } = await import("./homeassistant.js");
    const ha = new HomeAssistantConnector();
    ha.registerConnection(connectionId, fakeWs([], []) as never, buildCapabilityCache({}, [], [], []), SEED_USER);
    await seed("light.fault_guard", past(60), null);

    await (ha as unknown as HaPrivate).onWsReconnect(connectionId);

    expect(await deletedAtOf("light.fault_guard")).toBeNull(); // a fault, never mass-tombstone
  });

  it("upsertEntity skips a reserved 'union:'-prefixed id (no row, no throw, one warn); a normal entity still lands (#37)", async () => {
    const { pool } = await import("../db.js");
    const { HomeAssistantConnector } = await import("./homeassistant.js");
    const ha = new HomeAssistantConnector() as unknown as HaPrivate;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(ha.upsertEntity(connectionId, SEED_USER, row("union:x"), {})).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    const forged = await pool.query(
      `select 1 from home_entities where connection_id = $1 and source_object_id = 'union:x'`,
      [connectionId],
    );
    expect(forged.rows).toHaveLength(0);

    // The guard is a per-entity skip, not a batch abort: a normal entity still lands.
    await ha.upsertEntity(connectionId, SEED_USER, row("light.after_union"), {});
    expect(await deletedAtOf("light.after_union")).toBeNull();
  });

  it("tombstoneEntity skips a reserved 'union:'-prefixed id (row stays live, no throw) (#37)", async () => {
    const { HomeAssistantConnector } = await import("./homeassistant.js");
    const ha = new HomeAssistantConnector() as unknown as HaPrivate;

    // Seed a synthetic-shaped row raw-SQL (the engine's, not HA's) — the removal path must not touch it.
    await seed("union:winner", past(60), null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(ha.tombstoneEntity(connectionId, "union:winner")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(await deletedAtOf("union:winner")).toBeNull();
  });

  it("a tombstoned entity is absent from the listActions catalog and does not resolve as a target", async () => {
    const { HomeAssistantConnector, buildCapabilityCache } = await import("./homeassistant.js");
    const { resolveSelector } = await import("../core/selector.js");
    const ha = new HomeAssistantConnector();
    const services = {
      light: { turn_on: { description: "Turn on", fields: {} } },
      lock: { lock: { description: "Lock", fields: {} } },
    };
    ha.registerConnection(
      connectionId,
      fakeWs() as never,
      buildCapabilityCache(services as never, [], [], []),
      SEED_USER,
    );
    await seed("light.kitchen3", past(60), null);
    await seed("lock.front3", past(60), past(30)); // tombstoned — its domain has no other live entity

    const ids = (await ha.listActions({ userId: SEED_USER, connectionId, secretRef: null })).map((a) => a.id);
    expect(ids).toContain("home.light.turn_on");
    expect(ids).not.toContain("home.lock.lock"); // tombstoned entity contributes nothing

    // …and the selector refuses it as a dispatch target (the default DB loader filters tombstones).
    await expect(resolveSelector(SEED_USER, connectionId, { entityId: "lock.front3" })).rejects.toThrow(
      /no cached entity/,
    );
  });
});

// ── #39 stream-state wiring: the handlers start() hangs on ws.onUp/ws.onDown ────
describe.skipIf(!HAS_DB)("stream-state writers (#39)", () => {
  let connectionId: string;
  let credentialId: string;

  /** The private stream handlers under test (wired to ws.onUp/ws.onDown by start()). */
  interface HaStream {
    handleStreamUp(connectionId: string): Promise<void>;
    handleStreamDown(connectionId: string, reason: string): Promise<void>;
  }

  // #43 Contention A: bootstrap.test.ts's startPushConnectors scan is table-wide + un-user-scoped
  // and, with HA_URL deleted, flips THIS seed-user connector's status to 'error' mid-test. Serialize
  // the two describes across parallel vitest forks on the shared *_test DB (same idiom as #38). Hold
  // the lock BEFORE createConnection so no scan can see a half-built row, release AFTER the delete.
  let releaseLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseLock = await lockTestResource("push-connector-scan");
    ({ credentialId, connectionId } = await createConnection());
  }, 120_000);

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await releaseLock?.();
  });

  async function streamRow() {
    const { pool } = await import("../db.js");
    // ::text keeps microsecond precision (a JS Date rounds to ms and could hide a wrongful re-stamp).
    const res = await pool.query(
      `select status, last_error, stream_state, stream_error, stream_changed_at::text as since
         from connectors where id = $1`,
      [connectionId],
    );
    return res.rows[0] as {
      status: string;
      last_error: string | null;
      stream_state: string | null;
      stream_error: string | null;
      since: string | null;
    };
  }

  async function makeHa(): Promise<HaStream> {
    const { HomeAssistantConnector } = await import("./homeassistant.js");
    return new HomeAssistantConnector() as unknown as HaStream;
  }

  it("a drop → 'retrying' (status untouched); the re-auth → 'connected' + null stream_error", async () => {
    const ha = await makeHa();

    await ha.handleStreamDown(connectionId, "socket closed — reconnecting");
    let r = await streamRow();
    expect(r.status).toBe("active"); // a mid-run drop is the client's own loop to heal — no status flip
    expect(r.stream_state).toBe("retrying");
    expect(r.stream_error).toBe("socket closed — reconnecting");
    expect(r.since).not.toBeNull();

    await ha.handleStreamUp(connectionId);
    r = await streamRow();
    expect(r.status).toBe("active");
    expect(r.stream_state).toBe("connected");
    expect(r.stream_error).toBeNull();
  });

  it("repeated same-state writes keep the original stream_changed_at; a transition re-stamps", async () => {
    const ha = await makeHa();

    await ha.handleStreamDown(connectionId, "socket closed — reconnecting");
    const first = (await streamRow()).since;
    expect(first).not.toBeNull();

    await new Promise((r) => setTimeout(r, 15)); // a measurable clock delta between the writes
    await ha.handleStreamDown(connectionId, "socket closed — reconnecting");
    expect((await streamRow()).since).toBe(first); // same state → the original "since" survives

    await new Promise((r) => setTimeout(r, 15));
    await ha.handleStreamUp(connectionId);
    expect((await streamRow()).since).not.toBe(first); // transition → re-stamped
  });

  it("the mid-run terminal auth death → 'down' + status='error' with last_error (the operator sees Reconnect)", async () => {
    const ha = await makeHa();
    await ha.handleStreamUp(connectionId); // a healthy baseline first

    await ha.handleStreamDown(connectionId, "auth invalid");
    const r = await streamRow();
    expect(r.stream_state).toBe("down");
    expect(r.stream_error).toBe("auth invalid");
    expect(r.status).toBe("error"); // the runner helper — this is what surfaces Reconnect
    expect(r.last_error).toBe("auth invalid: token revoked mid-run");
  });
});

describe.skipIf(!HAS_HA)("live Home Assistant WS connect", () => {
  it("connects, builds the capability cache, and upserts states", async () => {
    const { HaWsClient } = await import("./homeassistant-ws.js");
    const client = new HaWsClient({
      haUrl: process.env.HA_URL!,
      token: process.env.HA_TOKEN!,
      autoReconnect: false,
    });
    await client.connect();
    expect(client.isReady()).toBe(true);

    const services = (await client.command("get_services")) as Record<string, unknown>;
    expect(Object.keys(services).length).toBeGreaterThan(0);

    const states = (await client.command("get_states")) as unknown[];
    expect(Array.isArray(states)).toBe(true);

    client.close();
  }, 20_000);
});
