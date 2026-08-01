// oauth-routes — DB-free unit tests for the PINNED callback URL. The redirect_uri must equal the
// registered literal regardless of the inbound Host header (WHOOP/Google exact-match the redirect),
// so callbackUrl() derives from PCI_PUBLIC_BASE_URL (default http://localhost:8787), NOT ctx host.
//
// The EMPTY STRING is the case that matters most (ADR 0035 §D4): docker-compose declares
// PCI_PUBLIC_BASE_URL as "${PCI_PUBLIC_BASE_URL:-}", so every install whose operator never edited
// .env hands the process an empty string — the DEFAULT case, not an edge case. A `??` fallback
// (null/undefined only) would emit the scheme-less "/api/oauth/<p>/callback" and break every
// fresh install's consent on day one.

import { describe, it, expect, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { callbackUrl, canonicalBaseUrl, oauthAppStatus } from "./oauth-routes.js";
import type { RouteContext } from "./router.js";
import type { OAuthProvider } from "../oauth/providers.js";

// The route reads the BYO-app row through this module; stubbing it keeps the suite DB-free.
// `.js` specifier — the exact one the source uses (ESM + NodeNext).
vi.mock("../oauth/provider-apps.js", () => ({
  getProviderApp: vi.fn(async () => ({ configured: true, clientId: "cid-123" })),
  setProviderApp: vi.fn(async () => undefined),
}));

const saved = process.env.PCI_PUBLIC_BASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.PCI_PUBLIC_BASE_URL;
  else process.env.PCI_PUBLIC_BASE_URL = saved;
  vi.restoreAllMocks();
});

/** A RouteContext carrying a hostile/arbitrary Host header — must be ignored by callbackUrl. */
function ctxWithHost(host: string): RouteContext {
  return {
    req: { headers: { host } } as unknown as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    query: new URLSearchParams(),
  };
}

describe("callbackUrl — pinned to the canonical base", () => {
  it("defaults to http://localhost:8787 and IGNORES the inbound Host header", () => {
    delete process.env.PCI_PUBLIC_BASE_URL;
    expect(callbackUrl(ctxWithHost("evil.com"), "google")).toBe(
      "http://localhost:8787/api/oauth/google/callback",
    );
    expect(callbackUrl(ctxWithHost("127.0.0.1:9999"), "whoop")).toBe(
      "http://localhost:8787/api/oauth/whoop/callback",
    );
  });

  it("the empty string a container is given behaves exactly like nothing configured", () => {
    // THE test of this unit. `"${PCI_PUBLIC_BASE_URL:-}"` in docker-compose delivers "" to every
    // user who has not edited .env — so "" IS the shipped default. Under a `??` fallback the base
    // is "" and this comes back as the scheme-less "/api/oauth/google/callback", which every
    // provider refuses.
    process.env.PCI_PUBLIC_BASE_URL = "";
    expect(canonicalBaseUrl()).toBe("http://localhost:8787");
    expect(callbackUrl(ctxWithHost("evil.com"), "google")).toBe(
      "http://localhost:8787/api/oauth/google/callback",
    );
  });

  it("the shipped default is SILENT — the empty string is a normal state, never a misconfiguration", () => {
    // This cell exists to pin ONE line: `if (raw === "") return DEFAULT_BASE_URL;`. Delete it and
    // every RETURN VALUE in this file is unchanged, because `new URL("")` throws into the same
    // fallback — the correct answer arrives by luck. The one difference observable at the function
    // boundary is the LOG: the throw path warns. That difference is the product decision, not a
    // technicality. `""` is what compose hands every install whose operator never edited `.env`, so
    // the throw path would print `PCI_PUBLIC_BASE_URL is not a URL ("")` on the default install —
    // teaching every operator that this warning is noise, right before the run where it is real.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    delete process.env.PCI_PUBLIC_BASE_URL;
    expect(canonicalBaseUrl()).toBe("http://localhost:8787");
    process.env.PCI_PUBLIC_BASE_URL = "";
    expect(canonicalBaseUrl()).toBe("http://localhost:8787");
    expect(warn).not.toHaveBeenCalled();

    // LANDMARK — without it the assertion above is a spy pointed at nothing. A value that IS
    // misconfigured must still reach this exact spy, so `not.toHaveBeenCalled()` is a real
    // observation of silence and not proof that warnings go somewhere else.
    process.env.PCI_PUBLIC_BASE_URL = "gw.example.com";
    expect(canonicalBaseUrl()).toBe("http://localhost:8787");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("PCI_PUBLIC_BASE_URL");
  });

  it("a setting that is only whitespace behaves like nothing configured, and padding never survives", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.PCI_PUBLIC_BASE_URL = "   ";
    expect(canonicalBaseUrl()).toBe("http://localhost:8787");
    expect(callbackUrl(ctxWithHost("evil.com"), "whoop")).toBe(
      "http://localhost:8787/api/oauth/whoop/callback",
    );

    // The `.trim()` is load-bearing HERE, not above: WHATWG `new URL()` tolerates surrounding
    // whitespace, so a whitespace-only value falls into the unparseable branch either way and
    // whitespace-only alone cannot detect a missing trim. A PADDED VALID value can — untrimmed it
    // comes back with its spaces intact and the provider is handed a redirect_uri that exact-match
    // fails. (A .env line pasted with a trailing space is the everyday way this arrives.)
    process.env.PCI_PUBLIC_BASE_URL = "  https://gw.example.com  ";
    expect(canonicalBaseUrl()).toBe("https://gw.example.com");
    expect(callbackUrl(ctxWithHost("evil.com"), "whoop")).toBe(
      "https://gw.example.com/api/oauth/whoop/callback",
    );
  });

  it("honors PCI_PUBLIC_BASE_URL and trims a trailing slash", () => {
    process.env.PCI_PUBLIC_BASE_URL = "https://gw.example.com/";
    expect(canonicalBaseUrl()).toBe("https://gw.example.com");
    expect(callbackUrl(ctxWithHost("evil.com"), "microsoft")).toBe(
      "https://gw.example.com/api/oauth/microsoft/callback",
    );
  });

  it("a setting that is not an http(s) URL is refused and the loopback literal is served instead", () => {
    // A scheme-less host:port is the most likely operator typo; a file: URL is the class of value
    // that parses but must never become a redirect origin.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const bad of ["localhost:8787", "file:///tmp", "gw.example.com", "ftp://gw.example.com"]) {
      process.env.PCI_PUBLIC_BASE_URL = bad;
      expect(canonicalBaseUrl()).toBe("http://localhost:8787");
      expect(callbackUrl(ctxWithHost("evil.com"), "google")).toBe(
        "http://localhost:8787/api/oauth/google/callback",
      );
    }
  });

  it("a bad setting never takes the gateway down", () => {
    // #97's lesson: a fail-closed gate that throws on a bad knob bricked prod on its first deploy.
    // Warn loudly, serve the default, stay up.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const bad of ["localhost:8787", "file:///tmp", "://", "%%%"]) {
      process.env.PCI_PUBLIC_BASE_URL = bad;
      expect(() => canonicalBaseUrl()).not.toThrow();
      expect(() => callbackUrl(ctxWithHost("evil.com"), "google")).not.toThrow();
    }
  });
});

/** A fake ServerResponse that captures what sendJson writes (writeHead + end, router.ts:165-169). */
function capturingCtx(provider: string): { ctx: RouteContext; body: () => unknown } {
  let payload: string | undefined;
  const res = {
    writeHead: () => undefined,
    end: (p?: unknown) => {
      payload = typeof p === "string" ? p : undefined;
    },
  } as unknown as ServerResponse;
  return {
    ctx: {
      req: { headers: { host: "evil.com" } } as unknown as IncomingMessage,
      res,
      params: { provider },
      query: new URLSearchParams(),
    },
    body: () => JSON.parse(payload ?? "null"),
  };
}

describe("GET /api/oauth/:provider/app — the gateway reports the redirect_uri it will send", () => {
  it("the redirect URI the gateway reports to the Console is the same string it sends the provider", async () => {
    for (const [base, provider] of [
      [undefined, "google"],
      ["https://gw.example.com", "google"],
      ["https://gw.example.com", "whoop"],
    ] as [string | undefined, OAuthProvider][]) {
      if (base === undefined) delete process.env.PCI_PUBLIC_BASE_URL;
      else process.env.PCI_PUBLIC_BASE_URL = base;

      const { ctx, body } = capturingCtx(provider);
      await oauthAppStatus(ctx);
      const parsed = body() as Record<string, unknown>;

      // Landmark: the REAL handler ran and the fake res captured a REAL body — without these three
      // the redirectUri assertion could be satisfied by an empty/synthetic payload.
      expect(parsed.provider).toBe(provider);
      expect(parsed.configured).toBe(true);
      expect(parsed.clientId).toBe("cid-123");
      expect(typeof parsed.confidential).toBe("boolean");

      // ONE source: the reported string is produced by the same call the consent flow makes.
      expect(parsed.redirectUri).toBe(callbackUrl(ctx, provider));
      expect(parsed.redirectUri).toBe(
        `${base ?? "http://localhost:8787"}/api/oauth/${provider}/callback`,
      );
    }
  });

  it("no request header can move the reported redirect URI", async () => {
    delete process.env.PCI_PUBLIC_BASE_URL;
    const { ctx, body } = capturingCtx("google");
    (ctx.req as unknown as { headers: Record<string, string> }).headers = {
      host: "attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
    };
    await oauthAppStatus(ctx);
    expect((body() as Record<string, unknown>).redirectUri).toBe(
      "http://localhost:8787/api/oauth/google/callback",
    );
  });
});
