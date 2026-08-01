// timed() — DB-free. Pins the off-hot-path contract: the read's value is returned UNCHANGED, a
// {label, ...meta, duration_ms} line lands on stderr AFTER the read resolves, meta mutated inside fn
// is captured (the query case stamps `rows` post-read), a THROWN logger never propagates into the
// read, and a rejecting read still rejects (with no log line). console.error → stderr, so stdout
// (the MCP JSON-RPC channel on stdio) is never touched.

import { describe, it, expect, vi, afterEach } from "vitest";
import { timed } from "./duration.js";

describe("timed — off-hot-path duration instrumentation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns fn's resolved value unchanged", async () => {
    const out = await timed("query", { sector: "finance" }, async () => 42);
    expect(out).toBe(42);
  });

  it("logs {label, ...meta, duration_ms} to stderr after the read resolves", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await timed("query", { sector: "finance.transaction", mode: "rows", rows: 3 }, async () => "ok");
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ label: "query", sector: "finance.transaction", mode: "rows", rows: 3 });
    expect(typeof line.duration_ms).toBe("number");
    expect(line.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("captures meta MUTATED by fn before resolution (the row count is known only post-read)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const meta: Record<string, unknown> = { sector: "mail", mode: "rows", rows: 0 };
    await timed("query", meta, async () => {
      meta.rows = 7; // mirrors query() stamping the count once the SELECT lands
      return "ok";
    });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.rows).toBe(7);
  });

  it("a THROWN logger is swallowed — never propagates into the read result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("logger boom");
    });
    await expect(timed("query", { sector: "home" }, async () => "value")).resolves.toBe("value");
  });

  it("a rejecting read still rejects with its OWN error, and no line is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      timed("getRecord", { sector: "home", mode: "record" }, async () => {
        throw new Error("read failed");
      }),
    ).rejects.toThrow("read failed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs only AFTER fn resolves (not before the read does its work)", async () => {
    const order: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      order.push("log");
    });
    await timed("query", { sector: "finance" }, async () => {
      order.push("read");
      return 1;
    });
    expect(order).toEqual(["read", "log"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
