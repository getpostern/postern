// PKCE + provider-registry seams — DB-free, no network (provider-apps mocked → env fallback).
// Asserts the authorization URL carries the client_id, redirect_uri, an S256 code_challenge, and
// state; that Google requests the SENSITIVE-ONLY scopes (NO gmail) AND the Google-ONLY
// access_type=offline / prompt=consent params (microsoft/whoop must NOT carry them); that takePending
// is one-shot (CSRF-safe); and that an unconfigured provider throws ConfigError.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

// provider-apps reads the DB; mock it so providerConfig resolves via the env fallback (DB-free).
vi.mock("./provider-apps.js", () => ({ loadProviderApp: vi.fn(async () => null) }));

import { ConfigError, providerConfig } from "./providers.js";
import { startPkce, takePending } from "./pkce.js";

const GOOGLE_ID = "test-google-client-id.apps.googleusercontent.com";
const GOOGLE_SECRET = "test-google-secret";
const LOOPBACK = "http://127.0.0.1:8787/api/oauth/google/callback";

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  setEnv("GOOGLE_OAUTH_CLIENT_ID", GOOGLE_ID);
  setEnv("GOOGLE_OAUTH_CLIENT_SECRET", GOOGLE_SECRET);
  setEnv("MICROSOFT_OAUTH_CLIENT_ID", "test-ms-client-id");
  setEnv("WHOOP_OAUTH_CLIENT_ID", "test-whoop-client-id");
  setEnv("WHOOP_OAUTH_CLIENT_SECRET", "test-whoop-secret");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("providerConfig", () => {
  it("google: sensitive-only scopes (NO gmail), confidential, secret resolved from env fallback", async () => {
    const cfg = await providerConfig("google");
    expect(cfg.confidential).toBe(true);
    expect(cfg.clientId).toBe(GOOGLE_ID);
    expect(cfg.clientSecret).toBe(GOOGLE_SECRET);
    expect(cfg.scopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(cfg.scopes).toContain("https://www.googleapis.com/auth/contacts.readonly");
    expect(cfg.scopes.join(" ")).not.toMatch(/gmail/i);
  });

  it("microsoft: public client — confidential=false, clientSecret null even if an env secret is set", async () => {
    setEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "should-be-ignored");
    const cfg = await providerConfig("microsoft");
    expect(cfg.confidential).toBe(false);
    expect(cfg.clientSecret).toBeNull();
  });

  it("whoop: confidential", async () => {
    const cfg = await providerConfig("whoop");
    expect(cfg.confidential).toBe(true);
    expect(cfg.clientSecret).toBe("test-whoop-secret");
  });

  it("throws ConfigError when neither a table row nor an env client_id is configured", async () => {
    setEnv("GOOGLE_OAUTH_CLIENT_ID", undefined);
    await expect(providerConfig("google")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("startPkce", () => {
  it("google authorization URL carries client_id, redirect_uri, S256 challenge, state, sensitive scopes", () => {
    const { authorizationUrl, state } = startPkce("google", LOOPBACK);
    const u = new URL(authorizationUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(GOOGLE_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(LOOPBACK);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("response_type")).toBe("code");
    const scope = u.searchParams.get("scope") ?? "";
    expect(scope).toContain("calendar.readonly");
    expect(scope).toContain("contacts.readonly");
    expect(scope).not.toMatch(/gmail/i);
  });

  it("Google ONLY carries access_type=offline & prompt=consent", () => {
    const u = new URL(startPkce("google", LOOPBACK).authorizationUrl);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("microsoft does NOT carry access_type / prompt (refresh comes from offline_access scope)", () => {
    const u = new URL(
      startPkce("microsoft", "http://127.0.0.1:8787/api/oauth/microsoft/callback").authorizationUrl,
    );
    expect(u.searchParams.get("access_type")).toBeNull();
    expect(u.searchParams.get("prompt")).toBeNull();
  });

  it("whoop does NOT carry access_type / prompt", () => {
    const u = new URL(
      startPkce("whoop", "http://127.0.0.1:8787/api/oauth/whoop/callback").authorizationUrl,
    );
    expect(u.searchParams.get("access_type")).toBeNull();
    expect(u.searchParams.get("prompt")).toBeNull();
  });

  it("the code_challenge is the S256 transform of the verifier (round-trips via takePending)", () => {
    const { authorizationUrl, state } = startPkce("google", LOOPBACK);
    const challenge = new URL(authorizationUrl).searchParams.get("code_challenge");
    const taken = takePending(state);
    expect(taken).not.toBeNull();
    expect(challenge).toBe(createHash("sha256").update(taken!.verifier).digest("base64url"));
  });

  it("each start uses a distinct state + verifier", () => {
    const a = startPkce("google", LOOPBACK);
    const b = startPkce("google", LOOPBACK);
    expect(a.state).not.toBe(b.state);
    expect(takePending(a.state)!.verifier).not.toBe(takePending(b.state)!.verifier);
  });
});

describe("takePending (one-shot / CSRF-safe)", () => {
  it("returns the pending tuple once, then null (state consumed)", () => {
    const { state } = startPkce("google", LOOPBACK);
    const first = takePending(state);
    expect(first).not.toBeNull();
    expect(first!.provider).toBe("google");
    expect(first!.redirectUri).toBe(LOOPBACK);
    expect(takePending(state)).toBeNull();
  });

  it("an unknown state -> null (the callback then 400s)", () => {
    expect(takePending("never-issued-state")).toBeNull();
  });
});
