// exchangeCode / refreshToken — DB-free, network mocked, provider-apps mocked (so providerConfig
// falls back to env). Asserts the per-provider client-type POST shape (ADR 0014): confidential
// providers (google/whoop) send client_secret; the public microsoft client NEVER does; whoop's
// refresh additionally carries scope=offline; and a non-2xx surfaces the provider's non-token-bearing
// error CODE (never the raw, possibly token-bearing, body).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// provider-apps reads the DB; mock it so providerConfig resolves via the env fallback (DB-free).
vi.mock("./provider-apps.js", () => ({ loadProviderApp: vi.fn(async () => null) }));

import { exchangeCode, refreshToken, TokenEndpointError } from "./exchange.js";

const GOOGLE_ID = "test-google-client-id";
const GOOGLE_SECRET = "test-google-secret";
const WHOOP_ID = "test-whoop-client-id";
const WHOOP_SECRET = "test-whoop-secret";
const MS_ID = "test-microsoft-client-id";

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.GOOGLE_OAUTH_CLIENT_ID = GOOGLE_ID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = GOOGLE_SECRET;
  process.env.WHOOP_OAUTH_CLIENT_ID = WHOOP_ID;
  process.env.WHOOP_OAUTH_CLIENT_SECRET = WHOOP_SECRET;
  process.env.MICROSOFT_OAUTH_CLIENT_ID = MS_ID;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function captureBody(): { get: () => URLSearchParams; url: () => string } {
  let body = "";
  let url = "";
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    url = String(input);
    body = String(init?.body ?? "");
    return new Response(
      JSON.stringify({ access_token: "at-123", refresh_token: "rt-456", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { get: () => new URLSearchParams(body), url: () => url };
}

describe("exchangeCode — confidential vs public client", () => {
  it("google (confidential): sends the PKCE verifier AND client_secret", async () => {
    const cap = captureBody();
    await exchangeCode("google", "auth-code", "the-verifier", "http://127.0.0.1/cb");
    const p = cap.get();
    expect(cap.url()).toBe("https://oauth2.googleapis.com/token");
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("auth-code");
    expect(p.get("code_verifier")).toBe("the-verifier");
    expect(p.get("client_id")).toBe(GOOGLE_ID);
    expect(p.get("client_secret")).toBe(GOOGLE_SECRET);
  });

  it("whoop (confidential): sends client_secret", async () => {
    const cap = captureBody();
    await exchangeCode("whoop", "c", "v", "http://127.0.0.1/cb");
    expect(cap.get().get("client_secret")).toBe(WHOOP_SECRET);
  });

  it("microsoft (public): NEVER sends client_secret", async () => {
    const cap = captureBody();
    await exchangeCode("microsoft", "c", "v", "http://127.0.0.1/cb");
    const p = cap.get();
    expect(p.get("client_id")).toBe(MS_ID);
    expect(p.get("code_verifier")).toBe("v");
    expect(p.get("client_secret")).toBeNull();
  });

  it("maps the snake_case token response to a TokenSet", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "at-123",
          refresh_token: "rt-456",
          expires_in: 3600,
          scope: "calendar.readonly contacts.readonly",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const tokens = await exchangeCode("google", "c", "v", "http://127.0.0.1/cb");
    expect(tokens).toEqual({
      accessToken: "at-123",
      refreshToken: "rt-456",
      expiresInSec: 3600,
      scope: "calendar.readonly contacts.readonly",
    });
  });
});

describe("refreshToken — confidential secret + whoop scope=offline", () => {
  it("google (confidential): sends client_secret, NO scope param", async () => {
    const cap = captureBody();
    await refreshToken("google", "rt-456");
    const p = cap.get();
    expect(p.get("grant_type")).toBe("refresh_token");
    expect(p.get("refresh_token")).toBe("rt-456");
    expect(p.get("client_id")).toBe(GOOGLE_ID);
    expect(p.get("client_secret")).toBe(GOOGLE_SECRET);
    expect(p.get("scope")).toBeNull();
  });

  it("whoop (confidential): sends client_secret AND scope=offline", async () => {
    const cap = captureBody();
    await refreshToken("whoop", "rt-456");
    const p = cap.get();
    expect(p.get("client_secret")).toBe(WHOOP_SECRET);
    expect(p.get("scope")).toBe("offline");
  });

  it("microsoft (public): no client_secret, no scope param", async () => {
    const cap = captureBody();
    await refreshToken("microsoft", "rt-456");
    const p = cap.get();
    expect(p.get("client_secret")).toBeNull();
    expect(p.get("scope")).toBeNull();
  });

  it("microsoft refresh body carries NO scope even now that providers.ts requests 4 scopes (#26a regression pin)", async () => {
    // The #26a scope expansion (Mail.Read + Calendars.Read + Contacts.Read + offline_access) must
    // NOT leak into the refresh grant: an existing mail-only credential keeps refreshing untouched
    // (a scope param would ask AAD to re-scope the grant). Body = exactly the 3 refresh params.
    const cap = captureBody();
    await refreshToken("microsoft", "rt-456");
    const p = cap.get();
    expect([...p.keys()].sort()).toEqual(["client_id", "grant_type", "refresh_token"]);
  });
});

describe("postToken — error surfacing (no token leak)", () => {
  it("surfaces the provider error CODE on a non-2xx, never the raw body", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "invalid_client", error_description: "secret_or_leak_marker" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await exchangeCode("google", "c", "v", "http://127.0.0.1/cb");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TokenEndpointError);
    const err = caught as TokenEndpointError;
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_client");
    // The description is non-token-bearing (RFC 6749 §5.2 error responses carry no tokens).
    expect(err.description).toBe("secret_or_leak_marker");
  });

  it("extracts an AADSTS#### code from error_description when `error` is generic", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error_description: "AADSTS7000218: missing client assertion" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;
    await expect(refreshToken("microsoft", "rt")).rejects.toMatchObject({ code: "AADSTS7000218" });
  });

  it("a non-JSON error body yields a null code (status only) and never echoes the body", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("opaque-token-bearing-garbage", { status: 500 }),
    ) as unknown as typeof globalThis.fetch;
    let caught: unknown;
    try {
      await exchangeCode("google", "c", "v", "http://127.0.0.1/cb");
    } catch (e) {
      caught = e;
    }
    const err = caught as TokenEndpointError;
    expect(err.code).toBeNull();
    expect(err.message).toMatch(/500/);
    expect(err.message).not.toContain("opaque-token-bearing-garbage");
  });

  it("a 200 with an in-band error and no access_token still throws", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;
    await expect(exchangeCode("google", "c", "v", "http://127.0.0.1/cb")).rejects.toBeInstanceOf(
      TokenEndpointError,
    );
  });
});
