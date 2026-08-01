// Plaid onboarding + health routes (wave 13, grounded — ADR 0019/0020). Operator-local-trusted (no
// per-request auth; the server binds 127.0.0.1 + the Host-allowlist, so reaching these implies operator
// trust). The handlers read their own body, so the mother registers them DIRECTLY (not via withBody).
// Secrets/tokens (client_secret, access_token, public_token, link_token) are NEVER echoed or logged.
//
//   GET/POST/DELETE /api/plaid/app    -> BYO Plaid app creds (client_id + sealed secret + env).
//   POST /api/plaid/hosted-link       -> mint a hosted multi-Item Link session ({ linkToken, hostedLinkUrl }).
//   POST /api/plaid/poll {linkToken}  -> capture: exchange EACH item_add_results public_token per-Item.
//   POST /api/plaid/relink {connectionId} -> update-mode re-link mint (carries the stored access_token).
//   POST /api/plaid/link-token        -> legacy single-Item link_token (kept).
//   POST /api/plaid/exchange {public_token} -> legacy single exchange (now delegates to exchangeAndStore).

import { z } from "zod";
import { pool } from "../db.js";
import { open } from "../secrets/index.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import {
  linkTokenCreate,
  hostedLinkCreate,
  linkTokenGet,
  relinkTokenCreate,
  exchangeAndStore,
} from "../connectors/plaid.js";
import { getPlaidApp, setPlaidApp, clearPlaidApp } from "../plaid/app-config.js";
import { auditAdmin } from "../core/lifecycle.js";
import { readJson, sendJson, ValidationError, type RouteContext } from "./router.js";

const exchangeBody = z.object({ public_token: z.string().min(1) });
const appBody = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  env: z.enum(["sandbox", "production"]),
});
// The Console client sends camelCase bodies (`{ linkToken }`, `{ connectionId }`) — the frozen contract.
const pollBody = z.object({ linkToken: z.string().min(1) });
const relinkBody = z.object({ connectionId: z.string().uuid() });

/** One connected Plaid Item (bank) in the poll response — the frozen Console contract shape. */
interface PlaidConnectionView {
  connectionId: string;
  itemId: string;
  institutionName: string | null;
  health: { status: string } | null;
}

/**
 * Load the frozen poll-view (institution + health) for the connections created this poll. Health is the
 * credential's stored `item_status` (exchangeAndStore seeds it 'ok'; a later sync refreshes it via the
 * /item/get poll); institution_name is best-effort from the cached finance_accounts (null until the
 * first sync resolves it). Order is preserved to match the exchange order. NO token/secret is read.
 */
async function loadPlaidConnectionViews(connectionIds: string[]): Promise<PlaidConnectionView[]> {
  if (connectionIds.length === 0) return [];
  const res = await pool.query(
    `select c.id as connection_id,
            pc.external_item_id as item_id,
            pc.item_status as item_status,
            (select fa.institution_name
               from finance_accounts fa
              where fa.connection_id = c.id and fa.institution_name is not null
              limit 1) as institution_name
       from connectors c
       join provider_credentials pc on pc.id = c.credential_id
      where c.id = any($1::uuid[]) and c.user_id = $2`,
    [connectionIds, LOCAL_USER_ID],
  );
  const byId = new Map<string, (typeof res.rows)[number]>(res.rows.map((r) => [r.connection_id as string, r]));
  return connectionIds.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        connectionId: r.connection_id as string,
        itemId: (r.item_id as string | null) ?? "",
        institutionName: (r.institution_name as string | null) ?? null,
        health: r.item_status ? { status: r.item_status as string } : null,
      },
    ];
  });
}

// ── BYO Plaid app creds (sub-unit A/C) ──────────────────────────────────────────

/** GET /api/plaid/app — status only: { configured, clientId, env }. The secret NEVER leaves the vault. */
export async function getPlaidAppRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, await getPlaidApp());
}

/**
 * POST /api/plaid/app { clientId, clientSecret, env } — seal the secret in the vault + upsert the
 * singleton plaid_app row. Responds with the (secret-free) status. A bad client type / empty field is a
 * ConfigError (→ 400, via setPlaidApp). The client_secret is NEVER echoed.
 */
export async function setPlaidAppRoute(ctx: RouteContext): Promise<void> {
  const raw = await readJson(ctx.req);
  const parsed = appBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError("invalid request body: clientId, clientSecret, env required");
  // Audit the credential write AFTER the mutation, env-only — the client_secret is sealed in the vault
  // and NEVER reaches the audit row. An 'error' line is fired on a caught failure so a silent loss
  // (the symptom this child closes) always leaves a trace.
  try {
    await setPlaidApp(parsed.data.clientId, parsed.data.clientSecret, parsed.data.env);
  } catch (e) {
    auditAdmin(LOCAL_USER_ID, "set_plaid_app", { env: parsed.data.env }, "error");
    throw e;
  }
  auditAdmin(LOCAL_USER_ID, "set_plaid_app", { env: parsed.data.env }, "ok");
  sendJson(ctx.res, 200, await getPlaidApp());
}

/** DELETE /api/plaid/app — clear the configured app + its sealed secret (idempotent). Audited (no args). */
export async function deletePlaidAppRoute(ctx: RouteContext): Promise<void> {
  try {
    await clearPlaidApp();
  } catch (e) {
    auditAdmin(LOCAL_USER_ID, "delete_plaid_app", {}, "error");
    throw e;
  }
  auditAdmin(LOCAL_USER_ID, "delete_plaid_app", {}, "ok");
  sendJson(ctx.res, 200, { configured: false });
}

// ── Hosted Link onboarding (sub-unit A) ──────────────────────────────────────────

/**
 * POST /api/plaid/hosted-link — mint a hosted, multi-Item Link session. Returns { linkToken,
 * hostedLinkUrl } (the frozen Console contract — the operator opens hostedLinkUrl, authenticates each
 * bank, then the Console polls /api/plaid/poll). No DB write. The linkToken is short-lived and never a
 * durable credential.
 */
export async function postPlaidHostedLink(ctx: RouteContext): Promise<void> {
  const { linkToken, hostedLinkUrl } = await hostedLinkCreate();
  sendJson(ctx.res, 200, { linkToken, hostedLinkUrl });
}

/**
 * POST /api/plaid/poll { linkToken } — capture a finished hosted-Link session. Reads the
 * results.item_add_results ARRAY and exchanges EACH public_token per-Item (exchangeAndStore: seal +
 * upsert a credential keyed by external_item_id + a finance connector). Idempotent: an already-consumed
 * public_token is skipped (no row). The first /transactions/sync commonly returns empty (backfill lands
 * over subsequent syncs), so a freshly-created connection reads as healthy-but-syncing, never a failure.
 *
 * Returns the FROZEN Console contract — `{ complete, connections }` — and NOTHING else: `complete` is
 * true once the session's results window has resolved; `connections` is the banks exchanged THIS poll,
 * each as { connectionId, itemId, institutionName, health: { status } | null }. NO token is echoed.
 */
export async function postPlaidPoll(ctx: RouteContext): Promise<void> {
  const raw = await readJson(ctx.req);
  const parsed = pollBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError("invalid request body: linkToken required");

  const { items, complete } = await linkTokenGet(parsed.data.linkToken);

  // Exchange each Item; collect the connections created this poll (an already-consumed public_token is
  // skipped — no connectionId, no duplicate). Order preserved so the view matches the exchange order.
  const createdIds: string[] = [];
  for (const { publicToken } of items) {
    const r = await exchangeAndStore(publicToken);
    if (!r.skipped && r.connectionId) createdIds.push(r.connectionId);
  }
  const connections = await loadPlaidConnectionViews(createdIds);

  // complete=false → the user hasn't finished adding banks yet; the Console keeps polling.
  sendJson(ctx.res, 200, { complete, connections });
}

// ── Update-mode re-link (sub-unit B) ─────────────────────────────────────────────

/**
 * POST /api/plaid/relink { connectionId } — mint an UPDATE-mode hosted Link carrying the connection's
 * stored access_token (re-consent for a broken Item). The access_token/external_item_id are UNCHANGED
 * across update mode, so there is NO row repointing: on success the next sync clears the error and
 * resumes the cursor. The access token is opened from the vault, handed to Plaid, and NEVER echoed.
 */
export async function postPlaidRelink(ctx: RouteContext): Promise<void> {
  const raw = await readJson(ctx.req);
  const parsed = relinkBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError("invalid request body: connectionId required");

  const res = await pool.query(
    `select pc.secret_ref, pc.provider
       from connectors c
       join provider_credentials pc on pc.id = c.credential_id
      where c.id = $1 and c.user_id = $2`,
    [parsed.data.connectionId, LOCAL_USER_ID],
  );
  const row = res.rows[0];
  if (!row) throw new ValidationError("unknown connectionId");
  if (row.provider !== "plaid") throw new ValidationError("connection is not a plaid connection");
  if (!row.secret_ref) throw new ValidationError("connection has no stored access token to re-link");

  const accessToken = (
    await open(row.secret_ref as string, { userId: LOCAL_USER_ID, provider: "plaid", purpose: "access" })
  ).toString("utf8");

  const { linkToken, hostedLinkUrl } = await relinkTokenCreate(accessToken);
  // access token NEVER echoed. Frozen Console contract: { linkToken, hostedLinkUrl }.
  sendJson(ctx.res, 200, { linkToken, hostedLinkUrl });
}

// ── Legacy single-Item routes (kept; exchange now delegates to exchangeAndStore) ──

/**
 * POST /api/plaid/link-token — legacy single-Item link_token (the pre-hosted widget path). No DB write.
 */
export async function postPlaidLinkToken(ctx: RouteContext): Promise<void> {
  const linkToken = await linkTokenCreate();
  sendJson(ctx.res, 200, { link_token: linkToken });
}

/**
 * POST /api/plaid/exchange { public_token } — legacy single exchange. Delegates to exchangeAndStore
 * (exchange → seal → per-Item credential + finance connector). An exchange failure is { skipped } →
 * mapped to a 4xx (no rows written); the access token is sealed only, never echoed.
 */
export async function postPlaidExchange(ctx: RouteContext): Promise<void> {
  const raw = await readJson(ctx.req); // PayloadTooLargeError/ValidationError -> 400
  const parsed = exchangeBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError("invalid request body: public_token required");

  const r = await exchangeAndStore(parsed.data.public_token);
  if (r.skipped || !r.connectionId) {
    // Exchange failed / token already consumed — no rows written. Secret-free 4xx.
    throw new ValidationError("plaid public_token exchange failed");
  }
  sendJson(ctx.res, 201, {
    credentialId: r.credentialId,
    connectionId: r.connectionId,
    provider: "plaid",
    sector: "finance",
    itemId: r.itemId,
  });
}
