// Public-edge hardening over a real Postgres (gated on DATABASE_URL; disposable *_test DB only).
// The ADR 0035 §D3 gate's DB-backed half: DCR eviction instead of owner-lockout (items 2), the
// confused-deputy redirect guard against a client row PLANTED BEFORE the guard shipped (item 4 —
// the reason no migration is needed), the required-expiry rule on cloud-facing keys (item 6, with
// its two regression sentinels), and MCP_PUBLIC_URL canonicalization end-to-end (§7).
//
// oauth_bridge_clients is GLOBAL state, by production design: CLIENT_CAP is a cap on the WHOLE table,
// so no row prefix or per-test namespace can isolate two files that both drive it (#115). This file
// drives it to exactly that cap — the one state a concurrent file cannot tolerate — so it holds the
// `oauth_bridge_clients` TEST-resource lock for its whole duration, the same idiom the plaid_app and
// oauth_provider_apps singletons already use (src/test-support/advisory-lock.ts, #38). Its sibling
// oauth-bridge.db.test.ts holds the same key, so the two never overlap while every other DB file
// still parallelizes.
//
// THE TRAP THAT KEY EXISTS TO AVOID (paid for on 2026-07-25 — do not undo it): the earlier version of
// this file held `CLIENT_CAP_LOCK_KEY` (774_821_309), the key oauth-bridge.ts's registration
// TRANSACTION takes. A test session holding that key and then calling registration DEADLOCKS; it hung
// the file and took two sibling cells with it. `hashtext('oauth_bridge_clients')` is a DIFFERENT key
// (133688592) that production never takes, so the hold can safely span the registration requests too
// — which is why the cap-sensitive setup below no longer has to hand the lock back mid-cell.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createNetServer } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { pool } from "../db.js";
import { startAuditWriter } from "../audit/index.js";
import { startHttpEdge } from "./http.js";
import { lockTestResource } from "../test-support/advisory-lock.js";
import { bridgeConfigFromEnv, parseTrustedProxies, CLIENT_CAP } from "./oauth-bridge.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";
const REDIRECT = "https://client.test/cb"; // never dialed (redirect: "manual" everywhere)
const RUN = randomBytes(4).toString("hex");

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

let base = "";
let edge: { port: number; close(): Promise<void> };
let stopAudit: () => Promise<void>;
/** Released only after this file's LAST cleanup — see the header. */
let releaseClientsLock: (() => Promise<void>) | undefined;

// Each bridge request carries a DISTINCT forwarded identity (the edge trusts 127.0.0.1), so the
// limiter meters this suite as many callers rather than one flooding loopback socket. That is a
// test-harness arrangement — behind a Funnel no such identity exists and the limit is global.
let ipSeq = 0;
function bfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const n = ipSeq++;
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", `10.7.${(n >> 8) & 255}.${n & 255}`);
  return globalThis.fetch(url, { ...init, headers });
}

async function seedGrant(
  over: { expiresAt?: Date | null } = {},
): Promise<{ id: string; agentId: string; key: string }> {
  const agentId = `bridgeh-${randomBytes(6).toString("hex")}`;
  const key = randomBytes(32).toString("base64url");
  const res = await pool.query(
    `insert into agent_grants (user_id, agent_id, key_hash, sectors, expires_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [LOCAL_USER, agentId, sha256Hex(key), ["*"], over.expiresAt === undefined ? null : over.expiresAt],
  );
  return { id: (res.rows[0] as { id: string }).id, agentId, key };
}

async function insertClient(opts: {
  clientId: string;
  ageHours: number;
  redirectUris?: string[];
  name?: string;
}): Promise<void> {
  await pool.query(
    `insert into oauth_bridge_clients (client_id, client_name, redirect_uris, created_at)
     values ($1, $2, $3, now() - ($4 || ' hours')::interval)`,
    [opts.clientId, opts.name ?? "hardening filler", opts.redirectUris ?? [REDIRECT], String(opts.ageHours)],
  );
}

async function insertLiveToken(clientId: string, grantId: string, tag: string): Promise<void> {
  await pool.query(
    `insert into oauth_bridge_tokens
       (agent_grant_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
     values ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '30 days')`,
    [grantId, clientId, sha256Hex(`h_at_${tag}`), sha256Hex(`h_rt_${tag}`)],
  );
}

const clientCount = async (): Promise<number> =>
  ((await pool.query(`select count(*)::int as n from oauth_bridge_clients`)).rows[0] as { n: number }).n;

/** Fill oauth_bridge_clients to exactly CLIENT_CAP with THIS suite's fillers, oldest first. */
async function fillToCap(tag: string, opts: { withTokens?: string } = {}): Promise<string[]> {
  const existing = await clientCount();
  const need = Math.max(0, CLIENT_CAP - existing);
  const ids: string[] = [];
  for (let i = 0; i < need; i++) {
    const id = `pcgcl_h${tag}_${i}_${RUN}`;
    ids.push(id);
    await insertClient({ clientId: id, ageHours: need - i + 1 }); // ids[0] is the OLDEST row
    if (opts.withTokens) await insertLiveToken(id, opts.withTokens, `${tag}_${i}`);
  }
  return ids;
}

const cleanupFillers = async (): Promise<void> => {
  await pool.query(`delete from oauth_bridge_clients where client_name in ('hardening filler', 'hardening probe')`);
};

async function registrationEndpointPost(clientName: string): Promise<Response> {
  return bfetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: clientName }),
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  // FIRST: take the table for this file, before anything reads or writes it. A generous timeout
  // because the wait is for a sibling file's whole run, not for a statement.
  releaseClientsLock = await lockTestResource("oauth_bridge_clients");
  const port = await getFreePort();
  base = `http://127.0.0.1:${port}`;
  process.env.MCP_PUBLIC_URL = base;
  stopAudit = startAuditWriter({ intervalMs: 25 });
  edge = startHttpEdge({
    port,
    audit: () => {},
    bridge: { publicUrl: base, trustedProxies: parseTrustedProxies("127.0.0.1") },
  });
  for (let i = 0; i < 200 && edge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await edge.close();
  await stopAudit();
  await cleanupFillers();
  await pool.query(`delete from oauth_bridge_clients where client_name = 'hardening probe'`);
  await pool.query(`delete from agent_grants where agent_id like 'bridgeh-%'`); // cascades bridge rows
  delete process.env.MCP_PUBLIC_URL;
  // Only now: the table is back to how this file found it, so a waiting sibling sees a clean cap.
  await releaseClientsLock?.();
  await pool.end();
});

// ── ADR 0035 §D3 item 2 — registration must evict, not refuse ────────────────────

describe.skipIf(!HAS_DB)("DCR eviction (a stranger cannot lock the owner out)", () => {
  it("a stranger cannot exhaust the client table and lock the owner out", async () => {
    const ids = await fillToCap("lock");
    expect(ids.length).toBeGreaterThan(0);
    try {
      const r = await registrationEndpointPost("hardening probe");
      expect(r.status).toBe(201); // the owner gets in — the whole point of item 2
      await r.json();
      expect(await clientCount()).toBe(CLIENT_CAP); // …and the cap still holds
      const oldest = await pool.query(`select 1 from oauth_bridge_clients where client_id = $1`, [ids[0]]);
      expect(oldest.rowCount).toBe(0); // oldest by coalesce(last_used_at, created_at)
      const newest = await pool.query(`select 1 from oauth_bridge_clients where client_id = $1`, [
        ids[ids.length - 1],
      ]);
      expect(newest.rowCount).toBe(1); // exactly ONE row went
    } finally {
      await cleanupFillers();
    }
  });

  it("a connected client holding a live token is never evicted by a registration flood", async () => {
    const grant = await seedGrant();
    const connected = `pcgcl_hconn_${RUN}`;
    // The connected client is the OLDEST row in the table — ascending-age order would pick it
    // first if the live-token predicate were dropped.
    await insertClient({ clientId: connected, ageHours: 10_000 });
    await insertLiveToken(connected, grant.id, "conn");
    const ids = await fillToCap("conn");
    expect(ids.length).toBeGreaterThan(0);
    try {
      for (let i = 0; i < 20; i++) {
        const r = await registrationEndpointPost("hardening probe");
        expect(r.status).toBe(201);
        await r.json();
      }
      const survived = await pool.query(`select 1 from oauth_bridge_clients where client_id = $1`, [
        connected,
      ]);
      expect(survived.rowCount).toBe(1);
      const token = await pool.query(
        `select 1 from oauth_bridge_tokens where client_id = $1 and refresh_expires_at > now()`,
        [connected],
      );
      expect(token.rowCount).toBe(1); // its credential is intact too
    } finally {
      await cleanupFillers();
      await pool.query(`delete from oauth_bridge_clients where client_id = $1`, [connected]);
    }
  });

  it("eviction orders by LAST USE, not by creation — the inverted policy would evict the owner", async () => {
    // The discriminator the other eviction cells lack: they vary only `created_at`, so they pass
    // under `order by created_at asc` too. Here the owner's client is the OLDEST row in the table
    // by creation and the NEWEST by use — exactly the real shape (a claude.ai connection registered
    // months ago and used every hour, surrounded by an attacker's fresh, never-used junk). Under
    // `created_at asc` the owner's client is the victim and eviction becomes a more efficient
    // lockout than refusal ever was.
    const owner = `pcgcl_hlru_${RUN}`;
    await pool.query(
      `insert into oauth_bridge_clients (client_id, client_name, redirect_uris, created_at, last_used_at)
       values ($1, 'hardening filler', $2, now() - interval '10000 hours', now())`,
      [owner, [REDIRECT]],
    );
    const ids = await fillToCap("lru"); // fresh, never-used rows; ids[0] is the oldest of them
    expect(ids.length).toBeGreaterThan(0);
    try {
      const r = await registrationEndpointPost("hardening probe");
      expect(r.status).toBe(201);
      await r.json();
      const survived = await pool.query(`select 1 from oauth_bridge_clients where client_id = $1`, [
        owner,
      ]);
      expect(survived.rowCount).toBe(1); // the owner's client is the LAST thing to go, not the first
      const victim = await pool.query(`select 1 from oauth_bridge_clients where client_id = $1`, [ids[0]]);
      expect(victim.rowCount).toBe(0); // the never-used junk went instead
      expect(await clientCount()).toBe(CLIENT_CAP);
    } finally {
      await cleanupFillers();
      await pool.query(`delete from oauth_bridge_clients where client_id = $1`, [owner]);
    }
  });

  it("registration is refused only when every client holds a live credential", async () => {
    // Documents that the ONE remaining refusal path is unreachable without a valid agent key:
    // reaching it needs CLIENT_CAP clients each holding a live token, and a token only exists
    // where someone pasted a valid key.
    const grant = await seedGrant();
    const evictable = await pool.query(
      `select c.client_id from oauth_bridge_clients c
        where not exists (select 1 from oauth_bridge_tokens t
                           where t.client_id = c.client_id and t.refresh_expires_at > now())`,
    );
    const bare = (evictable.rows as { client_id: string }[]).map((r) => r.client_id);
    for (const [i, id] of bare.entries()) await insertLiveToken(id, grant.id, `borrow_${i}`);
    await fillToCap("full", { withTokens: grant.id });
    try {
      const r = await registrationEndpointPost("hardening probe");
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string; error_description?: string };
      expect(body.error).toBe("invalid_client_metadata");
      expect(body.error_description).toContain(String(CLIENT_CAP));
    } finally {
      // Give every borrowed client row its token-less shape back.
      await pool.query(`delete from oauth_bridge_tokens where agent_grant_id = $1`, [grant.id]);
      await cleanupFillers();
    }
  });

  it("two simultaneous registrations at the cap cannot both land", async () => {
    await fillToCap("race");
    try {
      const [a, b] = await Promise.all([
        registrationEndpointPost("hardening probe"),
        registrationEndpointPost("hardening probe"),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      await a.json();
      await b.json();
      // Without the advisory lock (or with count and insert in separate transactions) both would
      // read the same pre-eviction count and land, leaving CLIENT_CAP + 1.
      expect(await clientCount()).toBe(CLIENT_CAP);
    } finally {
      await cleanupFillers();
    }
  });

  it("evicting a client also removes its outstanding authorization codes", async () => {
    const grant = await seedGrant();
    const ids = await fillToCap("code");
    expect(ids.length).toBeGreaterThan(0); // before ids[0] is used: an empty fill asserts nothing
    await pool.query(
      `insert into oauth_bridge_codes
         (code_hash, client_id, agent_grant_id, code_challenge, redirect_uri, expires_at)
       values ($1, $2, $3, 'c', $4, now() + interval '5 minutes')`,
      [sha256Hex(`hardening_code_${RUN}`), ids[0], grant.id, REDIRECT],
    );
    try {
      const r = await registrationEndpointPost("hardening probe");
      expect(r.status).toBe(201);
      await r.json();
      // oauth_bridge_codes.client_id carries no FK, so the sweep must be explicit or these leak.
      const codes = await pool.query(`select 1 from oauth_bridge_codes where client_id = $1`, [ids[0]]);
      expect(codes.rowCount).toBe(0);
    } finally {
      await cleanupFillers();
    }
  });
});

// ── ADR 0035 §D3 item 6 — a cloud key must carry an expiry ───────────────────────

describe.skipIf(!HAS_DB)("a key handed to a cloud client must carry an expiry", () => {
  async function authorizeFlow(key: string): Promise<Response & { clientId: string }> {
    const clientId = `pcgcl_hexp_${randomBytes(4).toString("hex")}_${RUN}`;
    await pool.query(
      `insert into oauth_bridge_clients (client_id, client_name, redirect_uris) values ($1, $2, $3)`,
      [clientId, "hardening probe", [REDIRECT]],
    );
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const page = await bfetch(`${base}/authorize?${q}`, { redirect: "manual" });
    expect(page.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1];
    const res = await bfetch(`${base}/authorize`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ csrf, key, ...Object.fromEntries(q) }),
    });
    // The client_id is unique per invocation and rides every deny row's `args` — it is how the
    // audit assertions below scope to THIS run's rows.
    return Object.assign(res, { clientId });
  }

  it("a key with no expiry cannot be handed to a cloud client", async () => {
    const grant = await seedGrant({ expiresAt: null });
    const before = (
      await pool.query(`select count(*)::int as n from oauth_bridge_codes where agent_grant_id = $1`, [
        grant.id,
      ])
    ).rows[0] as { n: number };
    const post = await authorizeFlow(grant.key);
    expect(post.status).toBe(400);
    expect(post.headers.get("location")).toBeNull();
    const html = await post.text();
    expect(html).toContain("This agent key never expires.");
    expect(html).toContain("mint or rotate a key with a 30/90/365-day expiry in the Console");
    // The load-bearing half: NO code was minted for a key that must not reach a cloud client.
    const after = (
      await pool.query(`select count(*)::int as n from oauth_bridge_codes where agent_grant_id = $1`, [
        grant.id,
      ])
    ).rows[0] as { n: number };
    expect(after.n).toBe(before.n);

    // Scoped to THIS test's own client_id. Scoping only by tool/deny_reason would be satisfied
    // forever by a row any earlier run left behind — a guard that cannot fail after its first pass.
    // The writer flushes async, so poll.
    const denyRows = async (): Promise<number> => {
      const r = await pool.query(
        `select count(*)::int as n from audit_log
          where tool = 'oauth_token' and decision = 'deny'
            and deny_reason = 'authorize: key has no expiry'
            and args->>'clientId' = $1`,
        [post.clientId],
      );
      return (r.rows[0] as { n: number }).n;
    };
    let seen = 0;
    for (let i = 0; i < 40 && seen === 0; i++) {
      seen = await denyRows();
      if (seen === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toBe(1);
  });

  it("a key with an expiry completes the authorization unchanged", async () => {
    // The anti-vacuity partner: without it, "refuse every key" would pass the previous cell.
    const grant = await seedGrant({ expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) });
    const post = await authorizeFlow(grant.key);
    expect(post.status).toBe(302);
    const loc = new URL(post.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st");
    expect(loc.searchParams.get("iss")).toBe(base);
    expect(loc.searchParams.get("code")?.startsWith("pcgac_")).toBe(true);
  });

  it("an already-connected cloud session keeps refreshing after the expiry rule lands", async () => {
    // The regression sentinel for item 6: gating /token would kill every live cloud session on
    // deploy. New authorizations require an expiry; established chains die on their own schedule.
    const grant = await seedGrant({ expiresAt: null });
    const clientId = `pcgcl_hrefresh_${RUN}`;
    await pool.query(
      `insert into oauth_bridge_clients (client_id, client_name, redirect_uris) values ($1, $2, $3)`,
      [clientId, "hardening probe", [REDIRECT]],
    );
    const refresh = "pcgrt_" + randomBytes(32).toString("base64url");
    await pool.query(
      `insert into oauth_bridge_tokens
         (agent_grant_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
       values ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '30 days')`,
      [grant.id, clientId, sha256Hex("pcgat_hrefresh"), sha256Hex(refresh)],
    );

    const r = await bfetch(`${base}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token.startsWith("pcgat_")).toBe(true);
    expect(body.refresh_token.startsWith("pcgrt_")).toBe(true);
  });
});

// ── ADR 0035 §D3 item 4 — approval may not be aimed at the admin surface ─────────

describe.skipIf(!HAS_DB)("the confused-deputy redirect guard", () => {
  it("a client row planted before this change can no longer aim approval at the admin surface", async () => {
    // This is the reason NO migration is needed and this cell must not be deleted: the guard is
    // enforced at MATCH time too, so a dangerous row already in a live DB is neutralized.
    const clientId = `pcgcl_hplant_${RUN}`;
    await pool.query(
      `insert into oauth_bridge_clients (client_id, client_name, redirect_uris) values ($1, $2, $3)`,
      [clientId, "hardening probe", ["http://localhost:1/api/export"]],
    );
    const { challenge } = pkce();
    const r = await bfetch(
      `${base}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:8787/api/export",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull(); // NO 302 at the owner's own admin surface
    expect(r.headers.get("content-type")).toContain("text/html");
    const codes = await pool.query(`select 1 from oauth_bridge_codes where client_id = $1`, [clientId]);
    expect(codes.rowCount).toBe(0);

    // And registration refuses the shape outright, so no new such row can be created.
    const reg = await bfetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:1/api/export"] }),
    });
    expect(reg.status).toBe(400);
    expect(((await reg.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });
});

// ── §7 — MCP_PUBLIC_URL canonicalization, end to end ─────────────────────────────

describe.skipIf(!HAS_DB)("a canonicalized public URL serves and accepts the plain resource", () => {
  it("an explicit default port and a capitalised host still redeem a code end-to-end", async () => {
    const cfg = bridgeConfigFromEnv({ MCP_PUBLIC_URL: "https://Box.ts.net:443" })!;
    expect(cfg.publicUrl).toBe("https://box.ts.net");
    const port = await getFreePort();
    const canonEdge = startHttpEdge({ port, audit: () => {}, bridge: cfg });
    for (let i = 0; i < 200 && canonEdge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const canonBase = `http://127.0.0.1:${port}`;
    try {
      const prm = (await (
        await globalThis.fetch(`${canonBase}/.well-known/oauth-protected-resource/mcp`)
      ).json()) as { resource: string; authorization_servers: string[] };
      expect(prm.resource).toBe("https://box.ts.net/mcp");
      expect(prm.authorization_servers).toEqual(["https://box.ts.net"]);
      const as = (await (
        await globalThis.fetch(`${canonBase}/.well-known/oauth-authorization-server`)
      ).json()) as { issuer: string };
      expect(as.issuer).toBe("https://box.ts.net");

      // A code redemption sending the PLAIN canonical resource succeeds against the :443 config.
      const grant = await seedGrant({ expiresAt: new Date(Date.now() + 86_400_000) });
      const clientId = `pcgcl_hcanon_${RUN}`;
      await pool.query(
        `insert into oauth_bridge_clients (client_id, client_name, redirect_uris) values ($1, $2, $3)`,
        [clientId, "hardening probe", [REDIRECT]],
      );
      const { verifier, challenge } = pkce();
      const code = "pcgac_" + randomBytes(32).toString("base64url");
      await pool.query(
        `insert into oauth_bridge_codes
           (code_hash, client_id, agent_grant_id, code_challenge, redirect_uri, resource, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + interval '5 minutes')`,
        [sha256Hex(code), clientId, grant.id, challenge, REDIRECT, "https://box.ts.net/mcp"],
      );
      const tok = await globalThis.fetch(`${canonBase}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: "https://box.ts.net/mcp",
        }),
      });
      expect(tok.status).toBe(200);
      expect(((await tok.json()) as { token_type: string }).token_type).toBe("Bearer");
    } finally {
      await canonEdge.close();
    }
  });
});
