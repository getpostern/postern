// Boot wiring — registerConnectors (pure), startRestEdge (socket lifecycle + injected audit), and
// startPushConnectors (start/retry/skip/terminal/re-scan). DB-backed suites are gated on
// DATABASE_URL so CI stays green without Postgres; they use a DEDICATED user row (not the seeded
// local user) so concurrent suites that also insert a (user, provider) credential can't collide
// with provider_credentials' unique(user_id, provider).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { Connector, SyncContext } from "./connectors/types.js";
import { lockTestResource } from "./test-support/advisory-lock.js";

// Hoisted (runs before imports): a fixed vault key so the push tests can seal credentials without
// touching the operator's key file, and a mock for the module-level audit() that startRestEdge
// injects — the smoke test below proves the wiring by observing entries through the mock.
const auditMock = vi.hoisted(() => {
  process.env.PCI_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");
  return vi.fn();
});
vi.mock("./audit/index.js", () => ({ audit: auditMock }));

const { registerConnectors, startRestEdge, startPushConnectors } = await import("./bootstrap.js");
const { registerConnector, getConnector } = await import("./sync/registry.js");

const HAS_DB = !!process.env.DATABASE_URL;

// The DB-gated half of this file polls in REAL time (see `eventually` below) while the fake clock
// stands still, and each poll waits out a real Postgres round-trip plus a vault open. Vitest's
// default 5s test budget was the SAME as the pollers' own default budget, so the harness always
// killed the test first: you got an opaque "Test timed out in 5000ms" instead of the poller's
// "timed out waiting for <label>", and a loaded CI runner tipped it over (2026-07-24, the first
// green CI run in 12 days). Give the harness real headroom and keep the pollers strictly under it,
// so a genuine hang still fails — with the message that says which condition never came true.
vi.setConfig({ testTimeout: 30_000 });
const POLL_BUDGET_MS = 10_000;
/** Dedicated control-plane user for this file's rows (cascade-deleted in afterAll). */
const BOOT_USER = "00000000-0000-0000-0000-00000000b007";

// Captured BEFORE any fake-timer install so polling can wait out real DB/socket I/O while the
// fake clock stands still.
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

/** Poll (in REAL time) until cond() is true. Date is never faked here (toFake excludes it). */
async function eventually(cond: () => boolean, label: string, timeoutMs = POLL_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await realWait(10);
  }
}

/** Poll (in REAL time) until an ASYNC cond() resolves true — for conditions behind real DB I/O. */
async function eventuallyAsync(
  cond: () => Promise<boolean>,
  label: string,
  timeoutMs = POLL_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await realWait(25);
  }
}

/** Grab an OS-assigned free port (bind a throwaway server on 0, read, release). */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** fetch() with retries while the server's async bind completes. */
async function fetchWhenUp(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 100; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await realWait(20);
    }
  }
  throw lastErr;
}

/** A recording push connector: start() throws for the first `failures` calls, then succeeds. */
function fakePush(provider: string, opts: { failures?: number; failureMessage?: string } = {}) {
  const startCalls: SyncContext[] = [];
  const stopCalls: string[] = [];
  let failures = opts.failures ?? 0;
  const connector: Connector & { start(ctx: SyncContext): Promise<void>; stop(id: string): void } = {
    provider,
    sector: "home",
    objectType: "home_entity",
    policy: { mode: "push", supportsIncremental: false },
    actions: [],
    async start(ctx: SyncContext) {
      startCalls.push(ctx);
      if (failures > 0) {
        failures--;
        throw new Error(opts.failureMessage ?? "connect refused (fake)");
      }
    },
    stop(connectionId: string) {
      stopCalls.push(connectionId);
    },
    // eslint-disable-next-line require-yield
    async *sync() {
      return;
    },
    normalize: () => ({}),
    strongKeys: () => ({}),
    execute: async () => ({ ok: true }),
  };
  return { connector, startCalls, stopCalls };
}

/**
 * A push connector whose start() BLOCKS until the test releases it, then throws. This is the only
 * way to reproduce the #97 race honestly: scan() selects `status in ('active','error')`, so a row
 * that is ALREADY paused never enters the scan at all and no status writer ever touches it. The real
 * resurrection window is an operator pause landing between the scan's select and the failing
 * attempt's status write-back.
 */
function gatedPush(provider: string, failureMessage: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = { entered: false };
  const connector: Connector & { start(ctx: SyncContext): Promise<void>; stop(id: string): void } = {
    provider,
    sector: "home",
    objectType: "home_entity",
    policy: { mode: "push", supportsIncremental: false },
    actions: [],
    async start() {
      state.entered = true;
      await gate;
      throw new Error(failureMessage);
    },
    stop() {},
    // eslint-disable-next-line require-yield
    async *sync() {
      return;
    },
    normalize: () => ({}),
    strongKeys: () => ({}),
    execute: async () => ({ ok: true }),
  };
  return { connector, state, release: () => release() };
}

/** A scripted push connector: start() call i throws outcomes[i] (a message) or succeeds on null. */
function scriptedPush(provider: string, outcomes: Array<string | null>) {
  const startCalls: SyncContext[] = [];
  const connector: Connector & { start(ctx: SyncContext): Promise<void>; stop(id: string): void } = {
    provider,
    sector: "home",
    objectType: "home_entity",
    policy: { mode: "push", supportsIncremental: false },
    actions: [],
    async start(ctx: SyncContext) {
      const i = startCalls.length;
      startCalls.push(ctx);
      const msg = outcomes[Math.min(i, outcomes.length - 1)];
      if (msg != null) throw new Error(msg);
    },
    stop() {},
    // eslint-disable-next-line require-yield
    async *sync() {
      return;
    },
    normalize: () => ({}),
    strongKeys: () => ({}),
    execute: async () => ({ ok: true }),
  };
  return { connector, startCalls };
}

// Track inserted credentials so each test's rows are gone before the next startPushConnectors scan.
const credentialIds: string[] = [];

/** Insert credential (+sealed token unless secret:null) + connector row under BOOT_USER. */
async function insertConnection(
  provider: string,
  opts: { secret?: string | null; status?: string; instanceUrl?: string } = {},
): Promise<{ connectionId: string; credentialId: string; secretRef: string | null }> {
  const { pool } = await import("./db.js");
  let secretRef: string | null = null;
  if (opts.secret !== null) {
    const { seal } = await import("./secrets/index.js");
    secretRef = await seal({ userId: BOOT_USER, provider, purpose: "access" }, opts.secret ?? "tok-123");
  }
  const cred = await pool.query(
    `insert into provider_credentials (user_id, provider, custody, secret_ref, instance_url)
     values ($1, $2, 'static_token', $3, $4) returning id`,
    [BOOT_USER, provider, secretRef, opts.instanceUrl ?? null],
  );
  const credentialId = cred.rows[0].id as string;
  credentialIds.push(credentialId);
  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status)
     values ($1, $2, 'home', $3, $4) returning id`,
    [BOOT_USER, credentialId, provider, opts.status ?? "active"],
  );
  return { connectionId: conn.rows[0].id as string, credentialId, secretRef };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("./db.js");
  await pool.query(
    `insert into users (id, label) values ($1, 'w5-boot-wiring-test') on conflict (id) do nothing`,
    [BOOT_USER],
  );
});

afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("./db.js");
  // Cascade wipes this file's credentials/connectors/secrets in one statement.
  await pool.query(`delete from users where id = $1`, [BOOT_USER]);
  await pool.end();
});

describe("registerConnectors", () => {
  it("registers the shipped connectors under their declared providers", () => {
    registerConnectors();
    expect(getConnector("simplefin")?.sector).toBe("finance");
    expect(getConnector("home_assistant")?.sector).toBe("home");
  });

  it("is idempotent — safe to call more than once (last registration wins)", () => {
    registerConnectors();
    registerConnectors();
    expect(getConnector("simplefin")).toBeDefined();
    expect(getConnector("home_assistant")).toBeDefined();
  });
});

describe("startRestEdge", () => {
  const savedPort = process.env.REST_PORT;
  const savedHost = process.env.REST_HOST;

  afterEach(() => {
    if (savedPort == null) delete process.env.REST_PORT;
    else process.env.REST_PORT = savedPort;
    if (savedHost == null) delete process.env.REST_HOST;
    else process.env.REST_HOST = savedHost;
    vi.restoreAllMocks();
  });

  it("honors a custom REST_PORT and serves the REST app", async () => {
    const port = await freePort();
    process.env.REST_PORT = String(port);
    const edge = startRestEdge();
    expect(edge).not.toBeNull();
    expect(edge!.port).toBe(port);
    // Hit an /api miss (still a deterministic 404 JSON) — a non-/api path now SPA-falls-back to the
    // Console (200 index.html) when apps/web/dist is built, so /api is the robust "router mounted" probe.
    const res = await fetchWhenUp(`http://127.0.0.1:${port}/api/no-such-route`);
    expect(res.status).toBe(404); // the router answered — the app is mounted
    await edge!.close();
  });

  it("REST_PORT=0 disables the edge → null", () => {
    process.env.REST_PORT = "0";
    expect(startRestEdge()).toBeNull();
  });

  it("an invalid REST_PORT disables the edge → null", () => {
    process.env.REST_PORT = "not-a-port";
    expect(startRestEdge()).toBeNull();
  });

  it("a bind conflict logs to stderr and gives up — close() resolves, the process never crashes", async () => {
    const port = await freePort();
    const squatter: Server = createServer(() => {});
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", () => r()));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.env.REST_PORT = String(port);
    const edge = startRestEdge();
    expect(edge).not.toBeNull();
    await edge!.close(); // settles even though the bind failed — never hangs, never throws

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("REST edge failed"))).toBe(true);
    await new Promise<void>((r) => squatter.close(() => r()));
  });

  // ── #97 item 7: `ready` makes index.ts's "REST edge listening on …" line honest ──
  it("startRestEdge reports ready=true once the socket is actually bound", async () => {
    const port = await freePort();
    process.env.REST_PORT = String(port);
    const edge = startRestEdge();
    expect(edge).not.toBeNull();
    await expect(edge!.ready).resolves.toBe(true);
    // Not just the flag: the socket really is accepting connections by the time ready settles.
    const res = await fetch(`http://127.0.0.1:${port}/api/no-such-route`);
    expect(res.status).toBe(404);
    await edge!.close();
  });

  it("startRestEdge reports ready=false when the port is already taken", async () => {
    // The original defect: index.ts printed "REST edge listening on <port>" the instant
    // startRestEdge() returned, which is BEFORE the bind settles — a lie on EADDRINUSE. A `ready`
    // hardcoded to Promise.resolve(true) passes the previous case and fails this one.
    const port = await freePort();
    const squatter: Server = createServer(() => {});
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", () => r()));
    vi.spyOn(console, "error").mockImplementation(() => {});

    process.env.REST_PORT = String(port);
    const edge = startRestEdge();
    expect(edge).not.toBeNull();
    await expect(edge!.ready).resolves.toBe(false);
    await expect(edge!.close()).resolves.toBeUndefined(); // still never hangs, never throws

    await new Promise<void>((r) => squatter.close(() => r()));
  });

  it.skipIf(!HAS_DB)("injects the module-level audit — a mirror read lands an entry (smoke)", async () => {
    const { pool } = await import("./db.js");
    const { mintAgentKey } = await import("./rest/index.js");
    const { key, keyHash } = mintAgentKey();
    const agentId = `w5-boot-smoke-${Date.now()}`;
    await pool.query(
      `insert into agent_grants (user_id, agent_id, key_hash, sectors) values ($1, $2, $3, '{}')`,
      [BOOT_USER, agentId, keyHash],
    );
    try {
      const port = await freePort();
      process.env.REST_PORT = String(port);
      auditMock.mockClear();
      const edge = startRestEdge();
      const res = await fetchWhenUp(`http://127.0.0.1:${port}/api/context`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.status).toBe(200);
      // The mirror fires the hook OFF the response path — wait for the async enqueue.
      await eventually(() => auditMock.mock.calls.length > 0, "audit entry");
      const entry = auditMock.mock.calls[0][0];
      expect(entry.tool).toBe("describe_context");
      expect(entry.decision).toBe("allow");
      expect(entry.agentId).toBe(agentId);
      await edge!.close();
    } finally {
      await pool.query(`delete from agent_grants where key_hash = $1`, [keyHash]);
    }
  });
});

describe.skipIf(!HAS_DB)("startPushConnectors", () => {
  const savedHaUrl = process.env.HA_URL;

  // #43 Contention A: startPushConnectors' scan() is table-wide + un-user-scoped, so with HA_URL
  // deleted it flips homeassistant.db.test.ts's seed-user HA connector to status='error' mid-test.
  // Hold the "push-connector-scan" advisory lock for the whole describe (all ~20 scans) so the two
  // contenders serialize across parallel vitest forks on the shared *_test DB (same idiom as #38).
  let releaseLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseLock = await lockTestResource("push-connector-scan");
  }, 120_000);
  afterAll(async () => {
    await releaseLock?.();
  });

  beforeEach(() => {
    // HA rows must hit the skip path deterministically (and never reach a real HA).
    delete process.env.HA_URL;
    // Real wall-clock Date stays (isStale/eventually need it); only the timer fns are faked.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (savedHaUrl == null) delete process.env.HA_URL;
    else process.env.HA_URL = savedHaUrl;
    // Drop this test's rows so the next test's scan starts from a clean table.
    const { pool } = await import("./db.js");
    while (credentialIds.length > 0) {
      await pool.query(`delete from provider_credentials where id = $1`, [credentialIds.pop()]);
    }
  });

  it("starts an active push connection with the opened token; stop() stops it", async () => {
    const { connector, startCalls, stopCalls } = fakePush("fake_push_w5a");
    registerConnector(connector);
    const { connectionId, secretRef } = await insertConnection("fake_push_w5a", { secret: "tok-abc" });

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1);
    expect(startCalls[0]).toMatchObject({
      userId: BOOT_USER,
      connectionId,
      secretRef,
      secret: "tok-abc", // opened from the vault, handed to start() in plaintext
    });

    stop();
    expect(stopCalls).toEqual([connectionId]); // started connections are stopped
  });

  it("retries an initial failure with capped backoff, calling stop() before each retry", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls, stopCalls } = fakePush("fake_push_w5b", { failures: 2 });
    registerConnector(connector);
    const { connectionId } = await insertConnection("fake_push_w5b");

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1); // attempt 1 failed; retry scheduled at +5s
    expect(stopCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await eventually(() => startCalls.length === 2, "second attempt");
    expect(stopCalls).toEqual([connectionId]); // stop() ran BEFORE the retry

    // Backoff doubled: nothing at +9.999s, the third attempt at +10s.
    await vi.advanceTimersByTimeAsync(9_999);
    await realWait(50);
    expect(startCalls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await eventually(() => startCalls.length === 3, "third attempt");
    expect(stopCalls).toEqual([connectionId, connectionId]);

    // Attempt 3 succeeded — no further retries fire.
    await vi.advanceTimersByTimeAsync(120_000);
    await realWait(50);
    expect(startCalls.length).toBe(3);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("retrying in 5000ms"))).toBe(true);
    stop();
  });

  it("the auth-failure message is terminal — no retries, ever", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls, stopCalls } = fakePush("fake_push_w5c", {
      failures: 99,
      failureMessage: "home assistant auth failed: invalid token",
    });
    registerConnector(connector);
    await insertConnection("fake_push_w5c");

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(300_000); // through several would-be retries AND re-scans
    await realWait(100);
    expect(startCalls.length).toBe(1); // terminal: never re-attempted
    expect(stopCalls.length).toBe(0);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("auth failed — not retrying"))).toBe(true);
    stop();
  });

  it("HA_URL unset → home_assistant rows are skipped with one stderr line, not retried", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("home_assistant");
    registerConnector(connector); // replaces the real connector for this process (last wins)
    const { connectionId } = await insertConnection("home_assistant");

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(0);
    expect(
      errSpy.mock.calls.some(
        (c) => String(c[0]).includes(connectionId) && String(c[0]).includes("HA_URL unset"),
      ),
    ).toBe(true);

    // #4: the skip is no longer false-healthy — the row reports an honest status='error' + last_error.
    const { pool } = await import("./db.js");
    const r = await pool.query(`select status, last_error from connectors where id = $1`, [connectionId]);
    expect(r.rows[0].status).toBe("error");
    expect(r.rows[0].last_error).not.toBeNull();

    await vi.advanceTimersByTimeAsync(120_000); // re-scans stay quiet — misconfiguration is not retried
    await realWait(100);
    expect(startCalls.length).toBe(0);
    stop();
  });

  it("#3 a per-credential instance_url + HA_URL unset → home_assistant STARTS (no env needed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("home_assistant");
    registerConnector(connector); // replaces the real connector for this process (last wins)
    const { connectionId } = await insertConnection("home_assistant", {
      secret: "tok-ha",
      instanceUrl: "http://homeassistant.local:8123",
    });

    const stop = await startPushConnectors();
    // NOT skipped — the per-credential URL carries the address even with HA_URL unset.
    expect(startCalls.length).toBe(1);
    expect(startCalls[0].connectionId).toBe(connectionId);
    // instance_url is threaded into start() as ctx.haUrl (homeassistant.ts: ctx.haUrl ?? HA_URL).
    expect((startCalls[0] as SyncContext & { haUrl?: string }).haUrl).toBe("http://homeassistant.local:8123");
    // The honest status is cleared back to active on the successful start.
    const { pool } = await import("./db.js");
    const r = await pool.query(`select status from connectors where id = $1`, [connectionId]);
    expect(r.rows[0].status).toBe("active");
    stop();
  });

  it("#3 NEITHER instance_url NOR HA_URL → home_assistant is skipped (status='error')", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("home_assistant");
    registerConnector(connector);
    const { connectionId } = await insertConnection("home_assistant"); // no instance_url, HA_URL unset

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(0); // the relaxed skip still fires when BOTH are absent
    expect(
      errSpy.mock.calls.some(
        (c) => String(c[0]).includes(connectionId) && String(c[0]).includes("HA_URL unset"),
      ),
    ).toBe(true);
    const { pool } = await import("./db.js");
    const r = await pool.query(`select status, last_error from connectors where id = $1`, [connectionId]);
    expect(r.rows[0].status).toBe("error");
    expect(r.rows[0].last_error).not.toBeNull();
    stop();
  });

  it("#4 recovery: setting HA_URL + re-running flips the row back to active, clearing last_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("home_assistant");
    registerConnector(connector);
    const { connectionId } = await insertConnection("home_assistant");
    const { pool } = await import("./db.js");

    // First run with HA_URL unset → the terminal skip path flips the row to status='error'.
    const stop1 = await startPushConnectors();
    let r = await pool.query(`select status, last_error from connectors where id = $1`, [connectionId]);
    expect(r.rows[0].status).toBe("error");
    expect(r.rows[0].last_error).not.toBeNull();
    stop1();

    // Recovery: HA_URL set + a FRESH startPushConnectors() (new tracked map) → start() succeeds →
    // attempt()'s clear-to-active flips the row back. (Recovery-without-restart is out of scope —
    // a fresh process/instance is the documented requirement.)
    process.env.HA_URL = "http://ha.local:8123";
    const stop2 = await startPushConnectors();
    expect(startCalls.length).toBe(1); // the connection actually started this time
    r = await pool.query(`select status, last_error, last_error_at from connectors where id = $1`, [
      connectionId,
    ]);
    expect(r.rows[0].status).toBe("active");
    expect(r.rows[0].last_error).toBeNull();
    expect(r.rows[0].last_error_at).toBeNull();
    stop2();
  });

  it("a missing credential is skipped, not retried", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("fake_push_w5d");
    registerConnector(connector);
    await insertConnection("fake_push_w5d", { secret: null }); // secret_ref null

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(0);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("no credential — skipping"))).toBe(true);
    stop();
  });

  it("poll-mode and start-less connectors are ignored", async () => {
    const pollCalls: SyncContext[] = [];
    const pollConnector: Connector & { start(ctx: SyncContext): Promise<void> } = {
      provider: "fake_poll_w5",
      sector: "home",
      objectType: "home_entity",
      policy: { mode: "poll", defaultIntervalSec: 3600, supportsIncremental: true },
      actions: [],
      async start(ctx: SyncContext) {
        pollCalls.push(ctx);
      },
      // eslint-disable-next-line require-yield
      async *sync() {
        return;
      },
      normalize: () => ({}),
      strongKeys: () => ({}),
      execute: async () => ({ ok: true }),
    };
    const startless: Connector = {
      provider: "fake_pushless_w5",
      sector: "home",
      objectType: "home_entity",
      policy: { mode: "push", supportsIncremental: false },
      actions: [],
      // eslint-disable-next-line require-yield
      async *sync() {
        return;
      },
      normalize: () => ({}),
      strongKeys: () => ({}),
      execute: async () => ({ ok: true }),
    };
    registerConnector(pollConnector);
    registerConnector(startless);
    await insertConnection("fake_poll_w5");
    await insertConnection("fake_pushless_w5");

    const stop = await startPushConnectors();
    expect(pollCalls.length).toBe(0); // poll-mode: never started, even though it HAS a start()
    stop();
  });

  it("stop() cancels a pending retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("fake_push_w5e", { failures: 99 });
    registerConnector(connector);
    await insertConnection("fake_push_w5e");

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1); // failed; a +5s retry is pending
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    await realWait(50);
    expect(startCalls.length).toBe(1); // the cancelled retry never fired
  });

  // ── #39 stream-state persistence (spec push-freshness-honesty, child B1) ─────
  async function streamRow(connectionId: string) {
    const { pool } = await import("./db.js");
    const res = await pool.query(
      // ::text keeps Postgres' microsecond precision — a JS Date would round to ms and could hide
      // a wrongful re-stamp that lands within the same millisecond.
      `select status, stream_state, stream_error, stream_changed_at::text as since
         from connectors where id = $1`,
      [connectionId],
    );
    return res.rows[0] as {
      status: string;
      stream_state: string | null;
      stream_error: string | null;
      since: string | null;
    };
  }

  it("#39 a failing attempt() → stream_state='retrying' + MASKED stream_error, status UNCHANGED; stream_changed_at stamps once across retries; success → 'connected' + null error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = scriptedPush("fake_push_fb1a", [
      "boom-1 https://user:pass@bridge.example/accounts?token=zzz refused",
      "boom-2 still refused",
      null, // third attempt succeeds
    ]);
    registerConnector(connector);
    const { connectionId } = await insertConnection("fake_push_fb1a");

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1); // attempt 1 failed (scan awaited the attempt's bookkeeping)

    let r = await streamRow(connectionId);
    expect(r.status).toBe("active"); // a generic start failure NEVER touches status
    expect(r.stream_state).toBe("retrying");
    expect(r.stream_error).toContain("boom-1");
    expect(r.stream_error).toContain("//***@"); // basic-auth userinfo masked
    expect(r.stream_error).toContain("token=***"); // secret query param masked
    expect(r.stream_error).not.toContain("user:pass");
    expect(r.since).not.toBeNull();
    const firstStamp = r.since;

    // Retry 2 fails with a NEW message (proves the write landed) — same state, NO re-stamp.
    await vi.advanceTimersByTimeAsync(5_000);
    await eventuallyAsync(
      async () => (await streamRow(connectionId)).stream_error?.includes("boom-2") === true,
      "second retry's stream_error",
    );
    r = await streamRow(connectionId);
    expect(r.status).toBe("active");
    expect(r.stream_state).toBe("retrying");
    expect(r.since).toBe(firstStamp); // retrying → retrying is NOT a transition

    // Retry 3 succeeds → 'connected', error cleared, transition re-stamped, status still active.
    await vi.advanceTimersByTimeAsync(10_000);
    await eventuallyAsync(
      async () => (await streamRow(connectionId)).stream_state === "connected",
      "successful attempt's 'connected'",
    );
    r = await streamRow(connectionId);
    expect(r.status).toBe("active");
    expect(r.stream_error).toBeNull();
    expect(r.since).not.toBe(firstStamp); // retrying → connected IS a transition
    stop();
  });

  it("#39 the auth-terminal path marks stream_state='down' in addition to status='error'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector } = fakePush("fake_push_fb1b", {
      failures: 99,
      failureMessage: "home assistant auth failed: invalid token",
    });
    registerConnector(connector);
    const { connectionId } = await insertConnection("fake_push_fb1b");

    const stop = await startPushConnectors();
    const r = await streamRow(connectionId);
    expect(r.status).toBe("error"); // markPushError, unchanged (#4)
    expect(r.stream_state).toBe("down");
    expect(r.stream_error).toBe("auth failed: invalid token");
    expect(r.since).not.toBeNull();
    stop();
  });

  it("#39 the scan-terminal misconfiguration paths mark stream_state='down'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector } = fakePush("home_assistant");
    registerConnector(connector);
    const noUrl = await insertConnection("home_assistant"); // no instance_url, HA_URL unset
    const { connector: credless } = fakePush("fake_push_fb1c");
    registerConnector(credless);
    const noCred = await insertConnection("fake_push_fb1c", { secret: null });

    const stop = await startPushConnectors();
    const r1 = await streamRow(noUrl.connectionId);
    expect(r1.stream_state).toBe("down");
    expect(r1.stream_error).toBe("no instance URL (HA_URL unset)");
    const r2 = await streamRow(noCred.connectionId);
    expect(r2.stream_state).toBe("down");
    expect(r2.stream_error).toBe("no credential");
    stop();
  });

  it("#39 departed-row cleanup marks stream 'down','stopped' — and never resurrects the departing status", async () => {
    const { connector } = fakePush("fake_push_fb1d");
    registerConnector(connector);
    const { connectionId } = await insertConnection("fake_push_fb1d");
    const { pool } = await import("./db.js");

    const stop = await startPushConnectors();
    expect((await streamRow(connectionId)).stream_state).toBe("connected");

    await pool.query(`update connectors set status = 'paused' where id = $1`, [connectionId]);
    await vi.advanceTimersByTimeAsync(60_000); // next re-scan: the paused row departs → cleanup
    await eventuallyAsync(
      async () => (await streamRow(connectionId)).stream_state === "down",
      "departed-row 'down'",
    );
    const r = await streamRow(connectionId);
    expect(r.stream_error).toBe("stopped");
    expect(r.status).toBe("paused"); // the stream writer NEVER touches status
    stop();
  });

  it("#39 a PAUSED connection's stream writers change stream columns only — never status", async () => {
    const { markStreamState } = await import("./sync/index.js");
    const { connectionId } = await insertConnection("fake_push_fb1e", { status: "paused" });

    await markStreamState(connectionId, "retrying", "socket closed — reconnecting");
    let r = await streamRow(connectionId);
    expect(r.status).toBe("paused");
    expect(r.stream_state).toBe("retrying");
    expect(r.stream_error).toBe("socket closed — reconnecting");

    await markStreamState(connectionId, "down", "stopped");
    r = await streamRow(connectionId);
    expect(r.status).toBe("paused"); // no pause/revoke resurrection, by construction
    expect(r.stream_state).toBe("down");
  });

  // ── #41 credential-change-keyed restart ────────────────────────────────────
  /** Re-seal the credential IN PLACE: a fresh vault ref repointed on the SAME row — byte-for-byte
   *  what POST /api/credentials' upsert does on a Console re-paste (seal mints a new sec_<uuid>). */
  async function resealCredential(credentialId: string, provider: string, secret: string): Promise<string> {
    const { pool } = await import("./db.js");
    const { seal } = await import("./secrets/index.js");
    const ref = await seal({ userId: BOOT_USER, provider, purpose: "access" }, secret);
    await pool.query(`update provider_credentials set secret_ref = $2 where id = $1`, [credentialId, ref]);
    return ref;
  }

  it("#41 a started-then-dead ('down') entry is NOT re-attempted while the credential is unchanged (no-hammer), and restarts on a re-sealed secret_ref — stop() before the fresh start, new token", async () => {
    const { connector, startCalls, stopCalls } = fakePush("fake_push_r41a");
    registerConnector(connector);
    const { connectionId, credentialId } = await insertConnection("fake_push_r41a", { secret: "tok-old" });

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1);
    expect((await streamRow(connectionId)).stream_state).toBe("connected");

    // Mid-run terminal death: the WS client marked its stream 'down' (bootstrap's entry is still
    // started=true — exactly the once-unrecoverable state #41 targets).
    const { markStreamState } = await import("./sync/index.js");
    await markStreamState(connectionId, "down", "auth failed: invalid token");

    // NO-HAMMER PIN: re-scans with an UNCHANGED secret_ref/instance_url never re-attempt.
    await vi.advanceTimersByTimeAsync(60_000);
    await realWait(200);
    expect(startCalls.length).toBe(1);
    expect((await streamRow(connectionId)).stream_state).toBe("down");

    // Re-seal (the Console re-paste shape): the next scan evicts + starts fresh with the NEW token.
    await resealCredential(credentialId, "fake_push_r41a", "tok-new");
    await vi.advanceTimersByTimeAsync(60_000);
    await eventually(() => startCalls.length === 2, "restart after re-seal");
    expect(stopCalls).toContain(connectionId); // evict stops the dead connection BEFORE the fresh start
    expect(startCalls[1].secret).toBe("tok-new"); // opened from the NEW ref, not the stale closure
    await eventuallyAsync(
      async () => (await streamRow(connectionId)).stream_state === "connected",
      "healed stream",
    );
    stop();
  });

  it("#41 an auth-TERMINAL entry stays quiet on unchanged creds and re-attempts only on a re-seal (backoff state fresh)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("fake_push_r41b", {
      failures: 1,
      failureMessage: "home assistant auth failed: invalid token",
    });
    registerConnector(connector);
    const { connectionId, credentialId } = await insertConnection("fake_push_r41b", { secret: "tok-bad" });

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1); // terminal — status='error', stream 'down'
    expect((await streamRow(connectionId)).status).toBe("error");

    // Unchanged credential: terminal means terminal (the existing 300s pin, re-asserted here).
    await vi.advanceTimersByTimeAsync(120_000);
    await realWait(200);
    expect(startCalls.length).toBe(1);

    // Re-seal → evict + fresh attempt; the good token starts, error clears back to active.
    await resealCredential(credentialId, "fake_push_r41b", "tok-good");
    await vi.advanceTimersByTimeAsync(60_000);
    await eventually(() => startCalls.length === 2, "terminal entry re-attempted after re-seal");
    expect(startCalls[1].secret).toBe("tok-good");
    await eventuallyAsync(
      async () => (await streamRow(connectionId)).status === "active",
      "status healed to active",
    );
    expect((await streamRow(connectionId)).stream_state).toBe("connected");
    stop();
  });

  it("#41 a terminal no-instance-URL entry re-attempts when the Console fixes instance_url", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("home_assistant");
    registerConnector(connector);
    // No instance_url + HA_URL unset → the terminal misconfiguration skip.
    const { connectionId, credentialId } = await insertConnection("home_assistant", { secret: "tok-ha" });

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(0);
    expect((await streamRow(connectionId)).stream_state).toBe("down");

    // The Console re-paste sets instance_url on the SAME credential row → next scan starts it.
    const { pool } = await import("./db.js");
    await pool.query(`update provider_credentials set instance_url = $2 where id = $1`, [
      credentialId,
      "http://ha.fixed:8123",
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await eventually(() => startCalls.length === 1, "start after instance_url fix");
    expect(startCalls[0].connectionId).toBe(connectionId);
    expect((startCalls[0] as SyncContext & { haUrl?: string }).haUrl).toBe("http://ha.fixed:8123");
    stop();
  });

  it("#41 a 'retrying' entry is never touched — its own backoff loop stays the owner even across a re-seal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector, startCalls } = fakePush("fake_push_r41c", { failures: 99 });
    registerConnector(connector);
    const { connectionId, credentialId } = await insertConnection("fake_push_r41c", { secret: "tok-old" });

    const stop = await startPushConnectors();
    expect(startCalls.length).toBe(1); // failed; the bootstrap backoff loop owns it now
    expect((await streamRow(connectionId)).stream_state).toBe("retrying");

    await resealCredential(credentialId, "fake_push_r41c", "tok-new");
    await vi.advanceTimersByTimeAsync(60_000); // retries at +5/+15/+35s AND the +60s re-scan
    await realWait(200);
    const r = await streamRow(connectionId);
    expect(r.stream_state).toBe("retrying"); // never evicted ('down' + 'restarting…' never written)
    expect(r.stream_error).not.toContain("restarting");
    // Every attempt came from the ORIGINAL closure (the old ref) — the scan never rebuilt it.
    for (const call of startCalls) expect(call.secret).toBe("tok-old");
    stop();
  });

  it("#41 the retry stderr line is MASKED — a credentialed URL never reaches the log", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connector } = scriptedPush("fake_push_r41m", [
      "connect https://user:pass@ha.example/ws?token=zzz refused",
      null,
    ]);
    registerConnector(connector);
    await insertConnection("fake_push_r41m");

    const stop = await startPushConnectors();
    const line = errSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("failed to start"));
    expect(line).toBeDefined();
    expect(line).toContain("//***@"); // basic-auth userinfo masked
    expect(line).toContain("token=***"); // secret query param masked
    expect(line).not.toContain("user:pass");
    expect(line).not.toContain("token=zzz");
    stop();
  });

  // ── #97: the push starter must never resurrect an operator pause/revoke ──────
  //
  // markPushError (deleted) wrote `status='error'` UNGUARDED. markError carries
  // `where ... and status not in ('paused','revoked')`. The mutation these two pin: swap markError
  // back for the unguarded write and the operator's verb is silently overwritten.
  async function pauseRacesPushFailure(status: "paused" | "revoked", provider: string) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = await import("./db.js");
    // The auth-failure message is the terminal branch — the one that writes status before giving up.
    const { connector, state, release } = gatedPush(provider, "home assistant auth failed: invalid token");
    registerConnector(connector);
    const { connectionId } = await insertConnection(provider, { status: "active" });

    const booting = startPushConnectors(); // scan() selected the row while it was still active
    await eventually(() => state.entered, "start() entered");

    // The operator acts mid-attempt — exactly the race the guard exists for.
    await pool.query(`update connectors set status = $2 where id = $1`, [connectionId, status]);
    release();
    const stop = await booting;

    const r = await pool.query(`select status, last_error, last_error_at from connectors where id = $1`, [
      connectionId,
    ]);
    expect(r.rows[0].status).toBe(status); // NOT flipped to 'error'
    expect(r.rows[0].last_error).toBeNull();
    expect(r.rows[0].last_error_at).toBeNull();
    stop();
  }

  it("a paused connection is not flipped to error by a push start failure", async () => {
    await pauseRacesPushFailure("paused", "fake_push_v97p");
  });

  it("a revoked connection is not flipped to error by a push start failure", async () => {
    await pauseRacesPushFailure("revoked", "fake_push_v97r");
  });

  it("an ACTIVE connection is still flipped to error by a push start failure (the guard is not a mute)", async () => {
    // The companion pin: a guard that refused every write would pass both cases above.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = await import("./db.js");
    const { connector } = fakePush("fake_push_v97a", {
      failures: 99,
      failureMessage: "home assistant auth failed: invalid token",
    });
    registerConnector(connector);
    const { connectionId } = await insertConnection("fake_push_v97a");

    const stop = await startPushConnectors();
    const r = await pool.query(`select status, last_error from connectors where id = $1`, [connectionId]);
    expect(r.rows[0].status).toBe("error");
    expect(r.rows[0].last_error).toBe("auth failed: invalid token");
    stop();
  });

  it("re-scan: a connection onboarded after boot starts without a restart; a revoked row is stopped", async () => {
    const { connector, startCalls, stopCalls } = fakePush("fake_push_w5f");
    registerConnector(connector);

    const stop = await startPushConnectors(); // boots with NO rows for this provider
    expect(startCalls.length).toBe(0);

    const { connectionId } = await insertConnection("fake_push_w5f");
    await vi.advanceTimersByTimeAsync(60_000); // next periodic re-scan
    await eventually(() => startCalls.length === 1, "re-scan start");
    expect(startCalls[0].connectionId).toBe(connectionId);

    const { pool } = await import("./db.js");
    await pool.query(`update connectors set status = 'revoked' where id = $1`, [connectionId]);
    await vi.advanceTimersByTimeAsync(60_000);
    await eventually(() => stopCalls.includes(connectionId), "re-scan stop");
    stop();
  });
});

// ── merge-fold (#39/#40 review MEDIUM): markError must never clobber an operator pause/revoke ──
// An event-driven writer (HA mid-run auth death → handleStreamDown → markError) can race the operator
// verb; the guard `status not in ('paused','revoked')` makes the operator win, and keeps a revoked row
// out of the push scan (which selects active|error).
describe.skipIf(!HAS_DB)("markError status guard", () => {
  it("skips paused and revoked rows; still flips an active row to error", async () => {
    const { pool } = await import("./db.js");
    const { markError } = await import("./sync/index.js");
    const statusOf = async (id: string) =>
      (await pool.query(`select status, last_error from connectors where id = $1`, [id])).rows[0] as {
        status: string;
        last_error: string | null;
      };

    const paused = await insertConnection("fake_poll_mf1", { status: "paused" });
    const revoked = await insertConnection("fake_poll_mf2", { status: "revoked" });
    const active = await insertConnection("fake_poll_mf3", { status: "active" });

    await markError(paused.connectionId, "boom");
    await markError(revoked.connectionId, "boom");
    await markError(active.connectionId, "boom");

    expect((await statusOf(paused.connectionId)).status).toBe("paused");
    expect((await statusOf(revoked.connectionId)).status).toBe("revoked");
    const flipped = await statusOf(active.connectionId);
    expect(flipped.status).toBe("error");
    expect(flipped.last_error).toBe("boom");
  });
});
