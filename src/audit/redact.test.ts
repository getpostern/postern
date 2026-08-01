// redactArgs — denylisted keys redacted, oversized payloads truncated, ordinary args untouched.
// Pure + DB-free.

import { describe, it, expect } from "vitest";
import { redactArgs } from "./redact.js";

describe("redactArgs", () => {
  it("replaces denylisted keys with '[redacted]' (case-insensitive)", () => {
    const out = redactArgs({
      password: "hunter2",
      apiKey: "abc",
      access_token: "t",
      Authorization: "Bearer x",
      sessionCookie: "c",
      mySecretThing: "s",
      keep: "this",
    }) as Record<string, unknown>;

    expect(out.password).toBe("[redacted]");
    expect(out.apiKey).toBe("[redacted]");
    expect(out.access_token).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.sessionCookie).toBe("[redacted]");
    expect(out.mySecretThing).toBe("[redacted]");
    // A non-denylisted key passes through unchanged.
    expect(out.keep).toBe("this");
  });

  it("redacts nested + arrayed denylisted keys", () => {
    const out = redactArgs({
      filter: { user_token: "x", limit: 5 },
      items: [{ secret: "a" }, { name: "ok" }],
    }) as { filter: Record<string, unknown>; items: Record<string, unknown>[] };

    expect(out.filter.user_token).toBe("[redacted]");
    expect(out.filter.limit).toBe(5);
    expect(out.items[0].secret).toBe("[redacted]");
    expect(out.items[1].name).toBe("ok");
  });

  it("passes ordinary args through unchanged (structurally equal)", () => {
    const args = { table: "finance.transaction", where: { amount: { lt: 0 } }, limit: 50, fields: ["amount", "description"] };
    expect(redactArgs(args)).toEqual(args);
  });

  it("does not mutate the input object", () => {
    const args = { password: "hunter2", nested: { token: "t" } };
    redactArgs(args);
    expect(args.password).toBe("hunter2");
    expect(args.nested.token).toBe("t");
  });

  it("truncates an oversized payload to '[truncated]'", () => {
    const big = { blob: "x".repeat(8000) };
    expect(redactArgs(big)).toBe("[truncated]");
  });

  it("keeps a payload just under the cap", () => {
    const small = { blob: "x".repeat(100) };
    expect(redactArgs(small)).toEqual(small);
  });

  it("leaves scalars and undefined alone", () => {
    expect(redactArgs(undefined)).toBeUndefined();
    expect(redactArgs(null)).toBeNull();
    expect(redactArgs(42)).toBe(42);
    expect(redactArgs("hello")).toBe("hello");
  });

  it("degrades a non-serializable payload to '[truncated]' (never throws)", () => {
    expect(redactArgs({ n: 10n })).toBe("[truncated]"); // BigInt is not JSON-serializable
  });

  it("handles a cyclic object without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redactArgs(a)).not.toThrow();
  });
});
