// Host-header allowlist — the DNS-rebinding guard for the no-bearer admin/OAuth/Plaid routes.
// DB-free. Covers: loopback names pass (with/without port, IPv6 bracket + bare forms); a non-loopback
// host is rejected (fail-closed); a missing/empty Host is rejected; localOnly runs the guard BEFORE
// the wrapped handler (so no side effect — e.g. a key mint — ever fires on a rejected request); the
// REST_ALLOWED_HOSTS env list extends the default set (resolved once at module load); and
// errorToStatus maps ForbiddenHostError -> 403 with a body that leaks no internal detail.

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { assertAllowedHost, localOnly, ForbiddenHostError } from "./host-allowlist.js";
import { errorToStatus, type RouteContext } from "./router.js";

/** Build a RouteContext whose request carries the given Host header (undefined = header absent). */
function ctxWithHost(host: string | undefined): RouteContext {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = host === undefined ? {} : { host };
  return {
    req,
    res: {} as RouteContext["res"],
    params: {},
    query: new URLSearchParams(),
  };
}

describe("assertAllowedHost — loopback names pass", () => {
  for (const host of [
    "127.0.0.1:8787",
    "localhost:8787",
    "[::1]:8787",
    "127.0.0.1", // bare, no port
    "localhost",
    "::1", // bare IPv6 literal, no brackets/port
    "127.0.0.1:0", // port 0 (the bound port in tests)
    "LocalHost:8787", // case-insensitive
  ]) {
    it(`admits Host: ${host}`, () => {
      expect(() => assertAllowedHost(ctxWithHost(host))).not.toThrow();
    });
  }
});

describe("assertAllowedHost — non-loopback rejected (fail-closed)", () => {
  for (const host of ["evil.com", "evil.com:8787", "attacker.example", "0.0.0.0:8787", "169.254.1.1"]) {
    it(`rejects Host: ${host} with ForbiddenHostError`, () => {
      expect(() => assertAllowedHost(ctxWithHost(host))).toThrow(ForbiddenHostError);
    });
  }

  it("rejects a missing Host header (fail-closed)", () => {
    expect(() => assertAllowedHost(ctxWithHost(undefined))).toThrow(ForbiddenHostError);
  });

  it("rejects an empty / whitespace Host header (fail-closed)", () => {
    expect(() => assertAllowedHost(ctxWithHost(""))).toThrow(ForbiddenHostError);
    expect(() => assertAllowedHost(ctxWithHost("   "))).toThrow(ForbiddenHostError);
  });

  // A malformed Host carrying userinfo (`@`) or internal whitespace must fail closed — never have a
  // loopback substring extracted from it. (Not browser-reachable, but a security guard rejects, not
  // salvages, a malformed host.)
  for (const host of [
    "localhost:8787@evil.com", // single-colon branch would slice to "localhost" without the guard
    "[::1]@evil.com", // bracket branch would yield "::1" without the guard
    "localhost@evil.com",
    "127.0.0.1 evil.com", // internal whitespace
  ]) {
    it(`rejects a malformed Host with userinfo/whitespace: ${host}`, () => {
      expect(() => assertAllowedHost(ctxWithHost(host))).toThrow(ForbiddenHostError);
    });
  }
});

describe("localOnly — guard runs BEFORE the wrapped handler", () => {
  it("calls the handler when the Host is loopback", async () => {
    const handler = vi.fn();
    await localOnly(handler)(ctxWithHost("127.0.0.1:8787"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-loopback Host and the wrapped handler is NEVER invoked (no side effect)", () => {
    const handler = vi.fn(); // stands in for postAgent — a key mint must not fire on rejection
    expect(() => localOnly(handler)(ctxWithHost("evil.com"))).toThrow(ForbiddenHostError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a missing Host and the wrapped handler is NEVER invoked", () => {
    const handler = vi.fn();
    expect(() => localOnly(handler)(ctxWithHost(undefined))).toThrow(ForbiddenHostError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates the handler's return value on an allowed Host", async () => {
    const handler = vi.fn(async () => undefined);
    await expect(localOnly(handler)(ctxWithHost("localhost:8787"))).resolves.toBeUndefined();
  });
});

describe("errorToStatus — ForbiddenHostError -> 403, no internal detail", () => {
  it("maps to 403 with the generic 'forbidden host' body", () => {
    const out = errorToStatus(new ForbiddenHostError("forbidden host"));
    expect(out).toEqual({ status: 403, body: { error: "forbidden host" } });
  });

  it("the rejection body leaks no host value, secret, or stack detail", () => {
    const out = errorToStatus(new ForbiddenHostError("Host evil.com rejected; secret sec_abc"));
    // The body is a fixed string — never the thrown message — so no attacker-controlled / secret leak.
    expect(JSON.stringify(out.body)).toBe(`{"error":"forbidden host"}`);
    expect(JSON.stringify(out.body)).not.toMatch(/evil\.com|secret|sec_|stack|token/i);
  });
});

describe("REST_ALLOWED_HOSTS — operator extension (resolved once at module load)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("REST_ALLOWED_HOSTS=studio.local makes Host: studio.local pass; others still rejected", async () => {
    vi.stubEnv("REST_ALLOWED_HOSTS", "studio.local");
    vi.resetModules();
    const fresh = await import("./host-allowlist.js");
    expect(() => fresh.assertAllowedHost(ctxWithHost("studio.local:8787"))).not.toThrow();
    expect(() => fresh.assertAllowedHost(ctxWithHost("studio.local"))).not.toThrow();
    // The defaults still hold, and an un-listed host is still rejected.
    expect(() => fresh.assertAllowedHost(ctxWithHost("127.0.0.1:8787"))).not.toThrow();
    expect(() => fresh.assertAllowedHost(ctxWithHost("evil.com"))).toThrow(fresh.ForbiddenHostError);
  });

  it("a comma-separated, whitespace-padded, mixed-case list is trimmed + lowercased", async () => {
    vi.stubEnv("REST_ALLOWED_HOSTS", " Studio.Local , box.lan ");
    vi.resetModules();
    const fresh = await import("./host-allowlist.js");
    expect(() => fresh.assertAllowedHost(ctxWithHost("studio.local:8787"))).not.toThrow();
    expect(() => fresh.assertAllowedHost(ctxWithHost("box.lan"))).not.toThrow();
  });
});
