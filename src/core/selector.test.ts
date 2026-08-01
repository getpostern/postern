// Selector resolution — pure unit tests via the injectable loader (no DB), plus a DATABASE_URL-
// gated round-trip proving the default loader excludes tombstoned rows (ADR 0004).
// Covers the spec's acceptance criteria: {entityId} → that entity; {area,domain} → {area_id};
// an alias/name resolves; no match → throws; and the cache-scoping guards.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveSelector, type Selector } from "./selector.js";

interface E {
  entity_id: string;
  domain: string | null;
  area: string | null;
  friendly_name: string | null;
}

const KITCHEN: E[] = [
  { entity_id: "light.kitchen_main", domain: "light", area: "Kitchen", friendly_name: "Kitchen Main Light" },
  { entity_id: "light.kitchen_under", domain: "light", area: "Kitchen", friendly_name: "Under Cabinet" },
  { entity_id: "switch.kitchen_fan", domain: "switch", area: "Kitchen", friendly_name: "Kitchen Fan" },
  { entity_id: "lock.front_door", domain: "lock", area: "Entryway", friendly_name: "Front Door" },
];

function loaderFor(entities: E[]) {
  return async () => entities;
}

async function resolve(sel: Selector, entities: E[] = KITCHEN) {
  return resolveSelector("u1", "c1", sel, loaderFor(entities));
}

describe("resolveSelector — entityId", () => {
  it("an explicit entityId resolves to just that entity", async () => {
    const t = await resolve({ entityId: "light.kitchen_main" });
    expect(t).toEqual({ entity_id: ["light.kitchen_main"] });
  });

  it("an unknown entityId throws (can't dispatch on what isn't cached)", async () => {
    await expect(resolve({ entityId: "light.nonexistent" })).rejects.toThrow(/no cached entity/);
  });
});

describe("resolveSelector — area + domain", () => {
  it("{area:'kitchen', domain:'light'} prefers area_id and lists the matched entities", async () => {
    const t = await resolve({ area: "kitchen", domain: "light" });
    expect(t.area_id).toBe("Kitchen");
    expect(t.entity_id).toEqual(["light.kitchen_main", "light.kitchen_under"]);
  });

  it("a bare {area} (no domain, no name) returns just {area_id} for HA to expand", async () => {
    const t = await resolve({ area: "kitchen" });
    expect(t).toEqual({ area_id: "Kitchen" });
  });

  it("area matching is case/whitespace tolerant", async () => {
    const t = await resolve({ area: "  KITCHEN ", domain: "light" });
    expect(t.area_id).toBe("Kitchen");
  });
});

describe("resolveSelector — name", () => {
  it("a friendly-name match resolves to an explicit entity (not an area)", async () => {
    const t = await resolve({ name: "Under Cabinet" });
    expect(t).toEqual({ entity_id: ["light.kitchen_under"] });
  });

  it("a partial name within an area resolves", async () => {
    const t = await resolve({ area: "kitchen", name: "fan" });
    expect(t.entity_id).toEqual(["switch.kitchen_fan"]);
  });
});

describe("resolveSelector — no match / guards", () => {
  it("no match throws a clear error", async () => {
    await expect(resolve({ area: "garage", domain: "light" })).rejects.toThrow(/no entity matches/);
  });

  it("an empty selector throws (nothing to resolve)", async () => {
    await expect(resolve({})).rejects.toThrow(/provide entityId/);
  });

  it("only resolves within the loaded (user+connection) cache — empty cache → throws", async () => {
    await expect(resolve({ area: "kitchen" }, [])).rejects.toThrow(/no entity matches/);
  });
});

// ── Tombstones (ADR 0004): the DEFAULT loader must not offer removed entities ───
const HAS_DB = !!process.env.DATABASE_URL;
// A dedicated user, so the (user_id, provider) unique on provider_credentials never collides with
// the HA db tests holding the seed user's home_assistant credential in a parallel worker.
const SEL_USER = "00000000-0000-0000-0000-00000000005e";

describe.skipIf(!HAS_DB)("resolveSelector — tombstoned rows are never dispatch targets (DB)", () => {
  let credentialId: string;
  let connectionId: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`insert into users (id) values ($1) on conflict (id) do nothing`, [SEL_USER]);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody)
       values ($1, 'home_assistant', 'static_token') returning id`,
      [SEL_USER],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'home', 'home_assistant', 'active') returning id`,
      [SEL_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;

    // One live, one tombstoned (seeded via raw SQL) — same area + domain.
    const rows: [string, string, Date | null][] = [
      ["light.alive", "Alive Light", null],
      ["light.dead", "Dead Light", new Date()],
    ];
    for (const [eid, fn, deletedAt] of rows) {
      await pool.query(
        `insert into home_entities
           (connection_id, user_id, source_object_id, entity_id, domain, area, state, availability,
            attributes, raw, deleted_at)
         values ($1,$2,$3,$3,'light','Kitchen','on','online',$4,'{}',$5)`,
        [connectionId, SEL_USER, eid, JSON.stringify({ friendly_name: fn }), deletedAt],
      );
    }
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.end();
  });

  it("an explicit entityId of a tombstoned entity throws (not cached as live)", async () => {
    await expect(resolveSelector(SEL_USER, connectionId, { entityId: "light.dead" })).rejects.toThrow(
      /no cached entity/,
    );
  });

  it("an area selector matches only the live entity", async () => {
    const t = await resolveSelector(SEL_USER, connectionId, { area: "kitchen", domain: "light" });
    expect(t.entity_id).toEqual(["light.alive"]);
  });
});
