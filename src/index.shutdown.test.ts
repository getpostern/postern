// Unit tests for the graceful-shutdown sequencer (buildShutdown in index.ts). Pure: importing
// index.ts does NOT boot the gateway (the boot is gated behind an entry-point guard), so these run
// DB-free and never exit the test process (exit/log/beginShutdown are injected).

import { describe, it, expect, vi } from "vitest";
import { buildShutdown, type Subsystems } from "./index.js";

/**
 * Build a Subsystems set whose every handle records its name into `calls` (in invocation order), so
 * a test can assert the teardown order. Overrides let a single handle hang/throw.
 */
function recordingHandles(overrides: Partial<Subsystems> = {}): {
  handles: Subsystems;
  calls: string[];
} {
  const calls: string[] = [];
  const handles: Subsystems = {
    stopScheduler: () => void calls.push("stopScheduler"),
    stopPush: () => void calls.push("stopPush"),
    httpEdge: { close: async () => void calls.push("httpEdge.close") },
    rest: { close: async () => void calls.push("rest.close") },
    server: { close: async () => void calls.push("server.close") },
    stopAudit: async () => void calls.push("stopAudit"),
    closePool: async () => void calls.push("closePool"),
    ...overrides,
  };
  return { handles, calls };
}

describe("buildShutdown", () => {
  it("tears subsystems down in the locked order, then exits 0", async () => {
    const { handles, calls } = recordingHandles();
    const exit = vi.fn();
    const begin = vi.fn();
    const shutdown = buildShutdown(handles, { exit, log: () => {}, beginShutdown: begin });

    await shutdown();

    // Drain flag flipped first (so /healthz 503s before teardown).
    expect(begin).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "stopScheduler",
      "stopPush",
      "httpEdge.close",
      "rest.close",
      "server.close",
      "stopAudit", // audit drains AFTER every enqueuer is down
      "closePool", // pool closes last
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second call is a no-op (handles run once, exit fires once)", async () => {
    const { handles, calls } = recordingHandles();
    const exit = vi.fn();
    const shutdown = buildShutdown(handles, { exit, log: () => {}, beginShutdown: () => {} });

    await shutdown();
    await shutdown();
    await shutdown();

    expect(calls.filter((c) => c === "closePool")).toHaveLength(1);
    expect(calls.filter((c) => c === "stopAudit")).toHaveLength(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("always calls closePool (pool is released)", async () => {
    const closePool = vi.fn(async () => {});
    const { handles } = recordingHandles({ closePool });
    const shutdown = buildShutdown(handles, { exit: vi.fn(), log: () => {}, beginShutdown: () => {} });

    await shutdown();

    expect(closePool).toHaveBeenCalledTimes(1);
  });

  it("tolerates absent best-effort handles (null scheduler/push/edges)", async () => {
    const closePool = vi.fn(async () => {});
    const stopAudit = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = buildShutdown(
      {
        stopScheduler: null,
        stopPush: null,
        httpEdge: null,
        rest: null,
        server: { close: async () => {} },
        stopAudit,
        closePool,
      },
      { exit, log: () => {}, beginShutdown: () => {} },
    );

    await shutdown();

    expect(stopAudit).toHaveBeenCalledTimes(1);
    expect(closePool).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("on a teardown error: forces exit(1) (never hangs)", async () => {
    const { handles } = recordingHandles({
      stopAudit: async () => {
        throw new Error("audit drain blew up");
      },
    });
    const exit = vi.fn();
    const shutdown = buildShutdown(handles, { exit, log: () => {}, beginShutdown: () => {} });

    await shutdown();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("hard-timeout forces exit(1) when a handle wedges", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const { handles } = recordingHandles({
        closePool: () => new Promise<void>(() => {}), // never resolves
      });
      const shutdown = buildShutdown(handles, {
        exit,
        log: () => {},
        beginShutdown: () => {},
        timeoutMs: 5_000,
      });

      void shutdown();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
