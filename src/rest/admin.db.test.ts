// Admin + OAuth-callback DB round-trips — gated on DATABASE_URL so CI stays green without Postgres.
// Proves the real vault+DB writes the spec's acceptance criteria require:
//   - Gmail static-token onboarding: custody='static_token', username stored, sealed at purpose
//     'access', and the secret is NEVER in the HTTP response.
//   - OAuth callback (exchange mocked): access -> secret_ref (purpose 'access'), refresh ->
//     refresh_ref (purpose 'refresh'), custody='first_party', expires_at set; tokens never returned.
//   - Wave 5 connector auto-create: one connector per sector the granted scopes cover (PRODUCTION
//     scope strings), requested-scope fallback when the response omits `scope`, pause-on-scope-
//     reduction, error/revoked re-activation, and the credential_id-bearing (token-free) redirect.
// Plus a DB-free unit suite for sectorsForScopes (exact strings, normalization, dedup, fallback).

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./router.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";

// SimpleFIN onboarding claims the setup token at connect-time. Mock the connector-owned helper so
// the claim path can be exercised without hitting the bridge — it returns a canned ACCESS URL, and
// the test proves THAT (not the setup token) is what gets sealed as the durable secret.
const SIMPLEFIN_ACCESS_URL = "https://demo-user:demo-pw@beta-bridge.simplefin.org/simplefin";
vi.mock("../connectors/simplefin.js", () => ({
  claimSetupToken: vi.fn(async () => "https://demo-user:demo-pw@beta-bridge.simplefin.org/simplefin"),
}));

// Both suites below share the one src/db.ts pool singleton, so it must be closed EXACTLY ONCE —
// after both finish, not in each describe's afterAll (the first would end the pool the second still
// needs). A file-level afterAll runs last; guard on HAS_DB so a skipped run is a no-op.
afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

/** A capturing fake ServerResponse. */
function fakeRes() {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead(s: number, h?: Record<string, string>) {
      status = s;
      if (h) Object.assign(headers, h);
      this.headersSent = true;
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(payload?: string) {
      if (payload) body += payload;
      this.headersSent = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
}

function ctxFor(opts: { params?: Record<string, string>; query?: string; host?: string } = {}) {
  const r = fakeRes();
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { host: opts.host ?? "127.0.0.1:8787" };
  const ctx: RouteContext = {
    req,
    res: r.res,
    params: opts.params ?? {},
    query: new URLSearchParams(opts.query ?? ""),
  };
  return { ctx, r };
}

describe.skipIf(!HAS_DB)("static-token onboarding (DB)", () => {
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where provider = 'gmail' and user_id = $1`, [LOCAL_USER]);
  });

  it("Gmail app-password: custody='static_token', username stored, sealed STRIPPED at purpose 'access', secret never echoed", async () => {
    const { pool } = await import("../db.js");
    const { postCredential } = await import("./admin.js");
    await pool.query(`delete from provider_credentials where provider = 'gmail' and user_id = $1`, [LOCAL_USER]);

    // Google displays the 16-char app password in four space-separated groups; the operator pastes it
    // verbatim. The gateway strips ALL whitespace before sealing so the durable secret is IMAP-valid.
    const APP_PASSWORD = "abcd efgh ijkl mnop";
    const STRIPPED = "abcdefghijklmnop";
    const EMAIL = "operator@example.com";
    const { ctx, r } = ctxFor();
    await postCredential(ctx, { provider: "gmail", secret: APP_PASSWORD, username: EMAIL });

    expect(r.status).toBe(201);
    const payload = JSON.parse(r.body);
    expect(payload.provider).toBe("gmail");
    expect(payload.status).toBe("active");
    // The secret/app-password is NEVER echoed.
    expect(r.body).not.toContain(APP_PASSWORD);
    expect(payload.secret).toBeUndefined();

    const row = await pool.query(
      `select custody, username, secret_ref, refresh_ref from provider_credentials where id = $1`,
      [payload.credentialId],
    );
    expect(row.rows[0].custody).toBe("static_token");
    expect(row.rows[0].username).toBe(EMAIL);
    expect(row.rows[0].secret_ref).toMatch(/^sec_/);
    expect(row.rows[0].refresh_ref).toBeNull();

    // The sealed secret round-trips ONLY under purpose 'access' (uniform with OAuth access), and is
    // the WHITESPACE-STRIPPED form — never the verbatim spaced paste.
    const { open } = await import("../secrets/index.js");
    const opened = await open(row.rows[0].secret_ref, {
      userId: LOCAL_USER,
      provider: "gmail",
      purpose: "access",
    });
    expect(opened.toString("utf8")).toBe(STRIPPED);
    expect(opened.toString("utf8")).not.toBe(APP_PASSWORD);
  });

  it("Gmail without a username is rejected (ValidationError → 400) and writes no row", async () => {
    const { pool } = await import("../db.js");
    const { postCredential } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    await pool.query(`delete from provider_credentials where provider = 'gmail' and user_id = $1`, [LOCAL_USER]);

    const { ctx } = ctxFor();
    await expect(
      postCredential(ctx, { provider: "gmail", secret: "abcd efgh ijkl mnop" }),
    ).rejects.toBeInstanceOf(ValidationError);

    const rows = await pool.query(
      `select id from provider_credentials where provider = 'gmail' and user_id = $1`,
      [LOCAL_USER],
    );
    expect(rows.rows.length).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("SimpleFIN onboarding claim (DB, claim mocked)", () => {
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where provider = 'simplefin' and user_id = $1`, [LOCAL_USER]);
  });

  it("claims the setup token → seals the ACCESS URL at purpose 'access'; setup token never stored; secret never echoed", async () => {
    const { pool } = await import("../db.js");
    const { postCredential } = await import("./admin.js");
    await pool.query(`delete from provider_credentials where provider = 'simplefin' and user_id = $1`, [LOCAL_USER]);

    // A base64 "setup token" (claim is mocked, so the value just needs to look like a token).
    const SETUP_TOKEN = Buffer.from("https://beta-bridge.simplefin.org/simplefin/claim/DEMO", "utf8").toString("base64");
    const { ctx, r } = ctxFor();
    await postCredential(ctx, { provider: "simplefin", secret: SETUP_TOKEN });

    expect(r.status).toBe(201);
    const payload = JSON.parse(r.body);
    expect(payload.provider).toBe("simplefin");
    expect(payload.status).toBe("active");
    // Neither the setup token NOR the access URL is ever echoed.
    expect(r.body).not.toContain(SETUP_TOKEN);
    expect(r.body).not.toContain(SIMPLEFIN_ACCESS_URL);
    expect(payload.secret).toBeUndefined();

    const row = await pool.query(
      `select custody, secret_ref from provider_credentials where id = $1`,
      [payload.credentialId],
    );
    expect(row.rows[0].custody).toBe("static_token");
    expect(row.rows[0].secret_ref).toMatch(/^sec_/);

    // The DURABLE secret is the ACCESS URL the claim returned — NOT the setup token.
    const { open } = await import("../secrets/index.js");
    const opened = await open(row.rows[0].secret_ref, {
      userId: LOCAL_USER,
      provider: "simplefin",
      purpose: "access",
    });
    expect(opened.toString("utf8")).toBe(SIMPLEFIN_ACCESS_URL);
    expect(opened.toString("utf8")).not.toBe(SETUP_TOKEN);
  });
});

describe.skipIf(!HAS_DB)("OAuth callback seal (DB, exchange mocked)", () => {
  const GOOGLE_ID = "test-google-client-id";

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = GOOGLE_ID;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where provider = 'google' and user_id = $1`, [LOCAL_USER]);
  });

  it("seals access->secret_ref(access) + refresh->refresh_ref(refresh), custody='first_party', expires_at set; tokens never in the response", async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where provider = 'google' and user_id = $1`, [LOCAL_USER]);

    const ACCESS = "live-access-token-xyz";
    const REFRESH = "live-refresh-token-xyz";

    // Mock the provider token endpoint (exchangeCode's fetch).
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.readonly",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const { startPkce } = await import("../oauth/pkce.js");
    const { oauthCallback } = await import("./oauth-routes.js");

    // Start a real PKCE flow to get a valid one-shot state, with the matching redirect_uri.
    const redirectUri = "http://127.0.0.1:8787/api/oauth/google/callback";
    const { state } = startPkce("google", redirectUri);

    const { ctx, r } = ctxFor({
      params: { provider: "google" },
      query: `code=auth-code&state=${encodeURIComponent(state)}`,
      host: "127.0.0.1:8787",
    });
    await oauthCallback(ctx);

    // Redirect to the Console success page — tokens NEVER in the response body or headers.
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBeTruthy();
    expect(r.body).not.toContain(ACCESS);
    expect(r.body).not.toContain(REFRESH);
    expect(JSON.stringify(r.headers)).not.toContain(ACCESS);
    expect(JSON.stringify(r.headers)).not.toContain(REFRESH);

    const row = await pool.query(
      `select custody, secret_ref, refresh_ref, expires_at, granted_scopes
         from provider_credentials where provider = 'google' and user_id = $1`,
      [LOCAL_USER],
    );
    expect(row.rows[0].custody).toBe("first_party");
    expect(row.rows[0].secret_ref).toMatch(/^sec_/);
    expect(row.rows[0].refresh_ref).toMatch(/^sec_/);
    expect(row.rows[0].secret_ref).not.toBe(row.rows[0].refresh_ref);
    expect(row.rows[0].expires_at).not.toBeNull();
    expect(row.rows[0].granted_scopes).toContain("https://www.googleapis.com/auth/calendar.readonly");

    // access -> purpose 'access'; refresh -> purpose 'refresh' (uniform open() for sync-runner).
    const { open } = await import("../secrets/index.js");
    const access = await open(row.rows[0].secret_ref, { userId: LOCAL_USER, provider: "google", purpose: "access" });
    const refresh = await open(row.rows[0].refresh_ref, { userId: LOCAL_USER, provider: "google", purpose: "refresh" });
    expect(access.toString("utf8")).toBe(ACCESS);
    expect(refresh.toString("utf8")).toBe(REFRESH);
  });

  it("a bad/expired state at callback -> ValidationError (400), no DB write", async () => {
    const { oauthCallback } = await import("./oauth-routes.js");
    const { ValidationError } = await import("./router.js");
    const { ctx } = ctxFor({
      params: { provider: "google" },
      query: "code=auth-code&state=never-issued",
    });
    await expect(oauthCallback(ctx)).rejects.toBeInstanceOf(ValidationError);
  });
});

// ── sectorsForScopes — pure unit (no DB), per the wave-5 spec: production string forms only ──────

describe("sectorsForScopes (unit)", () => {
  beforeEach(() => {
    // providerConfig is only consulted on the null-granted fallback; configure all three.
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id";
    process.env.MICROSOFT_OAUTH_CLIENT_ID = "test-microsoft-client-id";
    process.env.WHOOP_OAUTH_CLIENT_ID = "test-whoop-client-id";
  });

  it("google: the PRODUCTION full-URL scopes map exactly; short forms / unknown scopes map to nothing", async () => {
    const { sectorsForScopes } = await import("./oauth-routes.js");
    expect(
      sectorsForScopes("google", [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
      ]),
    ).toEqual(["calendar", "contacts"]);
    // EXACT strings only — a bare short form is NOT a google scope.
    expect(sectorsForScopes("google", ["calendar.readonly", "openid", "email"])).toEqual([]);
  });

  it("microsoft: bare AND Graph-prefixed forms normalize to the same sector, case-insensitive", async () => {
    const { sectorsForScopes } = await import("./oauth-routes.js");
    expect(sectorsForScopes("microsoft", ["Mail.Read"])).toEqual(["mail"]);
    expect(sectorsForScopes("microsoft", ["https://graph.microsoft.com/Mail.Read"])).toEqual(["mail"]);
    expect(
      sectorsForScopes("microsoft", [
        "MAIL.READ",
        "Calendars.Read",
        "https://graph.microsoft.com/Contacts.Read",
      ]),
    ).toEqual(["mail", "calendar", "contacts"]);
  });

  it("whoop: the three read:* scopes dedup to ONE 'health'; offline / read:profile map to nothing", async () => {
    const { sectorsForScopes } = await import("./oauth-routes.js");
    expect(
      sectorsForScopes("whoop", ["read:recovery", "read:sleep", "read:workout", "read:profile", "offline"]),
    ).toEqual(["health"]);
  });

  it("offline_access maps to nothing (microsoft)", async () => {
    const { sectorsForScopes } = await import("./oauth-routes.js");
    expect(sectorsForScopes("microsoft", ["offline_access"])).toEqual([]);
  });

  it("null granted (token response omitted `scope`) → maps off the REQUESTED scopes (RFC 6749 §5.1)", async () => {
    const { sectorsForScopes } = await import("./oauth-routes.js");
    expect(sectorsForScopes("google", null)).toEqual(["calendar", "contacts"]);
    // #26a: microsoft now requests Mail.Read + Calendars.Read + Contacts.Read → three sectors.
    expect(sectorsForScopes("microsoft", null)).toEqual(["mail", "calendar", "contacts"]);
    expect(sectorsForScopes("whoop", null)).toEqual(["health"]);
  });
});

// ── Wave 5: callback connector auto-create (DB, exchange mocked) ─────────────────────────────────

describe.skipIf(!HAS_DB)("OAuth callback → connector auto-create (DB, exchange mocked)", () => {
  const CAL = "https://www.googleapis.com/auth/calendar.readonly";
  const CON = "https://www.googleapis.com/auth/contacts.readonly";
  let savedFetch: typeof globalThis.fetch;
  let savedSuccessUrl: string | undefined;

  beforeEach(async () => {
    savedFetch = globalThis.fetch;
    savedSuccessUrl = process.env.PCI_CONSOLE_SUCCESS_URL;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id";
    process.env.MICROSOFT_OAUTH_CLIENT_ID = "test-microsoft-client-id";
    const { pool } = await import("../db.js");
    await pool.query(
      `delete from provider_credentials where provider in ('google','microsoft') and user_id = $1`,
      [LOCAL_USER],
    );
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedSuccessUrl === undefined) delete process.env.PCI_CONSOLE_SUCCESS_URL;
    else process.env.PCI_CONSOLE_SUCCESS_URL = savedSuccessUrl;
  });
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(
      `delete from provider_credentials where provider in ('google','microsoft') and user_id = $1`,
      [LOCAL_USER],
    );
  });

  /** Run the callback against a mocked token-endpoint JSON; returns the captured response. */
  async function runCallback(provider: "google" | "microsoft", tokenJson: Record<string, unknown>) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(tokenJson), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const { startPkce } = await import("../oauth/pkce.js");
    const { oauthCallback } = await import("./oauth-routes.js");
    const { state } = startPkce(provider, `http://127.0.0.1:8787/api/oauth/${provider}/callback`);
    const { ctx, r } = ctxFor({
      params: { provider },
      query: `code=auth-code&state=${encodeURIComponent(state)}`,
    });
    await oauthCallback(ctx);
    return r;
  }

  async function connectorsFor(credentialId: string) {
    const { pool } = await import("../db.js");
    return (
      await pool.query(
        `select sector, provider, status from connectors where credential_id = $1 order by sector`,
        [credentialId],
      )
    ).rows as { sector: string; provider: string; status: string }[];
  }

  /** Pull credential_id out of the redirect location (and assert it's there). */
  function credIdFrom(location: string): string {
    const id = new URL(location, "http://localhost").searchParams.get("credential_id");
    expect(id).toBeTruthy();
    return id as string;
  }

  it("google consent with BOTH production scopes → calendar + contacts active; redirect carries credential_id + provider, never a token", async () => {
    const r = await runCallback("google", {
      access_token: "cb-access-token",
      refresh_token: "cb-refresh-token",
      expires_in: 3600,
      scope: `${CAL} ${CON}`, // PRODUCTION full-URL forms — the exact strings providers.ts requests
    });

    expect(r.status).toBe(302);
    const loc = r.headers["location"];
    expect(loc).toBeTruthy();
    expect(loc).not.toContain("cb-access-token");
    expect(loc).not.toContain("cb-refresh-token");
    expect(new URL(loc, "http://localhost").searchParams.get("provider")).toBe("google");
    const credentialId = credIdFrom(loc);

    expect(await connectorsFor(credentialId)).toEqual([
      { sector: "calendar", provider: "google", status: "active" },
      { sector: "contacts", provider: "google", status: "active" },
    ]);
  });

  it("token response WITHOUT a `scope` field → ALL requested-scope sectors created (RFC 6749 §5.1 fallback)", async () => {
    const r = await runCallback("google", {
      access_token: "cb-access-token",
      refresh_token: "cb-refresh-token",
      expires_in: 3600,
      // no `scope` → absent means granted == requested
    });
    expect(r.status).toBe(302);
    expect(await connectorsFor(credIdFrom(r.headers["location"]))).toEqual([
      { sector: "calendar", provider: "google", status: "active" },
      { sector: "contacts", provider: "google", status: "active" },
    ]);
  });

  it("scope-reduced re-consent → covered sector stays active, uncovered sibling is PAUSED", async () => {
    const first = await runCallback("google", { access_token: "t1", expires_in: 3600, scope: `${CAL} ${CON}` });
    const credentialId = credIdFrom(first.headers["location"]);

    // re-consent grants ONLY calendar — the gateway must not keep advertising contacts
    const second = await runCallback("google", { access_token: "t2", expires_in: 3600, scope: CAL });
    expect(credIdFrom(second.headers["location"])).toBe(credentialId); // same consent row (upsert)

    expect(await connectorsFor(credentialId)).toEqual([
      { sector: "calendar", provider: "google", status: "active" },
      { sector: "contacts", provider: "google", status: "paused" },
    ]);
  });

  it("re-link flips 'error' AND 'revoked' connectors back to 'active' (a fresh consent supersedes revocation)", async () => {
    const { pool } = await import("../db.js");
    const first = await runCallback("google", { access_token: "t1", expires_in: 3600, scope: `${CAL} ${CON}` });
    const credentialId = credIdFrom(first.headers["location"]);
    await pool.query(`update connectors set status = 'error' where credential_id = $1 and sector = 'calendar'`, [
      credentialId,
    ]);
    await pool.query(`update connectors set status = 'revoked' where credential_id = $1 and sector = 'contacts'`, [
      credentialId,
    ]);

    await runCallback("google", { access_token: "t2", expires_in: 3600, scope: `${CAL} ${CON}` });
    expect(await connectorsFor(credentialId)).toEqual([
      { sector: "calendar", provider: "google", status: "active" },
      { sector: "contacts", provider: "google", status: "active" },
    ]);
  });

  it("microsoft: the Graph-PREFIXED scope form maps → mail connector active", async () => {
    const r = await runCallback("microsoft", {
      access_token: "ms-access",
      refresh_token: "ms-refresh",
      expires_in: 3600,
      scope: "https://graph.microsoft.com/Mail.Read offline_access",
    });
    expect(r.status).toBe(302);
    expect(await connectorsFor(credIdFrom(r.headers["location"]))).toEqual([
      { sector: "mail", provider: "microsoft", status: "active" },
    ]);
  });

  // ── #26a: microsoft one-consent fan-out — mail + calendar + contacts (ADR 0006, 2nd instance) ──

  it("microsoft: BARE granted scopes → mail + calendar + contacts connectors active (#26a)", async () => {
    const r = await runCallback("microsoft", {
      access_token: "ms-access",
      refresh_token: "ms-refresh",
      expires_in: 3600,
      scope: "Mail.Read Calendars.Read Contacts.Read offline_access",
    });
    expect(r.status).toBe(302);
    expect(await connectorsFor(credIdFrom(r.headers["location"]))).toEqual([
      { sector: "calendar", provider: "microsoft", status: "active" },
      { sector: "contacts", provider: "microsoft", status: "active" },
      { sector: "mail", provider: "microsoft", status: "active" },
    ]);
  });

  it("microsoft: Graph-PREFIXED granted scopes → the same 3 connectors (#26a)", async () => {
    const r = await runCallback("microsoft", {
      access_token: "ms-access",
      refresh_token: "ms-refresh",
      expires_in: 3600,
      scope:
        "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Contacts.Read offline_access",
    });
    expect(r.status).toBe(302);
    expect(await connectorsFor(credIdFrom(r.headers["location"]))).toEqual([
      { sector: "calendar", provider: "microsoft", status: "active" },
      { sector: "contacts", provider: "microsoft", status: "active" },
      { sector: "mail", provider: "microsoft", status: "active" },
    ]);
  });

  it("microsoft: token response with NO scope field → 3 connectors (RFC 6749 §5.1 fallback, #26a)", async () => {
    const r = await runCallback("microsoft", {
      access_token: "ms-access",
      refresh_token: "ms-refresh",
      expires_in: 3600,
      // no `scope` → absent means granted == requested (now Mail.Read + Calendars.Read + Contacts.Read)
    });
    expect(r.status).toBe(302);
    expect(await connectorsFor(credIdFrom(r.headers["location"]))).toEqual([
      { sector: "calendar", provider: "microsoft", status: "active" },
      { sector: "contacts", provider: "microsoft", status: "active" },
      { sector: "mail", provider: "microsoft", status: "active" },
    ]);
  });

  it("microsoft: narrower re-consent (Mail.Read only) still PAUSES the calendar + contacts siblings (#26a)", async () => {
    const first = await runCallback("microsoft", {
      access_token: "ms-t1",
      expires_in: 3600,
      scope: "Mail.Read Calendars.Read Contacts.Read offline_access",
    });
    const credentialId = credIdFrom(first.headers["location"]);

    const second = await runCallback("microsoft", {
      access_token: "ms-t2",
      expires_in: 3600,
      scope: "Mail.Read offline_access",
    });
    expect(credIdFrom(second.headers["location"])).toBe(credentialId); // same consent row (upsert)

    expect(await connectorsFor(credentialId)).toEqual([
      { sector: "calendar", provider: "microsoft", status: "paused" },
      { sector: "contacts", provider: "microsoft", status: "paused" },
      { sector: "mail", provider: "microsoft", status: "active" },
    ]);
  });

  it("unknown-scopes-only → ZERO connector rows, redirect still succeeds", async () => {
    const r = await runCallback("google", { access_token: "t1", expires_in: 3600, scope: "openid email" });
    expect(r.status).toBe(302);
    expect(await connectorsFor(credIdFrom(r.headers["location"]))).toEqual([]);
  });

  it("a success URL already carrying a query string joins with '&', never a second '?'", async () => {
    process.env.PCI_CONSOLE_SUCCESS_URL = "/console/connected?tab=integrations";
    const r = await runCallback("google", { access_token: "t1", expires_in: 3600, scope: CAL });
    const loc = r.headers["location"];
    expect(loc.startsWith("/console/connected?tab=integrations&")).toBe(true);
    expect((loc.match(/\?/g) ?? []).length).toBe(1);
    expect(loc).toContain("credential_id=");
    expect(loc).toContain("provider=google");
  });
});

// ── DELETE /api/connectors/:connectionId — disconnect route (#18) ─────────────────────────────────
// The route layer over disconnectConnection: it reads :connectionId + the confirm-token body and lets
// the core verb's typed errors propagate to the edge (NotFoundError → 404, QueryValidationError → 400).
// The deep behaviour (real deletes + shared-credential rule) lives in src/core/lifecycle.db.test.ts;
// here we prove the wiring + the two rejection paths (no seed-user mutation needed — both reject before
// or regardless of ownership, so a random/unknown id suffices).

describe.skipIf(!HAS_DB)("disconnect route (DELETE /api/connectors/:id)", () => {
  const UNKNOWN = "11111111-2222-3333-4444-555555555555";

  it("unknown connectionId → NotFoundError (404), even with a matching confirm token", async () => {
    const { deleteConnectorRoute } = await import("./admin.js");
    const { NotFoundError } = await import("../core/context.js");
    const { ctx } = ctxFor({ params: { connectionId: UNKNOWN } });
    await expect(deleteConnectorRoute(ctx, { confirmToken: UNKNOWN })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("a missing or mismatched confirm token → QueryValidationError (400)", async () => {
    const { deleteConnectorRoute } = await import("./admin.js");
    const { QueryValidationError } = await import("../core/query.js");
    const missing = ctxFor({ params: { connectionId: UNKNOWN } });
    await expect(deleteConnectorRoute(missing.ctx, {})).rejects.toBeInstanceOf(QueryValidationError);
    const wrong = ctxFor({ params: { connectionId: UNKNOWN } });
    await expect(
      deleteConnectorRoute(wrong.ctx, { confirmToken: "not-the-id" }),
    ).rejects.toBeInstanceOf(QueryValidationError);
  });
});

// ── DELETE /api/oauth/:provider/app — clear a configured BYO app (#20) ─────────────────────────────
// Proves the route removes the oauth_provider_apps row AND retires its sealed client_secret_ref from
// the vault (both gone), and that a subsequent status read reports configured:false. Uses 'google'
// (confidential) so a secret is actually sealed and we can assert the secrets row is deleted.

describe.skipIf(!HAS_DB)("oauth-app delete (DELETE /api/oauth/:provider/app)", () => {
  // oauth_provider_apps is one row per provider, shared across parallel vitest forks (#38): hold
  // the advisory lock for THIS describe only (provider-apps.db.test.ts is the other contender) —
  // the rest of the admin suite is contention-free and must stay parallel.
  let releaseLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const { lockTestResource } = await import("../test-support/advisory-lock.js");
    releaseLock = await lockTestResource("oauth_provider_apps");
  }, 120_000);
  beforeEach(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from oauth_provider_apps where provider = 'google'`);
  });
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from oauth_provider_apps where provider = 'google'`);
    await releaseLock?.();
  });

  it("removes the row + its sealed secret, and the status flips to configured:false", async () => {
    const { pool } = await import("../db.js");
    const { setProviderApp, getProviderApp } = await import("../oauth/provider-apps.js");
    const { oauthAppDelete } = await import("./oauth-routes.js");

    // Configure a confidential app so a real secret is sealed in the vault.
    await setProviderApp("google", "google-client-id", "the-confidential-secret");
    const before = await pool.query(
      `select client_secret_ref from oauth_provider_apps where provider = 'google'`,
    );
    const ref = before.rows[0].client_secret_ref as string;
    expect(ref).toMatch(/^sec_/);
    // The sealed secret row exists prior to the delete.
    expect((await pool.query(`select 1 from secrets where ref = $1`, [ref])).rows.length).toBe(1);

    const { ctx, r } = ctxFor({ params: { provider: "google" } });
    await oauthAppDelete(ctx);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });

    // Both the app row AND the sealed secret are gone.
    expect(
      (await pool.query(`select 1 from oauth_provider_apps where provider = 'google'`)).rows.length,
    ).toBe(0);
    expect((await pool.query(`select 1 from secrets where ref = $1`, [ref])).rows.length).toBe(0);
    // Status now reports unconfigured.
    expect(await getProviderApp("google")).toEqual({ configured: false, clientId: null });
  });

  it("is idempotent: deleting an unconfigured provider still returns ok", async () => {
    const { oauthAppDelete } = await import("./oauth-routes.js");
    const { ctx, r } = ctxFor({ params: { provider: "google" } });
    await oauthAppDelete(ctx);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });
});

// ── DELETE /api/agents/:agentId — remove a revoked agent (#24) ─────────────────────────────────────
// Proves the revoke-then-remove gate (a live agent rejects with 400), the hard-delete of the grant
// row, and — the load-bearing invariant — that a prior audit_log row referencing the same agent_id
// SURVIVES the delete (agent_id is plain TEXT, no FK). Unknown ids reject with 400.

describe.skipIf(!HAS_DB)("agent delete (DELETE /api/agents/:agentId)", () => {
  const AGENT = "test-del-agent";

  async function cleanup() {
    const { pool } = await import("../db.js");
    await pool.query(`delete from agent_grants where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]);
    await pool.query(`delete from audit_log where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]);
  }
  beforeEach(cleanup);
  afterAll(cleanup);

  it("unknown agentId → ValidationError (400)", async () => {
    const { deleteAgent } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    const { ctx } = ctxFor({ params: { agentId: "no-such-agent" } });
    await expect(deleteAgent(ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("a NOT-yet-revoked agent rejects (400) — revoke-then-remove; the row survives", async () => {
    const { pool } = await import("../db.js");
    const { deleteAgent } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    await pool.query(
      `insert into agent_grants (user_id, agent_id, key_hash, sectors)
       values ($1, $2, 'hash', '{finance}')`,
      [LOCAL_USER, AGENT],
    );
    const { ctx } = ctxFor({ params: { agentId: AGENT } });
    await expect(deleteAgent(ctx)).rejects.toBeInstanceOf(ValidationError);
    // Still present — the gate did not delete it.
    expect(
      (await pool.query(`select 1 from agent_grants where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]))
        .rows.length,
    ).toBe(1);
  });

  it("a revoked agent is hard-removed; its prior audit_log row SURVIVES", async () => {
    const { pool } = await import("../db.js");
    const { deleteAgent } = await import("./admin.js");
    await pool.query(
      `insert into agent_grants (user_id, agent_id, key_hash, sectors, revoked_at)
       values ($1, $2, 'hash', '{finance}', now())`,
      [LOCAL_USER, AGENT],
    );
    // A prior audit row referencing this agent_id (plain text — no FK to agent_grants).
    await pool.query(
      `insert into audit_log (user_id, agent_id, tool, decision) values ($1, $2, 'query', 'allow')`,
      [LOCAL_USER, AGENT],
    );

    const { ctx, r } = ctxFor({ params: { agentId: AGENT } });
    await deleteAgent(ctx);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });

    // Grant gone…
    expect(
      (await pool.query(`select 1 from agent_grants where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]))
        .rows.length,
    ).toBe(0);
    // …but the audit trail survives.
    expect(
      (await pool.query(`select 1 from audit_log where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]))
        .rows.length,
    ).toBe(1);
  });
});
