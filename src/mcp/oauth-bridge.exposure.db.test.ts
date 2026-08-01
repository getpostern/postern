// console-exposure-surface — bridge config RESOLUTION over a real Postgres, plus the end-to-end cell
// §Construction 15 exists for (gated on DATABASE_URL; disposable *_test DB only).
//
// The property under test: a gateway published FROM THE CONSOLE, with no MCP_PUBLIC_URL anywhere, must
// honour the tokens it just issued. Before this unit both gates on the bridge-token path were env-only,
// so such a gateway would have mounted the bridge, completed a whole OAuth flow, handed claude.ai a
// token, and then 401'd that token on every call — a silent, complete failure no existing test could
// cover, because no existing test could configure the bridge any other way.
//
// Module state and env leak across files in the same worker: afterEach clears the mount note AND
// restores MCP_PUBLIC_URL, unconditionally.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db.js";
import { lockTestResource } from "../test-support/advisory-lock.js";
import { setExposure, clearExposure } from "../gateway/exposure-config.js";
import { sessionAuth } from "./bearer.js";
import {
  BRIDGE_ACCESS_TOKEN_PREFIX,
  bridgeTokensAcceptable,
  mountedBridgeConfig,
  noteBridgeMount,
  resolveBridgeConfig,
  resolveBridgeToken,
} from "./oauth-bridge.js";

// The one injected fault: `getExposure` rejecting. oauth-bridge.ts imports it from this module, so the
// mock reaches resolveBridgeConfig; everything else passes straight through to the real store.
const hoisted = vi.hoisted(() => ({ failRead: false }));
vi.mock("../gateway/exposure-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/exposure-config.js")>();
  return {
    ...actual,
    getExposure: async () => {
      if (hoisted.failRead) throw new Error("simulated gateway_exposure read fault");
      return actual.getExposure();
    },
  };
});

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001"; // the seeded operator (db/schema.sql)
const RUN = randomBytes(4).toString("hex");
const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

const savedEnv = process.env.MCP_PUBLIC_URL;

async function clearRow(): Promise<void> {
  await pool.query(`delete from gateway_exposure where id = true`);
}

// `gateway_exposure` is a ONE-ROW table and THREE db suites drive it (this one,
// src/gateway/exposure-config.db.test.ts and src/rest/exposure-routes.db.test.ts). Under vitest's
// parallel file execution their `clearRow()`/`setExposure()` land inside each other's cells — the #115
// collision class — so hold the table for this WHOLE FILE (both describes below), the plaid_app/
// oauth_provider_apps idiom from #38. All three contenders must use the SAME key.
//
// File-level hooks on purpose: vitest runs a file-level afterAll AFTER every suite-level one, so the
// release cannot land before the last cell's cleanup.
let releaseLock: (() => Promise<void>) | undefined;
beforeAll(async () => {
  releaseLock = await lockTestResource("gateway_exposure");
}, 120_000);
afterAll(async () => {
  await releaseLock?.();
});

describe.skipIf(!HAS_DB)("resolveBridgeConfig — DB first, env fallback, fail-closed", () => {
  beforeEach(async () => {
    hoisted.failRead = false;
    await clearRow();
    delete process.env.MCP_PUBLIC_URL;
  });

  afterEach(() => {
    hoisted.failRead = false;
    noteBridgeMount(null);
    if (savedEnv === undefined) delete process.env.MCP_PUBLIC_URL;
    else process.env.MCP_PUBLIC_URL = savedEnv;
  });

  afterAll(async () => {
    await clearRow();
  });

  it("a stored address wins over the one on the box", async () => {
    await setExposure("https://db.example");
    process.env.MCP_PUBLIC_URL = "https://env.example";

    const r = await resolveBridgeConfig();
    expect(r.cfg?.publicUrl).toBe("https://db.example");
    expect(r.source).toBe("db");
    expect(r.problem).toBeNull();
  });

  it("a gateway with no stored address still honours the one on the box", async () => {
    process.env.MCP_PUBLIC_URL = "https://env.example";

    const r = await resolveBridgeConfig();
    expect(r.cfg?.publicUrl).toBe("https://env.example");
    expect(r.source).toBe("env");
    expect(r.problem).toBeNull();

    // …and with neither, nothing is published at all (§D2's promise, over both sources).
    delete process.env.MCP_PUBLIC_URL;
    expect(await resolveBridgeConfig()).toEqual({ cfg: null, source: null, problem: null });
  });

  it("a gateway that cannot read its own setting publishes nothing, and does not quietly use the box's", async () => {
    // MCP_PUBLIC_URL is set to a VALID https URL on purpose: without it this cell passes against both
    // the correct implementation and a fall-through-to-env one, which is the vacuous shape.
    process.env.MCP_PUBLIC_URL = "https://env.example";
    hoisted.failRead = true;

    const r = await resolveBridgeConfig();
    expect(r.cfg).toBeNull();
    expect(r.problem).toBe("db_unreadable");
    expect(r.source).toBeNull();
    // The partner that makes the fault real: with the fault cleared, the same env var DOES resolve.
    hoisted.failRead = false;
    expect((await resolveBridgeConfig()).cfg?.publicUrl).toBe("https://env.example");
  });

  it("an address the gateway cannot parse leaves it unpublished rather than half-published", async () => {
    // Planted DIRECTLY, bypassing the route's validator — a row written by a different build.
    await pool.query(
      `insert into gateway_exposure (id, public_url) values (true, 'not a url')
       on conflict (id) do update set public_url = excluded.public_url`,
    );
    process.env.MCP_PUBLIC_URL = "https://env.example";

    const r = await resolveBridgeConfig(); // must NOT throw
    expect(r.cfg).toBeNull();
    expect(r.source).toBe("db");
    expect(r.problem).toBe("db_invalid");
  });

  it("an address an older build wrote WITH A PATH leaves this one unpublished", async () => {
    // #126. `https://…/mcp` was accepted and stored by builds before the path rule, so this row
    // really is out there. Resolution re-runs the validator on the stored value — the load-bearing
    // premise, asserted rather than assumed — so the row degrades to a named problem instead of
    // mounting a gateway whose own discovery documents point at endpoints it does not serve.
    await pool.query(
      `insert into gateway_exposure (id, public_url) values (true, 'https://db.example/mcp')
       on conflict (id) do update set public_url = excluded.public_url`,
    );

    const r = await resolveBridgeConfig(); // must NOT throw
    expect(r.cfg).toBeNull();
    expect(r.source).toBe("db");
    expect(r.problem).toBe("db_invalid");

    // The partner that makes the refusal specific rather than a store-wide failure: the SAME row
    // with the path removed resolves cleanly, from the same table, in the same cell.
    await pool.query(`update gateway_exposure set public_url = 'https://db.example' where id = true`);
    const fixed = await resolveBridgeConfig();
    expect(fixed.cfg?.publicUrl).toBe("https://db.example");
    expect(fixed.problem).toBeNull();
  });

  it("clearing the address stops the next boot from publishing", async () => {
    await setExposure("https://db.example");
    expect((await resolveBridgeConfig()).cfg?.publicUrl).toBe("https://db.example");

    await clearExposure();
    const r = await resolveBridgeConfig();
    expect(r.cfg).toBeNull();
    expect(r.source).toBeNull();
    expect(r.problem).toBeNull();
  });

  it("saving the address again re-records the consent", async () => {
    const first = await setExposure("https://one.example");
    await new Promise((r) => setTimeout(r, 25)); // now() advances between statements
    const second = await setExposure("https://two.example");

    expect(second.publicUrl).toBe("https://two.example");
    expect(second.consentedAt.getTime()).toBeGreaterThan(first.consentedAt.getTime());
  });
});

describe.skipIf(!HAS_DB)("the token gate — a Console-published gateway honours its own tokens", () => {
  const grantIds: string[] = [];

  beforeEach(async () => {
    hoisted.failRead = false;
    await clearRow();
    delete process.env.MCP_PUBLIC_URL;
    noteBridgeMount(null);
  });

  afterEach(() => {
    noteBridgeMount(null);
    if (savedEnv === undefined) delete process.env.MCP_PUBLIC_URL;
    else process.env.MCP_PUBLIC_URL = savedEnv;
  });

  afterAll(async () => {
    await clearRow();
    if (grantIds.length > 0) {
      await pool.query(`delete from agent_grants where id = any($1::uuid[])`, [grantIds]);
    }
  });

  /** A live agent grant + a bridge access token row pointing at it (hash only, as in production). */
  async function mintBridgeToken(tag: string): Promise<{ access: string; grantId: string; agentId: string }> {
    const agentId = `u4exp-${tag}-${RUN}`;
    const grant = await pool.query(
      `insert into agent_grants (user_id, agent_id, key_hash, sectors, expires_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        LOCAL_USER,
        agentId,
        sha256Hex(`key_${agentId}`),
        ["finance"],
        new Date(Date.now() + 30 * 24 * 3600 * 1000),
      ],
    );
    const grantId = (grant.rows[0] as { id: string }).id;
    grantIds.push(grantId);

    const access = `${BRIDGE_ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    await pool.query(
      `insert into oauth_bridge_tokens
         (agent_grant_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        grantId,
        `pcgcl_u4_${tag}_${RUN}`,
        sha256Hex(access),
        sha256Hex(`rt_${access}`),
        new Date(Date.now() + 3600_000),
        new Date(Date.now() + 7 * 24 * 3600_000),
      ],
    );
    return { access, grantId, agentId };
  }

  it("a gateway published from the Console honours the tokens it just issued", async () => {
    await setExposure("https://db.example");
    delete process.env.MCP_PUBLIC_URL; // nothing on the box describes this gateway

    const resolved = await resolveBridgeConfig();
    expect(resolved.source).toBe("db");
    noteBridgeMount(resolved.cfg); // exactly what src/index.ts does at the one real mount point
    expect(mountedBridgeConfig()?.publicUrl).toBe("https://db.example");

    const { access, agentId } = await mintBridgeToken("live");

    // (a) the resolve site
    const ctx = await resolveBridgeToken(access);
    expect(ctx).not.toBeNull();
    expect(ctx?.agentId).toBe(agentId);
    expect(ctx?.userId).toBe(LOCAL_USER);
    expect([...(ctx?.grantedSectors ?? [])]).toEqual(["finance"]);

    // (b) the session-auth site — the path a real /mcp initialize traverses. Reverting EITHER gate
    //     alone fails here: authorize() would skip the bridge lookup and fall through to
    //     resolveBearer, which denies an unknown static key.
    const auth = sessionAuth();
    const viaSession = await auth.authorize(access);
    expect(viaSession.agentId).toBe(agentId);
    expect(viaSession.userId).toBe(LOCAL_USER);
    expect([...viaSession.grantedSectors]).toEqual(["finance"]);
  });

  it("a gateway that has never published anything still treats an old token as dead", async () => {
    const { access } = await mintBridgeToken("dead");

    // No row, no env var, no mount — §D2's inert-token promise, re-pinned against the new gate.
    await clearRow();
    delete process.env.MCP_PUBLIC_URL;
    noteBridgeMount(null);
    expect(bridgeTokensAcceptable()).toBe(false);

    const spy = vi.spyOn(pool, "query");
    try {
      await expect(resolveBridgeToken(access)).resolves.toBeNull();
      expect(spy).not.toHaveBeenCalled(); // the bridge tables are never queried
    } finally {
      spy.mockRestore();
    }

    // The anti-vacuity partner: the very same token DOES resolve once the gateway is serving. Without
    // it, a token row that was simply never written would satisfy the cell above.
    noteBridgeMount({ publicUrl: "https://db.example" });
    expect((await resolveBridgeToken(access))?.userId).toBe(LOCAL_USER);
  });
});
