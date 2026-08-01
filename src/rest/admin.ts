// Admin handlers — the OPERATOR-LOCAL-TRUSTED onboarding surface (no per-request auth; the server
// binds 127.0.0.1, so reaching these handlers already implies operator trust). Every handler acts
// as LOCAL_USER_ID. Secrets/tokens are sealed into the vault and NEVER echoed back or logged.
//
// Covers: static-token credential onboarding (SimpleFIN / Home Assistant / Gmail-IMAP app-password),
// connector creation + listing, agent-key minting + grant management, and the audit read.

import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { pool } from "../db.js";
import { seal } from "../secrets/index.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { resolveLocal } from "../auth/resolve.js";
import { disconnectConnection } from "../core/lifecycle.js";
import { claimSetupToken } from "../connectors/simplefin.js";
import { sendJson, ValidationError, type RouteContext } from "./router.js";
import { killBridgeRowsForGrant } from "../mcp/oauth-bridge.js";
import { endAgentSessions } from "../mcp/bearer.js";

/** A pre-claimed SimpleFIN access URL: https with embedded basic-auth (user:pass@host). */
function isSimplefinAccessUrl(s: string): boolean {
  if (!/^https:\/\//i.test(s)) return false;
  try {
    return new URL(s).username.length > 0;
  } catch {
    return false;
  }
}

/**
 * Mint a per-agent bearer key: 32 random bytes, base64url-encoded (the key shown ONCE to the
 * operator), plus its sha256 hex (the ONLY form persisted — `agent_grants.key_hash`). The raw key
 * is never stored or logged.
 */
export function mintAgentKey(): { key: string; keyHash: string } {
  const key = randomBytes(32).toString("base64url");
  const keyHash = createHash("sha256").update(key).digest("hex");
  return { key, keyHash };
}

/**
 * POST /api/connectors/:connectionId/webhook — mint/rotate the per-connection webhook secret that
 * gates the push-ingest endpoint. 32 random bytes (base64url), shown to the operator ONCE; only its
 * sha256 hex is persisted (connectors.webhook_secret_hash). Rotation = re-mint (a fresh secret
 * replaces the old hash). The raw secret is never stored, re-fetchable, or logged.
 */
export async function mintWebhookSecret(ctx: RouteContext): Promise<void> {
  const connectionId = ctx.params.connectionId;
  // A malformed (non-uuid) path id maps to the SAME 4xx as an unknown connection (no 500 from a bad
  // uuid cast on the connectors.id comparison).
  if (!z.string().uuid().safeParse(connectionId).success) {
    throw new ValidationError("unknown connectionId");
  }
  // Same generation as the agent bearer: 32 random bytes base64url + its sha256 (only the hash persists).
  const { key: secret, keyHash } = mintAgentKey();

  const res = await pool.query(
    `update connectors set webhook_secret_hash = $2, webhook_secret_set_at = now()
       where id = $1 and user_id = $3
       returning id`,
    [connectionId, keyHash, LOCAL_USER_ID],
  );
  if (!res.rows[0]) throw new ValidationError("unknown connectionId");
  // The secret is returned ONCE; the hash is never returned, the raw secret never logged.
  sendJson(ctx.res, 201, { ingestUrl: `/api/ingest/${connectionId}`, secret });
}

// ── Validation schemas (zod; bodies validated before any DB/vault write) ──

const credentialBody = z.object({
  provider: z.string().min(1),
  secret: z.string().min(1),
  username: z.string().min(1).optional(),
  // Per-instance address (Home Assistant WebSocket URL). Validated but optional; only HA reads it,
  // other providers accept-and-ignore it. Not a secret — persisted plainly on the credential, never
  // echoed in the response.
  instanceUrl: z.string().url().optional(),
  purpose: z.string().min(1).optional(),
});

const connectorBody = z.object({
  credentialId: z.string().uuid(),
  sector: z.string().min(1),
});

/** POST /api/onboard/apple body — the Apple ID + an app-specific password (never a plain password). */
const appleOnboardBody = z.object({
  appleId: z.string().min(1),
  appSpecificPassword: z.string().min(1),
});

/**
 * The sectors ONE Apple credential fans out to — iCloud Mail (IMAP), Calendar (CalDAV), Contacts
 * (CardDAV). Fixed (no scopes to read, unlike the OAuth fan-out): an `apple` credential always
 * produces exactly these three read-only connectors. `as const` so the order is stable + the values
 * are the exact REGISTRY sector strings the connector children register `(provider:'apple', sector)`
 * against.
 */
const APPLE_SECTORS = ["mail", "calendar", "contacts"] as const;

const agentBody = z.object({
  agentId: z.string().min(1),
  sectors: z.array(z.string()).default([]),
  // Key lifetime in whole days (1..3650); absent = never expires (mcp-auth-bridge child B). The
  // mint upsert always writes excluded.expires_at, so a re-mint (rotate) that omits the field
  // deliberately resets the key to never-expiring — the Console resends the current expiry.
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/**
 * PATCH /api/agents/:agentId body — the in-place grant edit (#80). BOTH fields are optional and the
 * absent/null distinction on `expiresInDays` is TRI-STATE and load-bearing:
 *   - `expiresInDays` ABSENT  → the deadline is left exactly as it was (the shipped sectors-only
 *     PATCH keeps its meaning; a Console that never learned about expiry cannot clear one by omission,
 *     which is the opposite of the MINT convention where absent = never-expiring).
 *   - `expiresInDays: N`      → expires_at = now() + N days (extend OR shorten).
 *   - `expiresInDays: null`   → expires_at = null, i.e. never expires.
 * `sectors` ABSENT likewise leaves the grant set alone, so an expiry-only edit cannot clobber a
 * concurrently-changed sector array with a stale copy read for the render.
 * A body carrying NEITHER field is a 400, not a silent 200 no-op (it was a 400 before this unit too).
 */
const grantPatchBody = z.object({
  sectors: z.array(z.string()).optional(),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

/** DELETE /api/connectors/:connectionId body — the confirm token is a fat-finger guard (NOT auth). */
const disconnectBody = z.object({ confirmToken: z.string().min(1).optional() });

/** Parse a validated body or throw ValidationError (→ 400) with a safe message. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError("invalid request body");
  return r.data;
}

/**
 * POST /api/credentials — static-token onboarding (SimpleFIN access URL, Home Assistant token,
 * Gmail IMAP app-password). Seals the secret at purpose 'access' (so sync-runner's open(purpose
 * 'access') is uniform across static + OAuth), inserts a provider_credentials row with
 * custody='static_token' and the username (Gmail email for IMAP). The secret is NEVER echoed.
 */
export async function postCredential(ctx: RouteContext, body: unknown): Promise<void> {
  const { provider, secret, username, instanceUrl, purpose } = parse(credentialBody, body);

  // SimpleFIN: the operator pastes a SETUP TOKEN (or a pre-claimed access URL). Claim it ONCE up
  // front -> an ACCESS URL, and seal THAT (never the setup token) as the durable secret. The claim
  // happens BEFORE the DB insert so a failure writes NO row (atomic) and maps to a 4xx; the setup
  // token is never the durable secret. The access URL embeds basic-auth -> treat it like a password:
  // sealed only, never echoed or logged.
  let toSeal = secret;
  let sealPurpose = purpose ?? "access";
  if (provider === "simplefin") {
    sealPurpose = "access";
    if (!isSimplefinAccessUrl(secret)) {
      try {
        toSeal = await claimSetupToken(secret);
      } catch {
        // No secret/token in the message; ValidationError -> 4xx via errorToStatus.
        throw new ValidationError("simplefin setup-token claim failed");
      }
    }
  }

  // Gmail IMAP: Google shows the 16-char app password in four space-separated groups
  // ("abcd efgh ijkl mnop"); a verbatim paste keeps the spaces and breaks IMAP auth. Strip ALL
  // whitespace before sealing. The username (the full Gmail address) is the IMAP login and is
  // mandatory — reject the request when it's missing rather than persist an unusable credential.
  // (Other providers are untouched: this branch only runs for provider === 'gmail'.)
  if (provider === "gmail") {
    if (!username || username.trim().length === 0) {
      throw new ValidationError("gmail credential requires a username (the full Gmail address)");
    }
    toSeal = secret.replace(/\s+/g, "");
  }

  const secretRef = await seal(
    { userId: LOCAL_USER_ID, provider, purpose: sealPurpose },
    toSeal,
  );

  const res = await pool.query(
    // `where external_item_id is null` infers the (user_id, provider) PARTIAL unique index that
    // migration 0007 substituted for the old table-level unique (Plaid is now per-Item keyed). Every
    // static-token provider leaves external_item_id NULL, so this is the same one-row-per-(user,provider).
    `insert into provider_credentials (user_id, provider, custody, secret_ref, username, instance_url, status)
     values ($1, $2, 'static_token', $3, $4, $5, 'active')
     on conflict (user_id, provider) where external_item_id is null do update set
       secret_ref   = excluded.secret_ref,
       username     = excluded.username,
       instance_url = excluded.instance_url,
       custody      = 'static_token',
       status       = 'active'
     returning id, provider, status`,
    [LOCAL_USER_ID, provider, secretRef, username ?? null, instanceUrl ?? null],
  );
  const row = res.rows[0];
  // Secret never echoed.
  sendJson(ctx.res, 201, { credentialId: row.id, provider: row.provider, status: row.status });
}

/**
 * POST /api/connectors — map an onboarded credential to a sector. One row per credential×sector.
 */
export async function postConnector(ctx: RouteContext, body: unknown): Promise<void> {
  const { credentialId, sector } = parse(connectorBody, body);

  const cred = await pool.query(
    `select provider from provider_credentials where id = $1 and user_id = $2`,
    [credentialId, LOCAL_USER_ID],
  );
  if (!cred.rows[0]) throw new ValidationError("unknown credentialId");
  const provider = cred.rows[0].provider as string;

  const res = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status)
     values ($1, $2, $3, $4, 'active')
     on conflict (credential_id, sector) do update set status = 'active'
     returning id, provider, sector, status`,
    [LOCAL_USER_ID, credentialId, sector, provider],
  );
  const row = res.rows[0];
  sendJson(ctx.res, 201, {
    connectionId: row.id,
    sector: row.sector,
    provider: row.provider,
    status: row.status,
  });
}

/**
 * POST /api/onboard/apple — the iCloud one-step fan-out (#26). Collects {appleId,
 * appSpecificPassword} and, in ONE transaction, seals the ASP into the vault and creates one
 * `apple` static-token credential + THREE read-only connectors (mail / calendar / contacts) — the
 * paste-credential analog of the Microsoft OAuth fan-out (there scopes decide the sectors; here the
 * set is fixed because iCloud has no per-sector scopes). The connector children resolve the actual
 * connector by (provider 'apple', sector) from the registry; this route only creates the rows.
 *
 * The ASP is sealed at purpose 'access' (uniform with every other static-token credential, so
 * sync-runner's open(purpose 'access') is provider-agnostic) and stored ONLY as a `sec_` ref — it is
 * NEVER echoed in the response and NEVER logged (S1). Whitespace is trimmed (Apple presents the ASP
 * grouped for display) but interior characters are preserved verbatim. Re-running with a fresh ASP
 * re-seals the same one-row-per-(user,'apple') credential (upsert) and re-activates the three
 * connectors — the token re-paste precedent.
 */
export async function postAppleOnboard(ctx: RouteContext, body: unknown): Promise<void> {
  const { appleId, appSpecificPassword } = parse(appleOnboardBody, body);
  const asp = appSpecificPassword.trim();
  if (asp.length === 0) throw new ValidationError("appSpecificPassword must not be blank");

  // Seal FIRST (like postCredential) so a failed seal writes no rows; a later rollback orphans only
  // an inert vault blob (never re-referenceable), never a credential/connector row.
  const secretRef = await seal(
    { userId: LOCAL_USER_ID, provider: "apple", purpose: "access" },
    asp,
  );

  // Credential + the three connectors are created ATOMICALLY — a partial fan-out (a credential with
  // only some sectors) would advertise a source the gateway can't fully serve.
  const client = await pool.connect();
  try {
    await client.query("begin");
    const credRes = await client.query(
      // `where external_item_id is null` infers the (user_id, provider) PARTIAL unique index
      // (migration 0007). Apple leaves external_item_id NULL → one-row-per-(user,'apple'), same as
      // the other static-token providers.
      `insert into provider_credentials (user_id, provider, custody, secret_ref, username, status)
       values ($1, 'apple', 'static_token', $2, $3, 'active')
       on conflict (user_id, provider) where external_item_id is null do update set
         secret_ref = excluded.secret_ref,
         username   = excluded.username,
         custody    = 'static_token',
         status     = 'active'
       returning id`,
      [LOCAL_USER_ID, secretRef, appleId],
    );
    const credentialId = credRes.rows[0].id as string;

    const connectors: { connectionId: string; sector: string; status: string }[] = [];
    for (const sector of APPLE_SECTORS) {
      const cr = await client.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, $3, 'apple', 'active')
         on conflict (credential_id, sector) do update set status = 'active'
         returning id, sector, status`,
        [LOCAL_USER_ID, credentialId, sector],
      );
      const row = cr.rows[0];
      connectors.push({ connectionId: row.id, sector: row.sector, status: row.status });
    }
    await client.query("commit");
    // Secret never echoed — ids + sectors only.
    sendJson(ctx.res, 201, { credentialId, provider: "apple", connectors });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** GET /api/connectors — the operator's connectors, with freshness. */
export async function listConnectors(ctx: RouteContext): Promise<void> {
  const res = await pool.query(
    `select id, provider, sector, status, last_synced_at
       from connectors where user_id = $1 order by created_at desc`,
    [LOCAL_USER_ID],
  );
  sendJson(
    ctx.res,
    200,
    res.rows.map((r) => ({
      connectionId: r.id,
      provider: r.provider,
      sector: r.sector,
      status: r.status,
      last_synced_at: r.last_synced_at,
    })),
  );
}

/**
 * DELETE /api/connectors/:connectionId — connectionId-scoped HARD disconnect (#18). Stops the live
 * connector, deletes its cached domain rows + the connectors row, and removes the shared credential
 * (+ its vault secret) ONLY when this was its last connector. The confirm token (must echo the
 * connectionId) is a fat-finger guard, NOT auth — the loopback Host-allowlist is the only authz. A
 * mismatch → QueryValidationError (400); a foreign/unknown id → NotFoundError (404); both raised by
 * disconnectConnection and mapped by the edge's errorToStatus. The audit line is fired inside the core
 * verb (tool 'disconnect'), off the response path.
 */
export async function deleteConnectorRoute(ctx: RouteContext, body: unknown): Promise<void> {
  const parsed = disconnectBody.safeParse(body);
  if (!parsed.success) throw new ValidationError("invalid request body");
  const operator = await resolveLocal();
  const result = await disconnectConnection(operator, ctx.params.connectionId, {
    confirmToken: parsed.data.confirmToken,
  });
  sendJson(ctx.res, 200, result);
}

/**
 * POST /api/agents — mint a bearer key + upsert the grant. The key is returned ONCE; only its
 * sha256 (key_hash) is persisted. Sectors set the default-deny grant. `expiresInDays` (optional,
 * 1..3650) computes agent_grants.expires_at server-side; absent = never-expiring (null). The
 * on-conflict update writes excluded.expires_at, so rotate replaces the expiry it resends.
 */
export async function postAgent(ctx: RouteContext, body: unknown): Promise<void> {
  const parsed = agentBody.safeParse(body);
  if (!parsed.success) {
    // Typed 400 NAMES the expiry field (the #1/#2 convention) — the generic message elsewhere.
    if (parsed.error.issues.some((i) => i.path[0] === "expiresInDays")) {
      throw new ValidationError("invalid 'expiresInDays': must be an integer between 1 and 3650");
    }
    throw new ValidationError("invalid request body");
  }
  const { agentId, sectors, expiresInDays } = parsed.data;
  const { key, keyHash } = mintAgentKey();

  // Mint = a NEW credential, atomically: the upsert replaces key_hash, and any OAuth-bridge
  // codes/tokens derived from the row's previous key die in the SAME transaction — rotation is the
  // compromise response, so derived credentials must not outlive the key (ADR 0029 §5). A fresh
  // row deletes nothing (no-op).
  const client = await pool.connect();
  let expiresAt: unknown;
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into agent_grants (user_id, agent_id, key_hash, sectors, expires_at)
       values ($1, $2, $3, $4,
               case when $5::int is null then null else now() + make_interval(days => $5::int) end)
       on conflict (user_id, agent_id) do update set
         key_hash   = excluded.key_hash,
         sectors    = excluded.sectors,
         expires_at = excluded.expires_at,
         revoked_at = null
       returning id, expires_at`,
      [LOCAL_USER_ID, agentId, keyHash, sectors, expiresInDays ?? null],
    );
    await killBridgeRowsForGrant(client, res.rows[0].id as string);
    await client.query("commit");
    expiresAt = res.rows[0].expires_at;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // #99 — DB write FIRST, sweep SECOND (see revokeAgent). Mint/rotate REPLACES key_hash and kills the
  // derived bridge rows precisely because rotation is the compromise response: a live MCP session
  // cached off the OLD key must die with it, not survive to teardown.
  endAgentSessions(LOCAL_USER_ID, agentId);
  // key returned ONCE; key_hash never returned. expires_at echoes the computed deadline (or null).
  sendJson(ctx.res, 201, { agentId, sectors, key, expires_at: expiresAt });
}

/**
 * Agent passage (#89 item 4 / #80) — the two grains, both computed as an AGGREGATE over the WHOLE
 * audit_log, never over a page of `/api/audit`.
 *
 * That distinction is the entire point. `/api/audit` is newest-first, `limit` defaults to 100 and caps
 * at 1000, so reducing that feed to last-seen is correct only for agents inside the window: an agent
 * whose last call was a week ago falls off the end and renders as "never" — false, not approximate,
 * worse as the gateway gets busier, and invisible in any fixture. `max(created_at) group by` has no
 * window, so a year-idle agent still reports its real instant.
 *
 * Honesty bounds, written down rather than discovered later:
 *   - audit() is fire-and-forget and droppable by design (src/audit/index.ts), so both values are a
 *     LOWER BOUND on activity. The direction is safe for the question being asked ("is this key stale
 *     enough to revoke?"): a dropped line can only make a key look quieter, and every call is an
 *     independent chance to record, so an active key going wholly unrecorded is not a real shape.
 *   - `audit_log` is append-only with NO retention job anywhere in this repo (verified), so nothing
 *     silently ages out from under these aggregates.
 *   - `audit_log.agent_id` is plain text with no FK, so a re-minted (rotated) key inherits the history
 *     of the previous key of the same name. `agent_grants.created_at` is not touched by the mint
 *     upsert, so it could not filter that either; the value answers "when did this agent id last come
 *     through", which is the question the register asks.
 *
 * Cost: one pass over this user's audit rows per grain. `audit_log` is indexed `(user_id, created_at
 * desc)` only, so neither aggregate is index-covered — acceptable on a loopback admin read (this is
 * not the agent hot path, and the audit WRITER is untouched: nothing here makes it block), but a
 * supporting index is owed. See the report.
 */
async function agentPassage(userId: string): Promise<{
  lastSeen: Map<string, string>;
  lastRead: Map<string, Record<string, string>>;
}> {
  // Per-agent: ANY audited call, allowed or denied. A denied call is still this key coming through the
  // gate, and for "is this key still in use?" the broader reading is the safe one — it can only ever
  // make a live key look live.
  const seenRes = await pool.query(
    `select agent_id, max(created_at) as at
       from audit_log
      where user_id = $1 and agent_id is not null
      group by agent_id`,
    [userId],
  );
  // Per-(agent, sector): ALLOWED reads only. A deny means the agent did NOT read that sector, and
  // 'invoke_action' is the act half (the sector lens captions it in its own lane), so neither belongs
  // in a "last read" figure.
  const readRes = await pool.query(
    `select agent_id, sector, max(created_at) as at
       from audit_log
      where user_id = $1 and agent_id is not null and sector is not null
        and decision = 'allow' and tool <> 'invoke_action'
      group by agent_id, sector`,
    [userId],
  );
  const lastSeen = new Map<string, string>();
  for (const r of seenRes.rows) {
    const at = toIsoTs(r.at);
    if (at != null) lastSeen.set(r.agent_id as string, at);
  }
  const lastRead = new Map<string, Record<string, string>>();
  for (const r of readRes.rows) {
    const at = toIsoTs(r.at);
    if (at == null) continue;
    const agentId = r.agent_id as string;
    let per = lastRead.get(agentId);
    if (!per) {
      per = {};
      lastRead.set(agentId, per);
    }
    per[r.sector as string] = at;
  }
  return { lastSeen, lastRead };
}

/** Normalize a pg timestamp (Date | string | null) to an ISO string, or null. */
function toIsoTs(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * GET /api/agents — never returns key_hash. Carries agent passage (#89 item 4 / #80):
 *   `last_seen_at`  string | null — when this key last came through, ANY sector, allowed or denied.
 *                                   `null` = served, and genuinely never seen. (Absent = a gateway
 *                                   that predates the field; a client must render that as "not
 *                                   served", never "never".)
 *   `last_read_at`  { [sector]: iso } — last ALLOWED read per sector. A sector key that is ABSENT
 *                                   means this agent has no recorded allowed read there; the object
 *                                   itself is always present (`{}` for an agent that never read).
 */
export async function listAgents(ctx: RouteContext): Promise<void> {
  const res = await pool.query(
    `select agent_id, sectors, created_at, revoked_at, expires_at
       from agent_grants where user_id = $1 order by created_at desc`,
    [LOCAL_USER_ID],
  );
  const passage = await agentPassage(LOCAL_USER_ID);
  sendJson(
    ctx.res,
    200,
    res.rows.map((r) => ({
      agentId: r.agent_id,
      sectors: r.sectors,
      created_at: r.created_at,
      revoked_at: r.revoked_at,
      expires_at: r.expires_at,
      last_seen_at: passage.lastSeen.get(r.agent_id as string) ?? null,
      last_read_at: passage.lastRead.get(r.agent_id as string) ?? {},
    })),
  );
}

/**
 * PATCH /api/agents/:agentId — edit the grant IN PLACE: the granted sectors and/or the key's expiry,
 * without touching `key_hash`. Rotating to change a deadline forced every session to re-auth (#80);
 * this is the same edit without destroying the secret.
 *
 * AN EXPIRY EDIT MUST NEVER RESURRECT A DEAD KEY, so it is refused outright on a grant that is
 * already dead — revoked, or past `expires_at`. Both are live predicates, not stored states: nothing
 * stamps a row when it expires, so `expires_at = null` on an expired grant would hand the ORIGINAL
 * secret back its access (`resolveBearer` re-reads the row per request), and every oauth-bridge
 * refresh token derived from it — dead only because the bridge clamps to `min(access_expires_at,
 * grant.expires_at)` and re-reads the grant on refresh — would come back with it. Rotation is the
 * only path back from dead, and rotation replaces the secret and kills the derived rows (ADR 0029 §5).
 * The guard is a clause in the UPDATE's own WHERE, so it reads the PRE-update row and there is no
 * read-then-write window; a refused edit writes nothing at all, sectors included.
 *
 * A SECTORS-ONLY patch is deliberately NOT guarded — it was allowed on a revoked/expired grant before
 * this unit (harmlessly: the sectors of a key that cannot resolve are inert), and narrowing it would
 * remove a capability this issue never asked about.
 *
 * Clearing the expiry (`expiresInDays: null`) makes the key ineligible for the oauth-bridge authorize
 * flow, which refuses a never-expiring key by design (ADR 0035 §D3 item 6) — a documented consequence
 * of the edit, not a hole: the refusal is re-evaluated per authorize.
 *
 * Row shape is unchanged, so a caller that only ever sent `{ sectors }` sees exactly what it saw.
 */
export async function patchAgent(ctx: RouteContext, body: unknown): Promise<void> {
  const parsed = grantPatchBody.safeParse(body);
  if (!parsed.success) {
    // Typed 400 NAMES the expiry field (the postAgent convention); generic otherwise.
    if (parsed.error.issues.some((i) => i.path[0] === "expiresInDays")) {
      throw new ValidationError(
        "invalid 'expiresInDays': must be an integer between 1 and 3650, or null for never",
      );
    }
    throw new ValidationError("invalid request body");
  }
  const { sectors } = parsed.data;
  // A JSON body cannot carry an explicit `undefined`, so undefined ⟺ the key was absent ⟺ unchanged.
  const editsExpiry = parsed.data.expiresInDays !== undefined;
  if (sectors === undefined && !editsExpiry) {
    throw new ValidationError("nothing to update: send 'sectors' and/or 'expiresInDays'");
  }
  const agentId = ctx.params.agentId;

  // SQL text is assembled from FIXED fragments chosen by which fields the body carried; every value
  // (including the day count) is a bind parameter.
  const sets: string[] = [];
  const values: unknown[] = [LOCAL_USER_ID, agentId];
  if (sectors !== undefined) {
    values.push(sectors);
    sets.push(`sectors = $${values.length}`);
  }
  let liveOnly = "";
  if (editsExpiry) {
    if (parsed.data.expiresInDays === null) {
      sets.push(`expires_at = null`);
    } else {
      values.push(parsed.data.expiresInDays);
      sets.push(`expires_at = now() + make_interval(days => $${values.length}::int)`);
    }
    // The dead-key refusal. `> now()` is the exact complement of resolveBearer's `<= now()` deny.
    liveOnly = ` and revoked_at is null and (expires_at is null or expires_at > now())`;
  }

  const res = await pool.query(
    `update agent_grants set ${sets.join(", ")}
       where user_id = $1 and agent_id = $2${liveOnly}
     returning agent_id, sectors, created_at, revoked_at, expires_at`,
    values,
  );
  if (!res.rows[0]) {
    // Zero rows means unknown agent — OR, when the expiry guard was in play, a dead key. Separate the
    // two so the 400 is actionable (the deleteAgent precedent), and never guess: only an expiry edit
    // can be refused for a liveness reason.
    if (editsExpiry) {
      const probe = await pool.query(
        `select revoked_at, expires_at from agent_grants where user_id = $1 and agent_id = $2`,
        [LOCAL_USER_ID, agentId],
      );
      const dead = probe.rows[0];
      if (dead) {
        throw new ValidationError(
          dead.revoked_at != null
            ? "a revoked key's expiry cannot be changed — rotate to mint a fresh key with a new deadline"
            : "an expired key's expiry cannot be changed — rotate to mint a fresh key with a new deadline",
        );
      }
    }
    throw new ValidationError("unknown agentId");
  }
  // #99 — sweep on EVERY grant change, widening included: the cached grantedSectors Set is stale
  // either way, and one unconditional rule is safer than a diff-the-arrays conditional (a second
  // place for the grant semantics to drift). Cost is one re-initialize.
  //
  // #80 — an EXPIRY edit needs the same sweep for a second reason: a live MCP session's AuthContext
  // carries `expiresAt` resolved once at initialize (auth/resolve.ts), so a SHORTENED deadline would
  // not bite inside that session until it re-initialized. The unconditional sweep already covers it.
  endAgentSessions(LOCAL_USER_ID, agentId);
  const r = res.rows[0];
  sendJson(ctx.res, 200, {
    agentId: r.agent_id,
    sectors: r.sectors,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    expires_at: r.expires_at,
  });
}

/**
 * POST /api/agents/:agentId/revoke — stamp revoked_at (idempotent), then END every live MCP session
 * this agent holds (#99). Before this, revoke bit on the REST mirror immediately (it re-resolves the
 * bearer per request, mirror.ts:47-50) but not on the MCP edge, whose ctx is cached per session —
 * the two agent edges disagreed about what Revoke means. They now agree.
 *
 * ORDER IS LOAD-BEARING: DB write FIRST, sweep SECOND. A sweep before the write would leave a window
 * in which a fresh initialize legitimately re-resolves the not-yet-revoked row and binds. Write-then-
 * sweep plus the bind() fence closes both directions.
 */
export async function revokeAgent(ctx: RouteContext): Promise<void> {
  const agentId = ctx.params.agentId;
  const res = await pool.query(
    `update agent_grants set revoked_at = coalesce(revoked_at, now())
     where user_id = $1 and agent_id = $2
     returning agent_id, revoked_at`,
    [LOCAL_USER_ID, agentId],
  );
  if (!res.rows[0]) throw new ValidationError("unknown agentId");
  const sessionsEnded = endAgentSessions(LOCAL_USER_ID, agentId);
  const r = res.rows[0];
  sendJson(ctx.res, 200, { agentId: r.agent_id, revoked_at: r.revoked_at, sessions_ended: sessionsEnded });
}

/**
 * DELETE /api/agents/:agentId — hard-remove a grant row (#24). Gated to an ALREADY-REVOKED agent
 * (revoke-then-remove) so a live agent is never deleted out from under an in-flight session; revoke
 * first via POST …/revoke. The `audit_log.agent_id` column is plain TEXT (no FK to `agent_grants`,
 * verified against db/schema.sql), so the agent's audit history SURVIVES this delete — the trail is
 * never lost. Parameterized + user-scoped; localOnly. An unknown id → 400; a not-yet-revoked id → 400
 * (a distinct message so the operator knows to revoke first).
 */
export async function deleteAgent(ctx: RouteContext): Promise<void> {
  const agentId = ctx.params.agentId;
  const res = await pool.query(
    `delete from agent_grants
       where user_id = $1 and agent_id = $2 and revoked_at is not null
       returning agent_id`,
    [LOCAL_USER_ID, agentId],
  );
  if (!res.rows[0]) {
    // Distinguish unknown from not-yet-revoked so the operator gets an actionable 400.
    const exists = await pool.query(
      `select 1 from agent_grants where user_id = $1 and agent_id = $2`,
      [LOCAL_USER_ID, agentId],
    );
    if (!exists.rows[0]) throw new ValidationError("unknown agentId");
    throw new ValidationError("agent must be revoked before it can be removed");
  }
  // #99 — idempotent belt: the gate above already requires a prior revoke (which swept), but a
  // delete must not be the one verb that can leave a session behind. Response shape unchanged.
  endAgentSessions(LOCAL_USER_ID, agentId);
  sendJson(ctx.res, 200, { ok: true });
}

/** Rows one audit page serves when the caller names no `limit`. */
export const AUDIT_LIMIT_DEFAULT = 100;
/** Hard ceiling on one page. Older history is reached with `before`, never by raising this. */
export const AUDIT_LIMIT_MAX = 1000;
/**
 * `true`/`false` on EVERY 200 from getAudit. Always present so a client can tell "this gateway pages"
 * from "this gateway is older than the cursor" — the absence of the -next header then means
 * end-of-history and nothing else.
 */
export const AUDIT_HAS_MORE_HEADER = "x-postern-audit-has-more";
/** The opaque cursor for the NEXT page — present iff has-more is true. Send it back as `?before=`. */
export const AUDIT_NEXT_HEADER = "x-postern-audit-next";
/**
 * The cursor grammar: a MICROSECOND-exact UTC instant, then the row id. Both halves are mandatory by
 * construction — see getAudit for why a timestamp-only cursor silently loses rows.
 */
const AUDIT_CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(\d{1,19})$/;
/** 2^63-1: `audit_log.id` is a bigserial, and a larger cursor id would fail the ::bigint cast as a 500. */
const MAX_BIGINT = BigInt("9223372036854775807");
/** The audit row shape on the wire — the columns getAudit has always served, and only those. */
const AUDIT_WIRE_COLUMNS = [
  "id",
  "agent_id",
  "tool",
  "sector",
  "decision",
  "deny_reason",
  "args",
  "result_count",
  "outcome",
  "request_id",
  "created_at",
] as const;

/**
 * GET /api/audit?agent=&tool=&decision=&sector=&since=&before=&limit= — a page of the ledger, newest
 * first. Every filter is optional and every value is a bind parameter; the SQL TEXT is assembled only
 * from fixed fragments chosen by which params were present.
 *
 * SECTOR (#61 part 1) is a plain equality clause on the dedicated `audit_log.sector` column. It is
 * matched verbatim and never validated against the registry: audit is a historical ledger, so a
 * sector that no longer exists must return the rows it has, not a 400. Rows with a NULL sector (the
 * gateway-wide verbs — describe_context, get_schema, an initialize denial) are correctly excluded by
 * any sector filter, since none of them happened *in* a sector.
 *
 * PAGING (#61 part 2) is a KEYSET cursor on the query's own sort key, `(created_at desc, id desc)` —
 * never OFFSET. This ledger is written by a fire-and-forget batch writer while it is being read, and
 * OFFSET counts from the head: any row inserted mid-pagination shifts the window and the next page
 * silently SKIPS as many rows as landed. A keyset cursor is anchored to a row's own key instead, so
 * concurrent inserts (which carry a later instant, i.e. a key ABOVE any cursor already crossed) cannot
 * move it. `id` is not decoration: the writer batch-INSERTS, so every row in one flush shares
 * `created_at` to the microsecond — a `created_at`-only cursor with `<` would drop the rest of that
 * batch and with `<=` would repeat it. The bigserial id makes the key a total order, so a page can
 * neither drop nor duplicate a row.
 *
 * The cursor is SERVER-MINTED for a reason the client cannot work around: node-postgres parses
 * timestamptz into a JS Date, which is millisecond-precision, so the `created_at` on the wire has LOST
 * the microseconds. A cursor rebuilt from it lands up to 999µs off the row it was standing on, and
 * every row inside that window is then silently dropped from the walk (or, if the driver ever rounded
 * up instead of down, the anchor row is served twice). Sub-millisecond neighbours are not exotic here:
 * the writer flushes in batches. So the exact value comes out of Postgres as text (`to_char … US`) and
 * is echoed in the -next header for the client to hand back verbatim; a value that does not match the
 * grammar is a 400, because refusing to page is strictly better than mis-paging the one oversight
 * surface. The 'before' param is deliberately NOT a bare timestamp for the same reason.
 *
 * `has_more` comes from a limit+1 PROBE row, never from `count === limit` (the core/query.ts rule): an
 * exactly-full final page must report end-of-history, not offer a cursor to nothing.
 */
export async function getAudit(ctx: RouteContext): Promise<void> {
  const q = ctx.query;
  const clauses: string[] = ["user_id = $1"];
  const values: unknown[] = [LOCAL_USER_ID];

  const agent = q.get("agent");
  if (agent) {
    values.push(agent);
    clauses.push(`agent_id = $${values.length}`);
  }
  const tool = q.get("tool");
  if (tool) {
    values.push(tool);
    clauses.push(`tool = $${values.length}`);
  }
  const decision = q.get("decision");
  if (decision) {
    values.push(decision);
    clauses.push(`decision = $${values.length}`);
  }
  const sector = q.get("sector");
  if (sector) {
    values.push(sector);
    clauses.push(`sector = $${values.length}`);
  }
  const since = q.get("since");
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) throw new ValidationError("invalid 'since' timestamp");
    values.push(d.toISOString());
    clauses.push(`created_at >= $${values.length}`);
  }
  const before = q.get("before");
  if (before) {
    const m = AUDIT_CURSOR_RE.exec(before);
    if (!m || BigInt(m[2]) > MAX_BIGINT) {
      throw new ValidationError(
        `invalid 'before' cursor: echo the previous page's ${AUDIT_NEXT_HEADER} header value unmodified`,
      );
    }
    values.push(m[1]);
    const tsIdx = values.length;
    values.push(m[2]);
    // The row comparison IS the predicate; the redundant scalar bound is implied by it and is what the
    // (user_id, created_at desc) index can range-scan on, so paging stays an O(limit) walk.
    clauses.push(
      `created_at <= $${tsIdx}::timestamptz and (created_at, id) < ($${tsIdx}::timestamptz, $${values.length}::bigint)`,
    );
  }

  let limit = AUDIT_LIMIT_DEFAULT;
  const limitRaw = q.get("limit");
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) throw new ValidationError("invalid 'limit'");
    limit = Math.min(n, AUDIT_LIMIT_MAX);
  }
  values.push(limit + 1); // the has_more probe row — trimmed below, never served

  const res = await pool.query(
    `select id, agent_id, tool, sector, decision, deny_reason, args, result_count, outcome, request_id, created_at,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts
       from audit_log where ${clauses.join(" and ")}
       order by created_at desc, id desc limit $${values.length}`,
    values,
  );

  const hasMore = res.rows.length > limit;
  const served = hasMore ? res.rows.slice(0, limit) : res.rows;
  ctx.res.setHeader(AUDIT_HAS_MORE_HEADER, hasMore ? "true" : "false");
  if (hasMore) {
    const last = served[served.length - 1];
    ctx.res.setHeader(AUDIT_NEXT_HEADER, `${last.cursor_ts}|${last.id}`);
  }
  // Projected explicitly: `cursor_ts` is an internal paging column and must never reach the wire, and
  // the served row shape stays exactly what it was before paging existed.
  sendJson(
    ctx.res,
    200,
    served.map((r) => Object.fromEntries(AUDIT_WIRE_COLUMNS.map((c) => [c, r[c]]))),
  );
}
