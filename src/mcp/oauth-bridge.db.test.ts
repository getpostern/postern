// OAuth-bridge end-to-end over a real Postgres (gated on DATABASE_URL; disposable *_test DB only).
// A SCRIPTED OAuth client drives the whole flow deriving every URL PURELY from the well-known
// documents (no hardcoded paths — exactly how claude.ai/ChatGPT discover), sending `resource` +
// `state` like real clients: register → authorize page (pasted agent key) → code → /token → use the
// access token against /mcp as that agent. Plus the full refusal matrix, the atomic single-use code
// (concurrent double-redemption), refresh rotation + chain revocation, the lifecycle-propagation
// matrix (revoke/rotate/expiry/caps/cascade), the off=inert cell, abuse bounds, GC, and audit rows.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createNetServer } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pool } from "../db.js";
import { startAuditWriter } from "../audit/index.js";
import { startHttpEdge } from "./http.js";
import { lockTestResource } from "../test-support/advisory-lock.js";
import {
  resolveBridgeToken,
  gcBridgeRows,
  killBridgeRowsForGrant,
  parseTrustedProxies,
  CLIENT_CAP,
  BRIDGE_RATE_CAPACITY,
} from "./oauth-bridge.js";
import type { EdgeAudit } from "./server.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";
const REDIRECT = "https://client.test/cb"; // never dialed (redirect: "manual" everywhere)
// CROSS-FILE MUTEX (#115). `oauth_bridge_clients` is global by production design — CLIENT_CAP counts
// the WHOLE table — so no row prefix can namespace it, and this file plus
// oauth-bridge.hardening.db.test.ts both drive that count. Both hold the `oauth_bridge_clients`
// test-resource lock for their whole run (src/test-support/advisory-lock.ts), the idiom the plaid_app
// and oauth_provider_apps singletons already use, so the two files never overlap while the other ~39
// DB files still parallelize.
//
// The key is `hashtext('oauth_bridge_clients')` and NOT `CLIENT_CAP_LOCK_KEY`
// (`src/mcp/oauth-bridge.ts`, 774_821_309): the registration handler takes `pg_advisory_xact_lock` on
// THAT key from its own connection, so a test session holding it while calling registration
// DEADLOCKS — attempted 2026-07-25, it hung the file and took the hardening file's two eviction cells
// with it. Never reach for the production key here.

// Every bridge request in this suite carries a DISTINCT forwarded client identity, and the edge
// below trusts 127.0.0.1 so that header is honoured. That is a TEST-HARNESS arrangement, not a
// claim about production: without it every request in the file shares one loopback socket and the
// limiter (which covers GET /authorize and POST /token too) meters the whole file as one flooding
// caller. Behind a Tailscale Funnel there is no such header and no client identity at all — see the
// header of src/mcp/oauth-bridge.ts for the accepted limitation.
let ipSeq = 0;
const nextClientIp = (): string => {
  const n = ipSeq++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};
function bfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", nextClientIp());
  return globalThis.fetch(url, { ...init, headers });
}

// Per-run suffix for the DIRECT (row-planted) client ids: audit_log persists across runs on the
// same test DB, so a reused clientId would let waitForAuditRow match a stale prior-run row.
const RUN = randomBytes(4).toString("hex");
const cid = (tag: string): string => `pcgcl_dir_${tag}_${RUN}`;

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

type EdgeAuditEvent = Parameters<EdgeAudit>[0];

let base = "";
let edge: { port: number; close(): Promise<void> };
let stopAudit: () => Promise<void>;
/** Released only after this file's LAST cleanup — see the cross-file mutex note at the top. */
let releaseClientsLock: (() => Promise<void>) | undefined;
const auditEvents: EdgeAuditEvent[] = [];

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

/** Raw MCP initialize (status is the assertion surface — 200 = session, 401 = refused). */
async function rawInitialize(edgeBase: string, token?: string): Promise<Response> {
  return bfetch(`${edgeBase}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: INIT_BODY,
  });
}

interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported: string[];
}

/** The discovery walk real clients do: PRM (path-inserted form) → AS metadata off the issuer. */
async function discover(): Promise<AsMetadata> {
  const prmRes = await bfetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  expect(prmRes.status).toBe(200);
  const prm = (await prmRes.json()) as { resource: string; authorization_servers: string[] };
  expect(prm.resource).toBe(`${base}/mcp`);
  const asBase = prm.authorization_servers[0];
  const metaRes = await bfetch(`${asBase}/.well-known/oauth-authorization-server`);
  expect(metaRes.status).toBe(200);
  return (await metaRes.json()) as AsMetadata;
}

async function registerClient(
  meta: AsMetadata,
  redirectUris: string[],
  clientName = "bridgea test client",
): Promise<string> {
  // NO retry, deliberately. This used to retry the one cross-file refusal the hardening file could
  // provoke ("CLIENT_CAP rows, every one holding a live token") — a mask over the #115 race. The
  // cross-file mutex above makes that state unreachable while this file runs, so any non-201 is now a
  // real defect and fails LOUDLY with the body attached. Re-adding the retry would hide a regression
  // of the mutex, which is precisely how a gate starts lying.
  const res = await bfetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }),
  });
  if (res.status !== 201) {
    throw new Error(`registration expected 201, got ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as { client_id: string }).client_id;
}

async function seedGrant(over: {
  agentId?: string;
  sectors?: string[];
  expiresAt?: Date | null;
} = {}): Promise<{ id: string; agentId: string; key: string }> {
  const agentId = over.agentId ?? `bridgea-${randomBytes(6).toString("hex")}`;
  const key = randomBytes(32).toString("base64url");
  const res = await pool.query(
    `insert into agent_grants (user_id, agent_id, key_hash, sectors, expires_at)
     values ($1, $2, $3, $4, $5) returning id`,
    // expires_at DEFAULTS to a future date, because ADR 0035 §D3 item 6 makes an expiry MANDATORY for
    // any key handed to a cloud client — `POST /authorize` refuses a null one (oauth-bridge.ts:1362).
    // Use `in` rather than `??` so a caller can still pass an EXPLICIT null: the cell that asserts the
    // refusal needs a key with no expiry, and `??` would silently hand it the default and go vacuous.
    [
      LOCAL_USER,
      agentId,
      sha256Hex(key),
      over.sectors ?? ["*"],
      "expiresAt" in over ? over.expiresAt : new Date(Date.now() + 30 * 24 * 3600 * 1000),
    ],
  );
  return { id: (res.rows[0] as { id: string }).id, agentId, key };
}

/** Plant a code row directly (the restart-survivable form) so token-side cells skip the page. */
async function mintCodeRow(opts: {
  clientId: string;
  grantId: string;
  challenge: string;
  redirectUri?: string;
  resource?: string | null;
  expiresAt?: Date;
}): Promise<string> {
  const code = "pcgac_" + randomBytes(32).toString("base64url");
  await pool.query(
    `insert into oauth_bridge_codes
       (code_hash, client_id, agent_grant_id, code_challenge, redirect_uri, resource, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sha256Hex(code),
      opts.clientId,
      opts.grantId,
      opts.challenge,
      opts.redirectUri ?? REDIRECT,
      opts.resource === undefined ? `${base}/mcp` : opts.resource,
      opts.expiresAt ?? new Date(Date.now() + 5 * 60_000),
    ],
  );
  return code;
}

async function tokenPost(form: Record<string, string>): Promise<Response> {
  return bfetch(`${base}/token`, { method: "POST", body: new URLSearchParams(form) });
}

async function redeemCode(p: {
  code: string;
  clientId: string;
  verifier: string;
  redirectUri?: string;
  resource?: string;
}): Promise<Response> {
  return tokenPost({
    grant_type: "authorization_code",
    code: p.code,
    client_id: p.clientId,
    redirect_uri: p.redirectUri ?? REDIRECT,
    code_verifier: p.verifier,
    ...(p.resource !== undefined ? { resource: p.resource } : {}),
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

async function mintPair(grantId: string, clientId: string): Promise<TokenResponse> {
  const { verifier, challenge } = pkce();
  const code = await mintCodeRow({ clientId, grantId, challenge });
  const res = await redeemCode({ code, clientId, verifier });
  expect(res.status).toBe(200);
  return (await res.json()) as TokenResponse;
}

/** Poll audit_log for an oauth_token row matching a predicate (the writer flushes async). */
async function waitForAuditRow(
  where: string,
  params: unknown[],
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await pool.query(
      `select user_id, agent_id, tool, decision, deny_reason, args, outcome
         from audit_log where tool = 'oauth_token' and ${where} order by id desc limit 1`,
      params,
    );
    if (res.rows[0]) return res.rows[0] as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`no oauth_token audit row matched: ${where}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  if (!HAS_DB) return;
  // FIRST: take `oauth_bridge_clients` for this file (see the cross-file mutex note at the top). The
  // generous timeout is because the wait is for a sibling FILE to finish, not for a statement.
  releaseClientsLock = await lockTestResource("oauth_bridge_clients");
  const port = await getFreePort();
  base = `http://127.0.0.1:${port}`;
  process.env.MCP_PUBLIC_URL = base; // the ONE switch (loopback http = the dev carve-out)
  stopAudit = startAuditWriter({ intervalMs: 25 });
  edge = startHttpEdge({
    port,
    audit: (e) => auditEvents.push(e),
    bridge: { publicUrl: base, trustedProxies: parseTrustedProxies("127.0.0.1") },
  });
  for (let i = 0; i < 200 && edge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await edge.close();
  await stopAudit();
  await pool.query(`delete from agent_grants where agent_id like 'bridgea-%'`); // cascades bridge rows
  // Every client_id — planted or DCR-minted — starts with `pcgcl_`, so this is the sweep that keeps a
  // crashed run from leaving rows that push a later run to CLIENT_CAP. Safe to keep this broad ONLY
  // because the mutex is still held: no sibling file has rows in flight here.
  await pool.query(`delete from oauth_bridge_clients where client_id like 'pcgcl_%'`);
  delete process.env.MCP_PUBLIC_URL;
  await releaseClientsLock?.();
  await pool.end();
});

describe.skipIf(!HAS_DB)("discovery-driven flow (the scripted real-client walk)", () => {
  it("register → authorize (pasted key, state+resource) → code → /token → act as that agent", async () => {
    const grant = await seedGrant();
    const meta = await discover(); // every URL below comes from the documents, never hardcoded
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]); // clients refuse without it
    const clientId = await registerClient(meta, [REDIRECT], "Bridge A Test");

    // Authorize page (GET): frame-denial headers + the anti-phishing display.
    const { verifier, challenge } = pkce();
    const state = "st4te-roundtrip-!";
    const authUrl = `${meta.authorization_endpoint}?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${base}/mcp`,
    })}`;
    const page = await bfetch(authUrl, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("Bridge A Test"); // client_name (mandatory display)
    expect(html).toContain("https://client.test"); // redirect destination origin (mandatory display)
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];

    // Approve with the pasted agent key → 302 carrying code + state VERBATIM + iss.
    const post = await bfetch(`${base}/authorize`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        csrf,
        key: grant.key,
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${base}/mcp`,
      }),
    });
    expect(post.status).toBe(302);
    const loc = new URL(post.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe(state);
    expect(loc.searchParams.get("iss")).toBe(base);
    const code = loc.searchParams.get("code")!;
    expect(code.startsWith("pcgac_")).toBe(true);

    // Token exchange: form-encoded in, no-store out, expires_in 3600, pinned prefixes.
    const tok = await bfetch(meta.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: `${base}/mcp`,
      }),
    });
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    expect(tok.headers.get("content-type")).toContain("application/json");
    const tokens = (await tok.json()) as TokenResponse;
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.access_token.startsWith("pcgat_")).toBe(true);
    expect(tokens.refresh_token.startsWith("pcgrt_")).toBe(true);

    // The access token answers initialize + a tool call AS THAT AGENT (same audit identity).
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    });
    const mcp = new Client({ name: "bridgea", version: "0" });
    await mcp.connect(transport);
    const r = await mcp.callTool({ name: "get_schema", arguments: {} });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    await mcp.close();
    const evt = auditEvents.find((e) => e.tool === "get_schema");
    expect(evt).toBeTruthy();
    expect(evt!.agentId).toBe(grant.agentId);
    expect(evt!.userId).toBe(LOCAL_USER);

    // Audit: the issue landed as oauth_token with the agent identity and NO token/key material.
    const row = await waitForAuditRow(`args->>'clientId' = $1 and args->>'grant' = 'authorization_code'`, [
      clientId,
    ]);
    expect(row.agent_id).toBe(grant.agentId);
    expect(row.decision).toBe("allow");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(tokens.access_token);
    expect(serialized).not.toContain(tokens.refresh_token);
    expect(serialized).not.toContain(grant.key);
    expect(serialized).not.toContain(code);
  });
});

describe.skipIf(!HAS_DB)("authorize refusal matrix", () => {
  it("unknown client → ERROR PAGE, never a redirect (the open-redirect guard)", async () => {
    const { challenge } = pkce();
    const r = await bfetch(
      `${base}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "pcgcl_does_not_exist",
        redirect_uri: REDIRECT,
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  it("non-exact redirect_uri → ERROR PAGE; loopback redirects stay port-agnostic", async () => {
    const meta = await discover();
    const clientId = await registerClient(meta, [REDIRECT, "http://127.0.0.1:3030/cb"]);
    const { challenge } = pkce();
    const params = (redirectUri: string) =>
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });

    const bad = await bfetch(`${base}/authorize?${params("https://client.test/other")}`, {
      redirect: "manual",
    });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();

    // Loopback: a DIFFERENT ephemeral port on the registered loopback host is accepted.
    const loopback = await bfetch(`${base}/authorize?${params("http://127.0.0.1:52111/cb")}`, {
      redirect: "manual",
    });
    expect(loopback.status).toBe(200);
  });

  it("PKCE: absent code_challenge AND non-S256 method are refused via redirect, state verbatim", async () => {
    const meta = await discover();
    const clientId = await registerClient(meta, [REDIRECT]);
    const { challenge } = pkce();

    const missing = await bfetch(
      `${base}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        state: "keep-me&exactly",
      })}`,
      { redirect: "manual" },
    );
    expect(missing.status).toBe(302);
    const mloc = new URL(missing.headers.get("location")!);
    expect(mloc.searchParams.get("error")).toBe("invalid_request");
    expect(mloc.searchParams.get("state")).toBe("keep-me&exactly"); // echoed VERBATIM on error too

    // Explicit plain AND the RFC 7636 absent-method-defaults-to-plain case: both refused.
    for (const method of ["plain", null]) {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        state: "s2",
        code_challenge: challenge,
      });
      if (method) q.set("code_challenge_method", method);
      const r = await bfetch(`${base}/authorize?${q}`, { redirect: "manual" });
      expect(r.status).toBe(302);
      const loc = new URL(r.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("state")).toBe("s2");
    }
  });

  it("a foreign resource → invalid_target (redirected, state echoed)", async () => {
    const meta = await discover();
    const clientId = await registerClient(meta, [REDIRECT]);
    const { challenge } = pkce();
    const r = await bfetch(
      `${base}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        state: "s3",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "https://evil.example.com/mcp",
      })}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_target");
    expect(loc.searchParams.get("state")).toBe("s3");
  });

  it("unknown and revoked keys refuse with IDENTICAL page wording (no oracle) and no redirect", async () => {
    const meta = await discover();
    const clientId = await registerClient(meta, [REDIRECT]);
    const revoked = await seedGrant();
    await pool.query(`update agent_grants set revoked_at = now() where id = $1`, [revoked.id]);

    const wordings: string[] = [];
    for (const key of ["definitely-not-a-key", revoked.key]) {
      const { challenge } = pkce();
      const page = await bfetch(
        `${base}/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { redirect: "manual" },
      );
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1];
      const post = await bfetch(`${base}/authorize`, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({
          csrf,
          key,
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      });
      expect(post.status).toBe(400);
      expect(post.headers.get("location")).toBeNull();
      const html = await post.text();
      const wording = /<p style="color:#b00020">([^<]+)<\/p>/.exec(html)?.[1];
      expect(wording).toBeTruthy();
      wordings.push(wording!);
    }
    expect(wordings[0]).toBe(wordings[1]); // unknown vs revoked: byte-identical wording
  });

  it("CSRF is single-use and bound to its exact (client_id, redirect_uri, code_challenge)", async () => {
    const meta = await discover();
    const clientId = await registerClient(meta, [REDIRECT]);
    const grant = await seedGrant();
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const csrfOf = async (): Promise<string> => {
      const page = await bfetch(`${base}/authorize?${q}`, { redirect: "manual" });
      return /name="csrf" value="([^"]+)"/.exec(await page.text())![1];
    };

    // Binding: a token issued for THIS challenge refuses a POST carrying a different one.
    const boundCsrf = await csrfOf();
    const otherChallenge = pkce().challenge;
    const tampered = await bfetch(`${base}/authorize`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        csrf: boundCsrf,
        key: grant.key,
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: otherChallenge,
        code_challenge_method: "S256",
      }),
    });
    expect(tampered.status).toBe(400);
    expect(tampered.headers.get("location")).toBeNull();

    // Single-use: a successful approve consumes the token; replaying the same form fails.
    const csrf = await csrfOf();
    const form = new URLSearchParams({
      csrf,
      key: grant.key,
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const first = await bfetch(`${base}/authorize`, { method: "POST", redirect: "manual", body: form });
    expect(first.status).toBe(302);
    const replay = await bfetch(`${base}/authorize`, { method: "POST", redirect: "manual", body: form });
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("/token — codes: atomic single-use, bound, burned", () => {
  it("wrong verifier → invalid_grant, and the code is BURNED (the right verifier no longer works)", async () => {
    const grant = await seedGrant();
    const { verifier, challenge } = pkce();
    const clientId = cid("burn");
    const code = await mintCodeRow({ clientId, grantId: grant.id, challenge });

    const wrong = await redeemCode({ code, clientId, verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "invalid_grant" });

    const right = await redeemCode({ code, clientId, verifier });
    expect(right.status).toBe(400);
    expect(await right.json()).toEqual({ error: "invalid_grant" });
  });

  it("expired code / client_id mismatch / redirect_uri mismatch → invalid_grant; foreign resource → invalid_target", async () => {
    const grant = await seedGrant();
    const clientId = cid("bind");

    const expired = pkce();
    const expiredCode = await mintCodeRow({
      clientId,
      grantId: grant.id,
      challenge: expired.challenge,
      expiresAt: new Date(Date.now() - 1000),
    });
    const r1 = await redeemCode({ code: expiredCode, clientId, verifier: expired.verifier });
    expect(await r1.json()).toEqual({ error: "invalid_grant" });

    const p2 = pkce();
    const c2 = await mintCodeRow({ clientId, grantId: grant.id, challenge: p2.challenge });
    const r2 = await redeemCode({ code: c2, clientId: "pcgcl_other", verifier: p2.verifier });
    expect(await r2.json()).toEqual({ error: "invalid_grant" });

    const p3 = pkce();
    const c3 = await mintCodeRow({ clientId, grantId: grant.id, challenge: p3.challenge });
    const r3 = await redeemCode({
      code: c3,
      clientId,
      verifier: p3.verifier,
      redirectUri: "https://client.test/OTHER",
    });
    expect(await r3.json()).toEqual({ error: "invalid_grant" });

    const p4 = pkce();
    const c4 = await mintCodeRow({ clientId, grantId: grant.id, challenge: p4.challenge });
    const r4 = await redeemCode({
      code: c4,
      clientId,
      verifier: p4.verifier,
      resource: "https://evil.example.com/mcp",
    });
    expect(await r4.json()).toEqual({ error: "invalid_target" });
  });

  it("concurrent double-redemption of ONE code → exactly one winner", async () => {
    const grant = await seedGrant();
    const clientId = cid("race");
    const { verifier, challenge } = pkce();
    const code = await mintCodeRow({ clientId, grantId: grant.id, challenge });

    const [a, b] = await Promise.all([
      redeemCode({ code, clientId, verifier }),
      redeemCode({ code, clientId, verifier }),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    const loser = a.status === 200 ? b : a;
    expect(await loser.json()).toEqual({ error: "invalid_grant" });
  });

  it("reuse-after-consume revokes the tokens that code issued (access dies at next init)", async () => {
    const grant = await seedGrant();
    const clientId = cid("reuse");
    const { verifier, challenge } = pkce();
    const code = await mintCodeRow({ clientId, grantId: grant.id, challenge });

    const win = await redeemCode({ code, clientId, verifier });
    expect(win.status).toBe(200);
    const tokens = (await win.json()) as TokenResponse;
    expect((await rawInitialize(base, tokens.access_token)).status).toBe(200);

    const reuse = await redeemCode({ code, clientId, verifier });
    expect(await reuse.json()).toEqual({ error: "invalid_grant" });
    expect((await rawInitialize(base, tokens.access_token)).status).toBe(401);
  });

  it("an unknown grant_type → unsupported_grant_type; a grant-expired code → invalid_grant", async () => {
    const bad = await tokenPost({ grant_type: "client_credentials" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "unsupported_grant_type" });

    // The /token grant re-read refuses an EXPIRED grant even when a code exists for it (belt).
    const expiredGrant = await seedGrant({ expiresAt: new Date(Date.now() - 1000) });
    const { verifier, challenge } = pkce();
    const clientId = cid("expgrant");
    const code = await mintCodeRow({ clientId, grantId: expiredGrant.id, challenge });
    const r = await redeemCode({ code, clientId, verifier });
    expect(await r.json()).toEqual({ error: "invalid_grant" });
  });
});

describe.skipIf(!HAS_DB)("refresh rotation + lifecycle propagation (the review-HIGH matrix)", () => {
  it("refresh ROTATES: fresh pair + fresh sliding window; old access lives to ITS OWN expiry; rotated-out reuse revokes the CHAIN", async () => {
    const grant = await seedGrant();
    const clientId = cid("rot");
    const pair1 = await mintPair(grant.id, clientId);

    const rot = await tokenPost({
      grant_type: "refresh_token",
      refresh_token: pair1.refresh_token,
      client_id: clientId,
    });
    expect(rot.status).toBe(200);
    expect(rot.headers.get("cache-control")).toBe("no-store");
    const pair2 = (await rot.json()) as TokenResponse;
    expect(pair2.access_token).not.toBe(pair1.access_token);
    expect(pair2.refresh_token).not.toBe(pair1.refresh_token);

    // Successor got a FRESH ~30d idle window (sliding, not shrinking).
    const succ = await pool.query(
      `select refresh_expires_at from oauth_bridge_tokens where access_hash = $1`,
      [sha256Hex(pair2.access_token)],
    );
    const refreshExp = new Date((succ.rows[0] as { refresh_expires_at: Date }).refresh_expires_at);
    expect(refreshExp.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    // Old ACCESS token stays valid until its own access_expires_at (stated, deliberate)…
    expect((await rawInitialize(base, pair1.access_token)).status).toBe(200);
    // …and the new pair serves.
    expect((await rawInitialize(base, pair2.access_token)).status).toBe(200);

    // Rotated-out refresh presented → invalid_grant AND the WHOLE chain is revoked.
    const reuse = await tokenPost({
      grant_type: "refresh_token",
      refresh_token: pair1.refresh_token,
      client_id: clientId,
    });
    expect(await reuse.json()).toEqual({ error: "invalid_grant" });
    expect((await rawInitialize(base, pair2.access_token)).status).toBe(401);
    const dead = await tokenPost({
      grant_type: "refresh_token",
      refresh_token: pair2.refresh_token,
      client_id: clientId,
    });
    expect(await dead.json()).toEqual({ error: "invalid_grant" });
    expect((await rawInitialize(base, pair1.access_token)).status).toBe(401); // predecessor too
  });

  it("refresh_expires_at never exceeds grant.expires_at (mint AND rotation both capped)", async () => {
    const grant = await seedGrant({ expiresAt: new Date(Date.now() + 24 * 3600 * 1000) });
    const clientId = cid("cap");
    const pair = await mintPair(grant.id, clientId);
    const grantExp = (
      await pool.query(`select expires_at from agent_grants where id = $1`, [grant.id])
    ).rows[0] as { expires_at: Date };

    const minted = await pool.query(
      `select refresh_expires_at from oauth_bridge_tokens where access_hash = $1`,
      [sha256Hex(pair.access_token)],
    );
    expect(
      new Date((minted.rows[0] as { refresh_expires_at: Date }).refresh_expires_at).getTime(),
    ).toBeLessThanOrEqual(new Date(grantExp.expires_at).getTime());

    const rot = await tokenPost({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
    expect(rot.status).toBe(200);
    const pair2 = (await rot.json()) as TokenResponse;
    const succ = await pool.query(
      `select refresh_expires_at from oauth_bridge_tokens where access_hash = $1`,
      [sha256Hex(pair2.access_token)],
    );
    expect(
      new Date((succ.rows[0] as { refresh_expires_at: Date }).refresh_expires_at).getTime(),
    ).toBeLessThanOrEqual(new Date(grantExp.expires_at).getTime());
  });

  it("revoke agent → refresh invalid_grant AND access 401s at next session-init", async () => {
    const grant = await seedGrant();
    const clientId = cid("rev");
    const pair = await mintPair(grant.id, clientId);

    await pool.query(`update agent_grants set revoked_at = now() where id = $1`, [grant.id]);
    const r = await tokenPost({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
    expect(await r.json()).toEqual({ error: "invalid_grant" });
    expect((await rawInitialize(base, pair.access_token)).status).toBe(401);
  });

  it("rotate key (admin upsert path) → bridge rows die IN THE SAME TXN: access 401s immediately, refresh invalid_grant", async () => {
    const grant = await seedGrant();
    const clientId = cid("rotatekill");
    const pair = await mintPair(grant.id, clientId);
    await mintCodeRow({ clientId, grantId: grant.id, challenge: pkce().challenge }); // a live code too

    // Simulate the admin mint-upsert that replaces the key_hash (admin.ts wires this same helper).
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`update agent_grants set key_hash = $2 where id = $1`, [
        grant.id,
        sha256Hex(randomBytes(32).toString("base64url")),
      ]);
      await killBridgeRowsForGrant(client, grant.id);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    const codes = await pool.query(`select 1 from oauth_bridge_codes where agent_grant_id = $1`, [grant.id]);
    const toks = await pool.query(`select 1 from oauth_bridge_tokens where agent_grant_id = $1`, [grant.id]);
    expect(codes.rowCount).toBe(0);
    expect(toks.rowCount).toBe(0);
    expect((await rawInitialize(base, pair.access_token)).status).toBe(401);
    const r = await tokenPost({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
    expect(await r.json()).toEqual({ error: "invalid_grant" });
  });

  it("grant expiry passing → refresh refused and access refused (resolution JOINS the grant)", async () => {
    const grant = await seedGrant({ expiresAt: new Date(Date.now() + 3600_000) });
    const clientId = cid("exp");
    const pair = await mintPair(grant.id, clientId);
    expect((await rawInitialize(base, pair.access_token)).status).toBe(200);

    await pool.query(`update agent_grants set expires_at = now() - interval '1 second' where id = $1`, [
      grant.id,
    ]);
    const r = await tokenPost({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
    expect(await r.json()).toEqual({ error: "invalid_grant" });
    expect((await rawInitialize(base, pair.access_token)).status).toBe(401);
  });

  it("DELETE /api/agents' row delete cascades every bridge row (FK)", async () => {
    const grant = await seedGrant();
    const clientId = cid("cascade");
    await mintPair(grant.id, clientId);
    await mintCodeRow({ clientId, grantId: grant.id, challenge: pkce().challenge });

    await pool.query(`delete from agent_grants where id = $1`, [grant.id]);
    const codes = await pool.query(`select 1 from oauth_bridge_codes where agent_grant_id = $1`, [grant.id]);
    const toks = await pool.query(`select 1 from oauth_bridge_tokens where agent_grant_id = $1`, [grant.id]);
    expect(codes.rowCount).toBe(0);
    expect(toks.rowCount).toBe(0);
  });

  it("refresh audits as oauth_token with the agent identity (and never a token value)", async () => {
    const grant = await seedGrant();
    const clientId = cid("audit");
    const pair = await mintPair(grant.id, clientId);
    const rot = await tokenPost({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
      client_id: clientId,
    });
    expect(rot.status).toBe(200);
    const row = await waitForAuditRow(`args->>'clientId' = $1 and args->>'grant' = 'refresh_token'`, [
      clientId,
    ]);
    expect(row.agent_id).toBe(grant.agentId);
    expect(row.decision).toBe("allow");
    expect(JSON.stringify(row)).not.toContain(pair.refresh_token);
  });
});

describe.skipIf(!HAS_DB)("resolveBridgeToken (the RS join)", () => {
  it("resolves to the grant's identity with sectors expanded and expiresAt = the tightest deadline", async () => {
    const grant = await seedGrant({ sectors: ["finance"] });
    const pair = await mintPair(grant.id, cid("resolve"));
    const ctx = await resolveBridgeToken(pair.access_token);
    expect(ctx).toBeTruthy();
    expect(ctx!.userId).toBe(LOCAL_USER);
    expect(ctx!.agentId).toBe(grant.agentId);
    expect(ctx!.grantedSectors.has("finance")).toBe(true);
    expect(ctx!.grantedSectors.has("home")).toBe(false);
    expect(ctx!.expiresAt).toBeTruthy();
    expect(ctx!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 3600_000 + 1000);
  });

  it("an unknown pcgat_ value → null (falls through to the static resolve → unknown agent)", async () => {
    await expect(resolveBridgeToken("pcgat_" + randomBytes(32).toString("base64url"))).resolves.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("off = inert (the Cursor guard, runtime half)", () => {
  it("bridge ON → mint token → edge WITHOUT the bridge: routes 404 and the token 401s", async () => {
    const grant = await seedGrant();
    const pair = await mintPair(grant.id, cid("off"));
    expect((await rawInitialize(base, pair.access_token)).status).toBe(200); // sanity: ON serves it

    const offEdge = startHttpEdge({ port: 0, audit: () => {}, bridge: null });
    for (let i = 0; i < 200 && offEdge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const offBase = `http://127.0.0.1:${offEdge.port}`;
    delete process.env.MCP_PUBLIC_URL; // the switch is OFF for the resolution gate too
    try {
      const wk = await bfetch(`${offBase}/.well-known/oauth-protected-resource/mcp`);
      expect(wk.status).toBe(404);
      // The previously-minted token is INERT: 401, the bridge tables never consulted.
      expect((await rawInitialize(offBase, pair.access_token)).status).toBe(401);
    } finally {
      process.env.MCP_PUBLIC_URL = base;
      await offEdge.close();
    }
    expect((await rawInitialize(base, pair.access_token)).status).toBe(200); // ON again → serves again
  });
});

describe.skipIf(!HAS_DB)("abuse bounds — the ADR 0035 §D3 edge guarantees", () => {
  // REWRITTEN (ADR 0035 §D3 item 2). The previous cell asserted the 51st registration returns 400 —
  // it PINNED the exact defect this unit removes: an anonymous stranger fills the client table and
  // the owner is permanently locked out of their own connector, holding no credential. Registration
  // now EVICTS the oldest idle, token-less client. The one remaining refusal path (every client
  // holding a LIVE token) needs token rows and lives in oauth-bridge.hardening.db.test.ts.
  it("the 51st registration succeeds by evicting the oldest idle client", async () => {
    const meta = await discover();
    const existing = (
      await pool.query(`select count(*)::int as n from oauth_bridge_clients`)
    ).rows[0] as { n: number };
    const fill = Math.max(0, CLIENT_CAP - existing.n);
    expect(fill).toBeGreaterThan(0); // otherwise the cell asserts nothing about eviction ORDER
    const fillerIds: string[] = [];
    for (let i = 0; i < fill; i++) {
      const id = `pcgcl_fill_${i}_${randomBytes(4).toString("hex")}`;
      fillerIds.push(id);
      await pool.query(
        `insert into oauth_bridge_clients (client_id, client_name, redirect_uris, created_at)
         values ($1, 'cap filler', $2, now() - ($3 || ' hours')::interval)`,
        [id, [REDIRECT], String(fill - i + 1)], // filler 0 is the OLDEST row in the table
      );
    }
    try {
      const r = await bfetch(meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "one too many" }),
      });
      expect(r.status).toBe(201); // the owner gets in
      const after = (
        await pool.query(`select count(*)::int as n from oauth_bridge_clients`)
      ).rows[0] as { n: number };
      expect(after.n).toBe(CLIENT_CAP); // …and the cap still holds
      const evicted = await pool.query(`select 1 from oauth_bridge_clients where client_id = $1`, [
        fillerIds[0],
      ]);
      expect(evicted.rowCount).toBe(0); // the OLDEST idle client is the one that went
      const survivor = await pool.query(`select 1 from oauth_bridge_clients where client_id = $1`, [
        fillerIds[fillerIds.length - 1],
      ]);
      expect(survivor.rowCount).toBe(1); // …and only one went
    } finally {
      await pool.query(`delete from oauth_bridge_clients where client_name in ('cap filler', 'one too many')`);
    }
  });

  // These two cells used to flood from a single loopback socket, so they passed whether or not the
  // limiter could tell callers apart at all. Each now floods ONE resolved identity and proves a
  // SECOND identity is still served — WHERE a trusted proxy supplies one, which these edges
  // configure explicitly. Nothing here claims that holds behind a Funnel; it does not.
  it("a register flood is metered per resolved identity where one exists — a second caller is not collateral", async () => {
    const floodEdge = startHttpEdge({
      port: 0,
      audit: () => {},
      bridge: { publicUrl: "http://127.0.0.1:9", trustedProxies: parseTrustedProxies("127.0.0.1") },
    });
    for (let i = 0; i < 200 && floodEdge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const post = async (ip: string): Promise<number> => {
      const r = await globalThis.fetch(`http://127.0.0.1:${floodEdge.port}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: "{}", // invalid on purpose — refused without a row, but still bucket-metered
      });
      await r.text();
      return r.status;
    };
    try {
      const statuses: number[] = [];
      for (let i = 0; i < BRIDGE_RATE_CAPACITY + 2; i++) statuses.push(await post("203.0.113.10"));
      expect(statuses.filter((s) => s === 400)).toHaveLength(BRIDGE_RATE_CAPACITY);
      expect(statuses.filter((s) => s === 429)).toHaveLength(2);
      expect(statuses[statuses.length - 1]).toBe(429);

      expect(await post("203.0.113.11")).toBe(400); // a DIFFERENT caller is untouched
      expect(await post("203.0.113.10")).toBe(429); // …and the flooder is still refused
    } finally {
      await floodEdge.close();
    }
  });

  it("an authorize flood is metered per resolved identity where one exists — a second caller is not collateral", async () => {
    const floodEdge = startHttpEdge({
      port: 0,
      audit: () => {},
      bridge: { publicUrl: "http://127.0.0.1:9", trustedProxies: parseTrustedProxies("127.0.0.1") },
    });
    for (let i = 0; i < 200 && floodEdge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const post = async (ip: string): Promise<number> => {
      const r = await globalThis.fetch(`http://127.0.0.1:${floodEdge.port}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "x-forwarded-for": ip },
        body: new URLSearchParams({ nonsense: "x" }),
      });
      await r.text();
      return r.status;
    };
    try {
      const statuses: number[] = [];
      for (let i = 0; i < BRIDGE_RATE_CAPACITY + 2; i++) statuses.push(await post("203.0.113.20"));
      expect(statuses.filter((s) => s === 400)).toHaveLength(BRIDGE_RATE_CAPACITY);
      expect(statuses.filter((s) => s === 429)).toHaveLength(2);
      expect(statuses[statuses.length - 1]).toBe(429);

      expect(await post("203.0.113.21")).toBe(400);
      expect(await post("203.0.113.20")).toBe(429);
    } finally {
      await floodEdge.close();
    }
  });
});

describe.skipIf(!HAS_DB)("gcBridgeRows — hygiene, never revocation", () => {
  it("sweeps consumed/expired codes, week-old-dead tokens, and 90d-unused tokenless clients", async () => {
    const grant = await seedGrant();
    const mkCode = async (tag: string, expiresAt: Date, consumed: boolean): Promise<void> => {
      await pool.query(
        `insert into oauth_bridge_codes
           (code_hash, client_id, agent_grant_id, code_challenge, redirect_uri, expires_at, consumed_at)
         values ($1, $2, $3, 'c', $4, $5, $6)`,
        [sha256Hex(`gc_${tag}`), "pcgcl_gc", grant.id, REDIRECT, expiresAt, consumed ? new Date() : null],
      );
    };
    await mkCode("consumed", new Date(Date.now() + 300_000), true);
    await mkCode("expired", new Date(Date.now() - 1000), false);
    await mkCode("live", new Date(Date.now() + 300_000), false);

    const mkToken = async (tag: string, clientId: string, refreshExpiresAgoMs: number): Promise<void> => {
      await pool.query(
        `insert into oauth_bridge_tokens
           (agent_grant_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
         values ($1, $2, $3, $4, now(), $5)`,
        [
          grant.id,
          clientId,
          sha256Hex(`gc_at_${tag}`),
          sha256Hex(`gc_rt_${tag}`),
          new Date(Date.now() - refreshExpiresAgoMs),
        ],
      );
    };
    const DAY = 24 * 3600 * 1000;
    await mkToken("dead8d", "pcgcl_gc", 8 * DAY); // past the 7d forensic window → swept
    await mkToken("dead6d", "pcgcl_gc_tokenheld", 6 * DAY); // inside the window → kept

    const mkClient = async (clientId: string, ageDays: number, lastUsedDays: number | null): Promise<void> => {
      await pool.query(
        `insert into oauth_bridge_clients (client_id, client_name, redirect_uris, created_at, last_used_at)
         values ($1, 'gc', $2, now() - ($3 || ' days')::interval, $4)`,
        [
          clientId,
          [REDIRECT],
          String(ageDays),
          lastUsedDays == null ? null : new Date(Date.now() - lastUsedDays * DAY),
        ],
      );
    };
    // The exact clients THIS test seeds (fixed literals). The post-GC assertion is scoped to this set
    // (#43 D) so a parallel fork's DCR-created pcgcl_* client rows can't leak into a global scan.
    const seededClientIds = ["pcgcl_gc_old_unused", "pcgcl_gc_recent", "pcgcl_gc_tokenheld"];
    await mkClient("pcgcl_gc_old_unused", 100, null); // ≥90d unused, no tokens → swept
    await mkClient("pcgcl_gc_recent", 100, 1); // used yesterday → kept
    await mkClient("pcgcl_gc_tokenheld", 100, 95); // old BUT holds a token row → kept

    await gcBridgeRows();

    const codes = await pool.query(
      `select code_hash from oauth_bridge_codes where agent_grant_id = $1`,
      [grant.id],
    );
    expect((codes.rows as { code_hash: string }[]).map((r) => r.code_hash)).toEqual([
      sha256Hex("gc_live"),
    ]);

    const toks = await pool.query(
      `select access_hash from oauth_bridge_tokens where agent_grant_id = $1`,
      [grant.id],
    );
    expect((toks.rows as { access_hash: string }[]).map((r) => r.access_hash)).toEqual([
      sha256Hex("gc_at_dead6d"),
    ]);

    const clients = await pool.query(
      `select client_id from oauth_bridge_clients where client_id = any($1) order by client_id`,
      [seededClientIds],
    );
    expect((clients.rows as { client_id: string }[]).map((r) => r.client_id)).toEqual([
      "pcgcl_gc_recent",
      "pcgcl_gc_tokenheld",
    ]);
  });
});
