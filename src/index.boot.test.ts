// Boot-wiring tests for main() — specifically, that the fail-closed vault gate is actually REACHED
// on boot and actually REFUSES the boot when it throws (#97), and that the exposure setting the
// CONSOLE owns can never do the same thing (console-exposure-surface §Decision 3, ADR 0035).
//
// Why this file exists: assertVaultOpens() has its own unit coverage, but a gate that is exported
// and never called passes every one of those tests while protecting nothing. The wiring — one
// `await assertVaultOpens()` in index.ts, in the right place, OUTSIDE the best-effort try/catch
// blocks — is the thing that has to be pinned, and it is exactly the kind of cross-file step that
// gets dropped. It also pins the honest REST-edge bind line (#97 item 7).
//
// The §Decision 3 half was added at merge, after a reviewer proved the gap: re-introducing the #97
// shape in index.ts —
//     if (envCfg || (await resolveBridgeConfig()).cfg) { …refuse to boot without MCP_HTTP_PORT… }
// — turns a Console button into one that bricks the gateway, and the whole 2057-test suite stayed
// green. The properties held; nothing guarded them.
//
// Everything main() touches is mocked, so nothing here opens a socket, a DB connection or a vault.
// NOTE the exposure store is mocked EXPLICITLY (`./gateway/exposure-config.js`) and `./db.js` DOES
// export a `pool`: the cells below must go red for the reason they state, not because a missing
// `pool` export happens to make resolveBridgeConfig's DB read throw. That accident is exactly what a
// reviewer found propping up an adjacent guard, and it evaporates the moment someone adds the export.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountedBridgeConfig, noteBridgeMount } from "./mcp/oauth-bridge.js";
import type { ExposureRow } from "./gateway/exposure-config.js";

const boot = vi.hoisted(() => ({
  registerConnectors: vi.fn(),
  assertVaultOpens: vi.fn(async () => {}),
  startRestEdge: vi.fn(() => ({
    port: 8787,
    ready: Promise.resolve(true),
    close: async () => {},
  })),
  startPushConnectors: vi.fn(async () => () => {}),
  runMigrations: vi.fn(async () => {}),
  awaitDbReady: vi.fn(async () => {}),
  startScheduler: vi.fn(async () => () => {}),
  serverConnect: vi.fn(async () => {}),
  startHttpEdge: vi.fn((_opts: unknown) => ({ port: 8788, close: async () => {} })),
  getExposure: vi.fn(async (): Promise<ExposureRow | null> => null),
}));

vi.mock("./bootstrap.js", () => ({
  registerConnectors: boot.registerConnectors,
  assertVaultOpens: boot.assertVaultOpens,
  startRestEdge: boot.startRestEdge,
  startPushConnectors: boot.startPushConnectors,
}));
vi.mock("./db.js", () => ({
  awaitDbReady: boot.awaitDbReady,
  closePool: vi.fn(async () => {}),
  // Present ON PURPOSE — see the header note. No cell here may depend on its absence.
  pool: { query: async () => ({ rows: [], rowCount: 0 }) },
}));
vi.mock("./db/migrate.js", () => ({ runMigrations: boot.runMigrations }));
vi.mock("./sync/scheduler.js", () => ({ startScheduler: boot.startScheduler }));
vi.mock("./audit/index.js", () => ({ audit: vi.fn(), startAuditWriter: () => async () => {} }));
vi.mock("./auth/index.js", () => ({ resolveLocal: vi.fn() }));
vi.mock("./rest/index.js", () => ({ beginShutdown: vi.fn() }));
vi.mock("./mcp/http.js", () => ({ startHttpEdge: boot.startHttpEdge }));
vi.mock("./gateway/exposure-config.js", () => ({
  getExposure: boot.getExposure,
  setExposure: vi.fn(),
  clearExposure: vi.fn(),
}));
vi.mock("./mcp/server.js", () => ({
  buildServer: () => ({ connect: boot.serverConnect, close: async () => {} }),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

const { main } = await import("./index.js");

const ENV = ["MCP_PUBLIC_URL", "MCP_HTTP_PORT", "REST_HOST"] as const;
const saved: Record<string, string | undefined> = {};

/** Everything main() wrote to stderr this cell (stdout is the MCP protocol channel). */
let errorLines: string[] = [];

/** A stored exposure row, as the Console writes it. */
const row = (publicUrl: string): ExposureRow => ({
  publicUrl,
  consentedAt: new Date("2026-07-26T00:00:00Z"),
  updatedAt: null,
});

/** The `bridge` argument this boot handed the MCP HTTP edge — null = the bridge is OFF. */
function bridgeHandedToEdge(): unknown {
  expect(boot.startHttpEdge).toHaveBeenCalledTimes(1);
  return (boot.startHttpEdge.mock.calls[0][0] as { bridge: unknown }).bridge;
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  boot.assertVaultOpens.mockImplementation(async () => {});
  boot.startRestEdge.mockImplementation(() => ({
    port: 8787,
    ready: Promise.resolve(true),
    close: async () => {},
  }));
  boot.startHttpEdge.mockImplementation(() => ({ port: 8788, close: async () => {} }));
  boot.getExposure.mockImplementation(async () => null);
  // Module state in oauth-bridge.ts leaks across files in the same worker; start every cell from the
  // product's own default — nothing is being served.
  noteBridgeMount(null);
  errorLines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  noteBridgeMount(null);
  vi.restoreAllMocks();
  // main() installs signal handlers on success; drop them so the harness isn't left holding them.
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

describe("main(): the vault gate is wired into boot (#97)", () => {
  it("calls assertVaultOpens on every boot", async () => {
    await main();
    expect(boot.assertVaultOpens).toHaveBeenCalledTimes(1);
  });

  it("runs the gate AFTER migrations and BEFORE any edge serves", async () => {
    const order: string[] = [];
    boot.runMigrations.mockImplementation(async () => void order.push("migrate"));
    boot.assertVaultOpens.mockImplementation(async () => void order.push("vault-gate"));
    boot.startRestEdge.mockImplementation(() => {
      order.push("rest");
      return { port: 8787, ready: Promise.resolve(true), close: async () => {} };
    });
    boot.startPushConnectors.mockImplementation(async () => {
      order.push("push");
      return () => {};
    });

    await main();

    // The gate needs the schema, and nothing may serve or open a credential before it has passed.
    expect(order).toEqual(["migrate", "vault-gate", "rest", "push"]);
  });

  it("REFUSES to boot when the gate throws — the rejection is never swallowed", async () => {
    // The mutation this catches: wiring the gate inside startPushConnectors()' try/catch (or any
    // other best-effort block), which would turn a fail-closed gate into a log line. main()'s own
    // catch is what prints "refusing to start" and exits 1, so the rejection must reach it.
    const boom = new Error("vault key check FAILED: 12 sealed secret(s) …");
    boot.assertVaultOpens.mockImplementation(async () => {
      throw boom;
    });

    await expect(main()).rejects.toThrow(boom);
    // And nothing downstream got to run.
    expect(boot.startRestEdge).not.toHaveBeenCalled();
    expect(boot.startPushConnectors).not.toHaveBeenCalled();
  });
});

describe("main(): a Console-owned setting may NEVER refuse the boot (§Decision 3, the #97 shape)", () => {
  // The ONE anti-vacuity partner for this whole describe, and it must stay GREEN under every mutation
  // below. Without it, "resolve nothing, mount nothing, boot always" passes all four refusal cells.
  it("still refuses to boot when the BOX's own MCP_PUBLIC_URL has no MCP edge to mount on", async () => {
    process.env.MCP_PUBLIC_URL = "https://env.example";
    delete process.env.MCP_HTTP_PORT;
    boot.getExposure.mockImplementation(async () => null);

    // Byte-identical to the pre-exposure message: an operator with shell access set this, and the
    // refusal is the correct answer for a value only they can set.
    await expect(main()).rejects.toThrow(
      "MCP_PUBLIC_URL is set but MCP_HTTP_PORT is unset/invalid — the OAuth bridge mounts on the " +
        "MCP HTTP edge; set MCP_HTTP_PORT or unset MCP_PUBLIC_URL",
    );
    // And it refuses BEFORE anything runs — the gate sits above every subsystem.
    expect(boot.runMigrations).not.toHaveBeenCalled();
    expect(boot.startRestEdge).not.toHaveBeenCalled();
    expect(boot.startHttpEdge).not.toHaveBeenCalled();
  });

  // The second anti-vacuity partner: the plumbing CAN produce a live bridge, so "bridge OFF" below is
  // a real observation and not the only thing this wiring is capable of.
  it("mounts the stored address when there IS an MCP edge to publish it on", async () => {
    boot.getExposure.mockImplementation(async () => row("https://db.example"));
    process.env.MCP_HTTP_PORT = "8788";

    await main();

    expect(bridgeHandedToEdge()).toMatchObject({ publicUrl: "https://db.example" });
    expect(mountedBridgeConfig()).toMatchObject({ publicUrl: "https://db.example" });
  });

  it("boots with the bridge off when the stored address has no MCP edge to publish it on", async () => {
    // THE cell the #97 shape breaks. A Console-set row + no MCP_HTTP_PORT is a perfectly ordinary
    // state: the operator published the gate from the Console on a box whose compose file never set
    // the MCP port. Refusing the boot here would be a button in the Console that bricks the gateway.
    boot.getExposure.mockImplementation(async () => row("https://db.example"));
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_PUBLIC_URL;

    await expect(main()).resolves.toBeUndefined(); // it BOOTS

    // …and it boots with the bridge OFF, and knows it: no edge, so nothing was mounted and the status
    // route reports `serving: null` rather than a gate this process is not actually serving.
    expect(boot.startHttpEdge).not.toHaveBeenCalled();
    expect(mountedBridgeConfig()).toBeNull();
    // The rest of the gateway is up — "bridge off" is not "gateway down".
    expect(boot.startRestEdge).toHaveBeenCalledTimes(1);
  });

  it("boots with the bridge off when it cannot read its own exposure setting", async () => {
    boot.getExposure.mockImplementation(async () => {
      throw new Error("simulated gateway_exposure read fault");
    });
    process.env.MCP_HTTP_PORT = "8788";
    delete process.env.MCP_PUBLIC_URL;

    await expect(main()).resolves.toBeUndefined();

    expect(bridgeHandedToEdge()).toBeNull();
    expect(mountedBridgeConfig()).toBeNull();
    expect(errorLines.some((l) => l.includes("db_unreadable"))).toBe(true);
  });

  it("boots with the bridge off when the stored address is one it cannot parse", async () => {
    // A row written by a different build, or by hand. It must leave the gateway unpublished — never
    // half-published, and never unbootable.
    boot.getExposure.mockImplementation(async () => row("not a url"));
    process.env.MCP_HTTP_PORT = "8788";
    delete process.env.MCP_PUBLIC_URL;

    await expect(main()).resolves.toBeUndefined();

    expect(bridgeHandedToEdge()).toBeNull();
    expect(mountedBridgeConfig()).toBeNull();
    expect(errorLines.some((l) => l.includes("db_invalid"))).toBe(true);
  });

  it("boots with the bridge off when an older build stored an address carrying a path", async () => {
    // #126's older-build case, and the premise the unit's spec asked to be VERIFIED rather than
    // assumed: builds before the path rule accepted `https://host/mcp` and wrote it, so that row
    // exists in the field. It must resolve the same way any other unusable row does — bridge OFF,
    // problem NAMED — and never mount a gateway whose discovery documents advertise dead endpoints.
    boot.getExposure.mockImplementation(async () => row("https://db.example/mcp"));
    process.env.MCP_HTTP_PORT = "8788";
    delete process.env.MCP_PUBLIC_URL;

    await expect(main()).resolves.toBeUndefined(); // it BOOTS

    expect(bridgeHandedToEdge()).toBeNull();
    expect(mountedBridgeConfig()).toBeNull();
    expect(errorLines.some((l) => l.includes("db_invalid"))).toBe(true);
  });

  it("does not record itself as serving a gate whose edge never mounted", async () => {
    // §Decision 3's other direction: edge cannot mount ⇒ bridge OFF ⇒ the status route says so.
    // `serving` is the field the Console's safety sentence is built on ("it stays reachable until the
    // gateway restarts"), so it may only ever describe a mount that actually happened. Noting the
    // mount BEFORE startHttpEdge would leave this process claiming to publish a gate it does not.
    boot.getExposure.mockImplementation(async () => row("https://db.example"));
    process.env.MCP_HTTP_PORT = "8788";
    boot.startHttpEdge.mockImplementation(() => {
      throw new Error("EADDRINUSE 8788");
    });

    await expect(main()).rejects.toThrow("EADDRINUSE");
    expect(mountedBridgeConfig()).toBeNull();
  });
});

describe("main(): the REST-edge bind line is honest (#97 item 7)", () => {
  it("announces 'listening' only once the socket is actually bound", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    boot.startRestEdge.mockImplementation(() => ({
      port: 9001,
      ready: Promise.resolve(true),
      close: async () => {},
    }));

    await main();

    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("REST edge listening on") && l.includes("9001"))).toBe(true);
    expect(lines.some((l) => l.includes("failed to bind"))).toBe(false);
  });

  it("reports a failed bind instead of claiming a port it never got", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    boot.startRestEdge.mockImplementation(() => ({
      port: 9002,
      ready: Promise.resolve(false),
      close: async () => {},
    }));

    await main();

    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("REST edge failed to bind") && l.includes("9002"))).toBe(true);
    // The original defect: printing "listening on 9002" for a port that was never bound.
    expect(lines.some((l) => l.includes("REST edge listening on"))).toBe(false);
  });
});
