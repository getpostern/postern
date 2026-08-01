// audit() / queue / flusher / withAudit — the off-hot-path, best-effort behavioral contract.
// DB-free: a spy pool stands in for pg so we can assert WHEN (and whether) pool.query is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { audit, startAuditWriter, withAudit, type AuditEntry } from "./index.js";
import { queue, type QueryablePool } from "./queue.js";
import { AccessDenied } from "../auth/index.js";

/** A spy pool whose query resolves immediately and records its args. */
function spyPool(): QueryablePool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(async () => ({ rowCount: 0 })) };
}

/** Reset the shared singleton's mutable state between tests. */
let stop: (() => Promise<void>) | null = null;
beforeEach(() => {
  // Drain anything left over and clear counters by re-initialising via a fresh start in each test.
  (queue as unknown as { buf: AuditEntry[] }).buf = [];
  (queue as unknown as { dropped: number }).dropped = 0;
  (queue as unknown as { lastDroppedLogged: number }).lastDroppedLogged = 0;
  (queue as unknown as { draining: boolean }).draining = false;
});
afterEach(async () => {
  if (stop) {
    await stop();
    stop = null;
  }
  (queue as unknown as { buf: AuditEntry[] }).buf = [];
});

function base(over: Partial<AuditEntry> = {}): AuditEntry {
  return { userId: "u1", agentId: "claude", tool: "query", decision: "allow", ...over };
}

describe("audit() is off the hot path", () => {
  it("returns undefined synchronously and does NOT call pool.query inline", () => {
    const pool = spyPool();
    // Start with a huge interval + batchSize so neither the timer nor the size trigger fires inline.
    stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1_000_000 });

    const ret = audit(base({ args: { table: "finance.transaction" } }));

    expect(ret).toBeUndefined();
    // The crux: no DB call happened on the calling path.
    expect(pool.query).not.toHaveBeenCalled();
    // The entry is buffered, waiting for a flush.
    expect(queue.size()).toBe(1);
  });

  it("never throws and never blocks with no writer started / a failing DB", () => {
    // No startAuditWriter() at all → no pool wired; audit() must still be safe.
    expect(() => audit(base())).not.toThrow();
    expect(() => audit(base({ args: { secret: "x" } }))).not.toThrow();
    expect(queue.size()).toBe(2);
  });

  it("redacts args before they ever reach the queue (no secret leak)", () => {
    stop = startAuditWriter({ pool: spyPool(), intervalMs: 1_000_000, batchSize: 1_000_000 });
    audit(base({ args: { password: "hunter2", note: "ok" } }));
    const buffered = (queue as unknown as { buf: AuditEntry[] }).buf[0];
    expect((buffered.args as Record<string, unknown>).password).toBe("[redacted]");
    expect((buffered.args as Record<string, unknown>).note).toBe("ok");
  });
});

describe("bounded queue overflow", () => {
  // REWRITTEN (ADR 0035 §D3 item 5). The previous cell asserted `buf.shift()` — i.e. it PINNED the
  // defect this policy exists to remove: a sustained anonymous denial flood evicting genuine audit
  // rows from the queue before they were ever inserted. Overflow now refuses the INCOMING entry.
  it("a flood of new entries cannot evict audit history already queued", () => {
    // Tiny capacity, no flush triggers.
    stop = startAuditWriter({ pool: spyPool(), capacity: 3, intervalMs: 1_000_000, batchSize: 1_000_000 });

    audit(base({ requestId: "r1" }));
    audit(base({ requestId: "r2" }));
    audit(base({ requestId: "r3" }));
    expect(queue.size()).toBe(3);
    expect(queue.dropped).toBe(0);

    // The flood: five more arrive at a full queue. Every one is REFUSED; nothing already queued moves.
    for (const id of ["r4", "r5", "r6", "r7", "r8"]) {
      expect(() => audit(base({ requestId: id }))).not.toThrow();
    }
    expect(queue.size()).toBe(3);
    expect(queue.dropped).toBe(5);

    const ids = (queue as unknown as { buf: AuditEntry[] }).buf.map((e) => e.requestId);
    expect(ids).toEqual(["r1", "r2", "r3"]); // the HISTORY survived, in order
  });

  it("the overflow notice is still emitted and still throttled", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stop = startAuditWriter({ pool: spyPool(), capacity: 3, intervalMs: 1_000_000, batchSize: 1_000_000 });

    audit(base({ requestId: "a" }));
    audit(base({ requestId: "b" }));
    audit(base({ requestId: "c" })); // queue is now full; nothing dropped yet
    expect(errSpy).not.toHaveBeenCalled();

    // Cadence: one line per `capacity` drops (3), never one per dropped entry.
    audit(base({ requestId: "d" }));
    audit(base({ requestId: "e" }));
    expect(errSpy).not.toHaveBeenCalled();
    audit(base({ requestId: "f" })); // the 3rd drop → exactly one notice
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("[audit] queue overflow — dropped 3 entries total");

    audit(base({ requestId: "g" }));
    audit(base({ requestId: "h" }));
    expect(errSpy).toHaveBeenCalledTimes(1); // still throttled
    audit(base({ requestId: "i" })); // the 6th drop → the second notice
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(String(errSpy.mock.calls[1][0])).toContain("dropped 6 entries total");
    expect(queue.dropped).toBe(6);

    errSpy.mockRestore();
  });
});

describe("flusher", () => {
  it("size trigger drains a full batch with ONE pool.query", async () => {
    const pool = spyPool();
    stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 2 });

    audit(base({ requestId: "a" }));
    audit(base({ requestId: "b" })); // hits batchSize → triggers a flush

    // Let the fire-and-forget flush settle.
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(1));
    expect(queue.size()).toBe(0);

    // One insert carried both rows (2 * 10 bound values).
    const [, values] = pool.query.mock.calls[0];
    expect((values as unknown[]).length).toBe(20);
  });

  it("keeps at most ONE insert in flight (draining guard)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releaseRef: { fn: (() => void) | null } = { fn: null };
    const pool: QueryablePool & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((res) => {
          releaseRef.fn = res;
        });
        inFlight--;
        return { rowCount: 0 };
      }),
    };

    stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1 });

    audit(base({ requestId: "x" })); // triggers flush #1 (now blocked in query)
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(1));

    // A second enqueue would trigger flush #2, but the draining guard must prevent a concurrent insert.
    audit(base({ requestId: "y" }));
    // Manually attempt another flush too — still guarded.
    void queue.flush();

    expect(maxInFlight).toBe(1);
    expect(pool.query).toHaveBeenCalledTimes(1);

    // Release the first insert; draining flips false, freeing the next flush.
    releaseRef.fn?.();
    await vi.waitFor(() => expect(inFlight).toBe(0));
    expect(maxInFlight).toBe(1);

    // A subsequent flush (e.g. the next timer tick) drains the leftover "y" — still ≤1 in flight.
    void queue.flush();
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(2));
    expect(maxInFlight).toBe(1);
    // Release it so no promise dangles past the test.
    releaseRef.fn?.();
    await vi.waitFor(() => expect(inFlight).toBe(0));
    expect(queue.size()).toBe(0);
  });

  it("isolates a failed insert: logs to stderr, drops the batch, never crashes", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pool: QueryablePool & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1 });

    audit(base({ requestId: "z" }));
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(1));
    // Batch was dropped (not re-queued); the process did not crash.
    await vi.waitFor(() => expect(queue.size()).toBe(0));
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain("flush failed");
    errSpy.mockRestore();
  });

  it("stop() flushes the remaining buffered entries best-effort", async () => {
    const pool = spyPool();
    stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1_000_000 });

    audit(base({ requestId: "p" }));
    audit(base({ requestId: "q" }));
    expect(queue.size()).toBe(2);

    await stop();
    stop = null;

    expect(pool.query).toHaveBeenCalled();
    expect(queue.size()).toBe(0);
  });
});

describe("withAudit", () => {
  it("on success audits decision:allow / outcome:ok and returns fn's result", async () => {
    stop = startAuditWriter({ pool: spyPool(), intervalMs: 1_000_000, batchSize: 1_000_000 });
    const r = await withAudit({ userId: "u1", agentId: "claude", tool: "invoke_action", sector: "home" }, async () => "done");
    expect(r).toBe("done");
    const e = (queue as unknown as { buf: AuditEntry[] }).buf[0];
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("ok");
  });

  it("on AccessDenied audits decision:deny with the message, then rethrows", async () => {
    stop = startAuditWriter({ pool: spyPool(), intervalMs: 1_000_000, batchSize: 1_000_000 });
    await expect(
      withAudit({ userId: "u1", agentId: "claude", tool: "query", sector: "finance" }, async () => {
        throw new AccessDenied("finance");
      }),
    ).rejects.toBeInstanceOf(AccessDenied);

    const e = (queue as unknown as { buf: AuditEntry[] }).buf[0];
    expect(e.decision).toBe("deny");
    expect(e.denyReason).toBe("access denied: finance");
  });

  it("on a non-AccessDenied throw audits outcome:error (decision:allow), then rethrows", async () => {
    stop = startAuditWriter({ pool: spyPool(), intervalMs: 1_000_000, batchSize: 1_000_000 });
    await expect(
      withAudit({ userId: "u1", agentId: "claude", tool: "invoke_action", sector: "home" }, async () => {
        throw new Error("provider 500");
      }),
    ).rejects.toThrow("provider 500");

    const e = (queue as unknown as { buf: AuditEntry[] }).buf[0];
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("error");
  });
});
