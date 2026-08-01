// describeContext + fetch_live freshness round-trips against a real Postgres, gated on DATABASE_URL
// so CI stays green. Seeds rows DIRECTLY via raw SQL under a dedicated throwaway user (the
// established pattern); the connector registry stays REAL so fakes registered here drive the
// SyncPolicy.mode join and the push-kind duck-type. Proves:
//   * each returned connection carries `mode` from its connector's SyncPolicy (push for a push
//     connector, poll for a poll connector),
//   * a provider with NO registered connector → mode: null (defensive),
//   * connectors in GRANTED sectors are returned with last_synced_at still present,
//   * #39/#40 honesty: describe_context lists error/paused connections (freshness 'error'/'paused'),
//     NEVER revoked; a dead push stream reads 'unreachable'; fetch_live on its sector answers
//     synced:false with an attributed error AND per-connection connections[] freshness.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connector, RawRecord } from "../connectors/types.js";
import { ALL_SECTORS, type AuthContext } from "../auth/index.js";
import { describeContext, fetchLive } from "./context.js";
import type { Freshness } from "./freshness.js";
import { registerConnector } from "../sync/index.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A DEDICATED throwaway user so these round-trips can't race other db test files (run in parallel).
const TEST_USER = "00000000-0000-0000-0000-0000000099a1";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "describe-context-test",
  grantedSectors: new Set(ALL_SECTORS),
};

/** A minimal fake connector declaring only the bits the mode-join reads (provider, sector, policy.mode).
 *  `hasStart` adds a duck-typed start() so pushKindOf reads it as a push-STREAM (#39); `intervals`
 *  declares the ADR-0025 cadence policy (default + floor) for the freshness-threading round-trips. */
function makeConnector(
  provider: string,
  sector: string,
  mode: "push" | "poll" | "on_demand",
  hasStart = false,
  intervals?: { defaultIntervalSec?: number; minIntervalSec?: number },
): Connector {
  const base: Connector = {
    provider,
    sector,
    objectType: "home_entity",
    policy: { mode, supportsIncremental: false, ...intervals },
    actions: [],
    // eslint-disable-next-line require-yield
    async *sync(): AsyncIterable<RawRecord> {
      return;
    },
    normalize: (raw) => raw.raw,
    strongKeys: () => ({}),
    execute: async () => ({ ok: false }),
  };
  if (hasStart) (base as { start?: () => Promise<void> }).start = async () => {};
  return base;
}

describe.skipIf(!HAS_DB)("describeContext — per-connection sync mode", () => {
  let connStream: string; // dc-stream's connection id (the fetch_live connections[] assertion)
  let connCad: string; // dc-cad's connection id (the ADR-0025 cadence-threading pair)

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'describe-context-db-test') on conflict (id) do nothing`,
      [TEST_USER],
    );

    const cred = async (provider: string) => {
      const r = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, status)
         values ($1, $2, 'static_token', 'active') returning id`,
        [TEST_USER, provider],
      );
      return r.rows[0].id as string;
    };
    const connector = async (
      provider: string,
      sector: string,
      lastSynced: string | null,
      status = "active",
    ): Promise<string> => {
      const r = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status, last_synced_at)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [TEST_USER, await cred(provider), sector, provider, status, lastSynced],
      );
      return r.rows[0].id as string;
    };

    // home · push connector, finance · poll connector, health · UNREGISTERED provider (→ mode null).
    registerConnector(makeConnector("dc-push", "home", "push"));
    registerConnector(makeConnector("dc-poll", "finance", "poll"));
    await connector("dc-push", "home", "2026-06-10T10:00:00Z");
    await connector("dc-poll", "finance", "2026-06-10T11:00:00Z");
    await connector("dc-unregistered", "health", null);

    // #39/#40 honesty seeds: an errored poll, a paused poll, a revoked one (must NEVER appear), and
    // a push-STREAM (duck-typed start) whose stream is down while the row is still 'active'.
    registerConnector(makeConnector("dc-err", "finance", "poll"));
    registerConnector(makeConnector("dc-paused", "calendar", "poll"));
    registerConnector(makeConnector("dc-revoked", "mail", "poll"));
    registerConnector(makeConnector("dc-stream", "home", "push", true));
    await connector("dc-err", "finance", "2026-06-01T00:00:00Z", "error");
    await pool.query(
      `update connectors set last_error = 'bridge returned 500', last_error_at = now()
        where user_id = $1 and provider = 'dc-err'`,
      [TEST_USER],
    );
    await connector("dc-paused", "calendar", "2026-06-01T00:00:00Z", "paused");
    await connector("dc-revoked", "mail", "2026-06-01T00:00:00Z", "revoked");
    connStream = await connector("dc-stream", "home", "2026-06-10T09:00:00Z");
    await pool.query(
      `update connectors
          set stream_state = 'down', stream_error = 'auth failed: invalid token',
              stream_changed_at = now() - interval '2 hours'
        where user_id = $1 and provider = 'dc-stream'`,
      [TEST_USER],
    );

    // Sync cadence (ADR 0025): a poll connector with the plaid/whoop policy shape (6h default,
    // 900s floor) — the freshnessForRow-call-site half of the cadence-threading pair (#41 item 5).
    registerConnector(
      makeConnector("dc-cad", "finance", "poll", false, { defaultIntervalSec: 21600, minIntervalSec: 900 }),
    );
    connCad = await connector("dc-cad", "finance", null);

    // #41 item 4: a connector whose per-row derivation THROWS (a broken policy getter) — the row
    // must be LISTED degraded, never vanished, and never blank its siblings. Sector 'contacts' so
    // the fetch_live('home') round-trips above never touch it.
    const bad = makeConnector("dc-derive-throws", "contacts", "poll");
    Object.defineProperty(bad, "policy", {
      get() {
        throw new Error("broken connector policy (test)");
      },
    });
    registerConnector(bad);
    await connector("dc-derive-throws", "contacts", "2026-06-10T08:00:00Z");
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: user -> credentials -> connectors.
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("each connection carries its connector's SyncPolicy.mode; an unregistered provider → null", async () => {
    const { connections } = await describeContext(ctx);
    const byProvider = Object.fromEntries(
      (connections as Array<Record<string, unknown>>).map((c) => [c.provider, c]),
    );

    expect(byProvider["dc-push"].mode).toBe("push");
    expect(byProvider["dc-poll"].mode).toBe("poll");
    expect(byProvider["dc-unregistered"].mode).toBeNull();
  });

  it("keeps the existing connection fields (provider/sector/status/last_synced_at)", async () => {
    const { connections } = await describeContext(ctx);
    const push = (connections as Array<Record<string, unknown>>).find((c) => c.provider === "dc-push")!;
    expect(push.sector).toBe("home");
    expect(push.status).toBe("active");
    expect(push.last_synced_at).not.toBeNull();
  });

  it("#39 lists error and paused connections with honest freshness — and still NEVER revoked", async () => {
    const { connections } = await describeContext(ctx);
    const byProvider = Object.fromEntries(
      (connections as Array<Record<string, unknown>>).map((c) => [c.provider, c]),
    );

    const err = byProvider["dc-err"] as { status: string; freshness: Freshness };
    expect(err.status).toBe("error");
    expect(err.freshness.state).toBe("error");
    expect(err.freshness.error?.message).toBe("bridge returned 500");
    expect(err.freshness.error?.since).not.toBeNull();

    const paused = byProvider["dc-paused"] as { status: string; freshness: Freshness };
    expect(paused.status).toBe("paused");
    expect(paused.freshness.state).toBe("paused");

    // Revoked connections stay OUT — an orphaned cache is history, not a live source.
    expect(byProvider["dc-revoked"]).toBeUndefined();
  });

  it("#39 a dead push stream reads 'unreachable' (with stream_state + error.since) while status is still 'active'", async () => {
    const { connections } = await describeContext(ctx);
    const stream = (connections as Array<Record<string, unknown>>).find(
      (c) => c.provider === "dc-stream",
    ) as { status: string; freshness: Freshness };
    expect(stream.status).toBe("active"); // stream columns never touch status
    expect(stream.freshness.state).toBe("unreachable");
    expect(stream.freshness.stream_state).toBe("down");
    expect(stream.freshness.error?.message).toBe("auth failed: invalid token");
    expect(stream.freshness.error?.since).not.toBeNull();
  });

  it("#39 fetch_live on a sector with a dead push stream → synced:false + attributed error + connections[] freshness", async () => {
    // home holds dc-push (push, no stream columns) + dc-stream (stream down); no poll connections,
    // so no syncConnection runs — the dead stream alone must force the honest answer.
    const out = await fetchLive(ctx, "home");
    expect(out.mode).toBe("sync");
    if (out.mode !== "sync") throw new Error("unreachable");
    expect(out.synced).toBe(false);
    expect(out.timed_out).toBe(false);
    expect(out.errors).toEqual(["dc-stream: push stream down — auth failed: invalid token"]);

    // connections[] carries every connection's post-sync freshness, dead ones INCLUDED.
    expect(out.connections).toHaveLength(2);
    const dead = out.connections.find((c) => c.provider === "dc-stream")!;
    expect(dead.connection_id).toBe(connStream);
    expect(dead.mode).toBe("push");
    expect(dead.freshness.state).toBe("unreachable");
    expect(dead.freshness.stream_state).toBe("down");
    const quiet = out.connections.find((c) => c.provider === "dc-push")!;
    // No stream columns ever written + a month-old last_synced_at → the stream-silence fallback: stale.
    expect(quiet.freshness.state).toBe("stale");
  });

  it("#41 item 4: one row's throwing derivation degrades THAT row ({state:'error'}) — the full list still serves", async () => {
    const { connections } = await describeContext(ctx);
    const byProvider = Object.fromEntries(
      (connections as Array<Record<string, unknown>>).map((c) => [c.provider, c]),
    );

    // The broken row is LISTED, degraded — never vanished (the vanishing-connections lie stays dead).
    const bad = byProvider["dc-derive-throws"] as {
      sector: string;
      status: string;
      mode: unknown;
      health: unknown;
      last_synced_at: unknown;
      freshness: Freshness;
    };
    expect(bad).toBeDefined();
    expect(bad.sector).toBe("contacts");
    expect(bad.status).toBe("active"); // the raw row facts still serve
    expect(bad.last_synced_at).not.toBeNull();
    expect(bad.mode).toBeNull();
    expect(bad.health).toBeNull();
    expect(bad.freshness.state).toBe("error");
    expect(bad.freshness.error?.message).toBeTruthy();

    // Its siblings are untouched — healthy freshness, full derivation.
    expect(byProvider["dc-push"]).toBeDefined();
    expect(byProvider["dc-poll"]).toBeDefined();
    expect((byProvider["dc-poll"] as { freshness: Freshness }).freshness.state).not.toBe("error");
  });

  it("cadence threading (ADR 0025, #41 item 5): a 900s override makes a 40-min-old poll row 'stale'; the 21600s default reads 'ok'", async () => {
    const { pool } = await import("../db.js");
    // 40 minutes, not 25: the near grace for a 900s cadence is max(1350s, 1500s) = EXACTLY 25 min, so the old fixture passed only by the milliseconds between the write and the derivation — and here the two clocks are different processes. This cell tests THREADING, not tuning; give it room.
    const lastSynced = new Date(Date.now() - 40 * 60_000); // synced 40 min ago
    await pool.query(
      `update connectors set last_synced_at = $2, sync_interval_sec = 900 where id = $1`,
      [connCad, lastSynced],
    );

    let { connections } = await describeContext(ctx);
    let cad = (connections as Array<Record<string, unknown>>).find((c) => c.provider === "dc-cad") as {
      freshness: Freshness;
    };
    expect(cad.freshness.state).toBe("stale"); // 25 min > 1.5 × 900s — the override drives staleness
    expect(cad.freshness.next_expected_at).toBe(new Date(lastSynced.getTime() + 900_000).toISOString());

    await pool.query(`update connectors set sync_interval_sec = null where id = $1`, [connCad]);
    ({ connections } = await describeContext(ctx));
    cad = (connections as Array<Record<string, unknown>>).find((c) => c.provider === "dc-cad") as {
      freshness: Freshness;
    };
    expect(cad.freshness.state).toBe("ok"); // 25 min ≪ 1.5 × 21600s — the default recalibrates
    expect(cad.freshness.next_expected_at).toBe(
      new Date(lastSynced.getTime() + 21600_000).toISOString(),
    );
  });

  // ── agent-surface-semantics (#98 items 3): every connection is IDENTIFIABLE (connection_id) and
  //    NAMEABLE (best-effort label) — including the degraded ones an operator has to go fix ──

  /** Seed one credential + one connector, optionally with a credential username. Returns the ids. */
  async function seedConn(
    provider: string,
    sector: string,
    username: string | null,
  ): Promise<{ connectionId: string; credentialId: string }> {
    const { pool } = await import("../db.js");
    const cr = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status, username)
       values ($1, $2, 'static_token', 'active', $3) returning id`,
      [TEST_USER, provider, username],
    );
    const credentialId = cr.rows[0].id as string;
    const co = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status, last_synced_at)
       values ($1, $2, $3, $4, 'active', now()) returning id`,
      [TEST_USER, credentialId, sector, provider],
    );
    return { connectionId: co.rows[0].id as string, credentialId };
  }

  /** A finance_accounts row carrying the institution name the label derivation reads. */
  async function seedInstitution(connectionId: string, sid: string, institution: string) {
    const { pool } = await import("../db.js");
    await pool.query(
      `insert into finance_accounts (connection_id, user_id, source_object_id, institution_name, balance_at)
       values ($1, $2, $3, $4, now())`,
      [connectionId, TEST_USER, sid, institution],
    );
  }

  function byProviderOf(connections: unknown[]): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      (connections as Array<Record<string, unknown>>).map((c) => [c.provider as string, c]),
    );
  }

  it("every listed connection carries its connection_id — the connectors.id, not the credential id", async () => {
    const { pool } = await import("../db.js");
    const seeded = await pool.query(
      `select provider, id, credential_id from connectors
        where user_id = $1 and provider = any($2)`,
      [TEST_USER, ["dc-push", "dc-poll"]],
    );
    expect(seeded.rows).toHaveLength(2);

    const byProvider = byProviderOf((await describeContext(ctx)).connections);
    const ids = new Set<string>();
    for (const row of seeded.rows as Array<{ provider: string; id: string; credential_id: string }>) {
      const served = byProvider[row.provider];
      expect(served.connection_id).toBe(row.id);
      expect(served.connection_id).not.toBe(row.credential_id);
      ids.add(served.connection_id as string);
    }
    expect(ids.size).toBe(2); // two connections, two distinct ids
  });

  it("two finance connections at different institutions get different labels", async () => {
    const { pool } = await import("../db.js");
    const a = await seedConn("dc-lbl-a", "finance", "shared-login@example.com");
    const b = await seedConn("dc-lbl-b", "finance", null);
    await seedInstitution(a.connectionId, "lbl-a-1", "Bank A");
    await seedInstitution(b.connectionId, "lbl-b-1", "Bank B");
    try {
      const byProvider = byProviderOf((await describeContext(ctx)).connections);
      // The institution name WINS over the credential username (a is seeded with both).
      expect(byProvider["dc-lbl-a"].label).toBe("Bank A");
      expect(byProvider["dc-lbl-b"].label).toBe("Bank B");
    } finally {
      await pool.query(`delete from provider_credentials where id = any($1)`, [
        [a.credentialId, b.credentialId],
      ]);
    }
  });

  it("a connection with no institution name falls back to the credential username, then to null", async () => {
    const { pool } = await import("../db.js");
    const withInst = await seedConn("dc-lbl-inst", "finance", null);
    await seedInstitution(withInst.connectionId, "lbl-inst-1", "Bank A");
    const withUser = await seedConn("dc-lbl-user", "mail", "me@example.com");
    const withNeither = await seedConn("dc-lbl-none", "calendar", null);
    // A finance connection with NO finance_accounts rows at all: the label query returns nothing
    // for it and the fallback chain must land on null, not on another connection's institution.
    const financeNoRows = await seedConn("dc-lbl-empty", "finance", null);
    try {
      const byProvider = byProviderOf((await describeContext(ctx)).connections);
      expect(byProvider["dc-lbl-inst"].label).toBe("Bank A");
      expect(byProvider["dc-lbl-user"].label).toBe("me@example.com");
      expect(byProvider["dc-lbl-none"].label).toBeNull();
      expect(byProvider["dc-lbl-empty"].label).toBeNull();
      // …and none of them vanished because a label could not be derived.
      for (const p of ["dc-lbl-inst", "dc-lbl-user", "dc-lbl-none", "dc-lbl-empty"]) {
        expect(byProvider[p].connection_id).toEqual(expect.any(String));
        expect(byProvider[p].status).toBe("active");
      }
    } finally {
      await pool.query(`delete from provider_credentials where id = any($1)`, [
        [withInst.credentialId, withUser.credentialId, withNeither.credentialId, financeNoRows.credentialId],
      ]);
    }
  });

  it("a degraded connection still carries its connection_id and label", async () => {
    const { pool } = await import("../db.js");
    // Force the per-row derivation to throw: a connector whose `policy` is a throwing getter makes
    // getConnector(provider)?.policy.mode explode inside the try, landing in the degraded catch.
    const broken = makeConnector("dc-lbl-broken", "contacts", "poll");
    Object.defineProperty(broken, "policy", {
      get() {
        throw new Error("broken connector policy (test)");
      },
    });
    registerConnector(broken);
    const seeded = await seedConn("dc-lbl-broken", "contacts", "broken@example.com");
    try {
      const byProvider = byProviderOf((await describeContext(ctx)).connections);
      const degraded = byProvider["dc-lbl-broken"] as {
        connection_id: string;
        label: string | null;
        freshness: Freshness;
      };
      expect(degraded).toBeDefined();
      expect(degraded.freshness.state).toBe("error"); // it really did take the degraded branch
      expect(degraded.connection_id).toBe(seeded.connectionId);
      expect(degraded.label).toBe("broken@example.com");
    } finally {
      await pool.query(`delete from provider_credentials where id = $1`, [seeded.credentialId]);
    }
  });

  it("sectors is the GRANTED list, not the connected list", async () => {
    // This user's only `mail` connector is revoked (never listed) and there is no `health` connection
    // row for a granted-but-unconnected check that does not depend on seeding order — so grant home +
    // mail: mail is granted, has zero listed connections, and must still appear in `sectors`.
    const narrow: AuthContext = {
      userId: TEST_USER,
      agentId: "describe-context-test",
      grantedSectors: new Set(["home", "mail"]),
    };
    const { sectors, connections } = await describeContext(narrow);
    expect(sectors).toContain("home");
    expect(sectors).toContain("mail");
    expect(sectors).not.toContain("finance");
    const listed = (connections as Array<Record<string, unknown>>).map((c) => c.sector as string);
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed)).toEqual(new Set(["home"])); // granted ≠ connected
  });
});
