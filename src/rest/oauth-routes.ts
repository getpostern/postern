// OAuth onboarding routes — the first-party PKCE consent flow over the admin (local-trusted) surface.
//
// GET /api/oauth/:provider/start    -> startPkce(provider, <this server's callback>); returns the
//                                      authorization URL for the Console to open.
// GET /api/oauth/:provider/callback -> takePending(state) (one-shot; invalid/expired -> 400),
//                                      exchangeCode(...), then SEAL: access token -> secret_ref
//                                      (purpose 'access'), refresh token -> refresh_ref (purpose
//                                      'refresh'); upsert provider_credentials (custody='first_party',
//                                      expires_at = now + expiresInSec, granted_scopes), AUTO-CREATE
//                                      one connector per sector the granted scopes cover (one consent
//                                      = a fully connected provider), pause uncovered siblings, and
//                                      302 to the Console success page (+ credential_id & provider —
//                                      ids only). Tokens are NEVER returned to the browser and never
//                                      logged.

import { pool } from "../db.js";
import { seal, deleteSecret } from "../secrets/index.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import {
  isConfidential,
  isOAuthProvider,
  providerConfig,
  providerScopes,
  type OAuthProvider,
} from "../oauth/providers.js";
import { getProviderApp, setProviderApp } from "../oauth/provider-apps.js";
import { startPkce, takePending } from "../oauth/pkce.js";
import { exchangeCode, TokenEndpointError, type TokenSet } from "../oauth/exchange.js";
import { readJson, sendJson, ValidationError, type RouteContext } from "./router.js";

// ── Scope → sector mapping (declarative; keyed on the EXACT strings providers.ts requests) ──────
//
// google scopes are full URLs, verbatim from providers.ts. microsoft scopes may come back bare
// ("Mail.Read") or Graph-prefixed ("https://graph.microsoft.com/Mail.Read") — each granted scope is
// normalized to its final path segment, case-insensitive, before matching; calendars.read /
// contacts.read are included NOW (inert until providers.ts requests them). whoop scopes are exact.
// Non-mapping scopes (offline_access / offline / read:profile) map to nothing. Maps — not plain
// objects — so a hostile scope string can never match a prototype key.
const SCOPE_SECTORS: Record<OAuthProvider, ReadonlyMap<string, string>> = {
  google: new Map([
    ["https://www.googleapis.com/auth/calendar.readonly", "calendar"],
    ["https://www.googleapis.com/auth/contacts.readonly", "contacts"],
  ]),
  microsoft: new Map([
    ["mail.read", "mail"],
    ["calendars.read", "calendar"],
    ["contacts.read", "contacts"],
  ]),
  whoop: new Map([
    ["read:recovery", "health"],
    ["read:sleep", "health"],
    ["read:workout", "health"],
  ]),
};

/** Per-provider normalization applied to each GRANTED scope before the map lookup. */
function normalizeScope(provider: OAuthProvider, scope: string): string {
  if (provider === "microsoft") {
    // Graph echoes scopes bare or resource-prefixed; both normalize to the final path segment.
    const lastSegment = scope.split("/").pop() ?? scope;
    return lastSegment.toLowerCase();
  }
  return scope;
}

/**
 * Sectors a consent covers. Keyed on the EXACT scope strings providers.ts requests; `granted` is
 * normalized per provider before matching. When the token response omitted `scope` entirely
 * (RFC 6749 §5.1: absent ⇒ granted == requested), pass null → map off providerScopes(p) (the static
 * requested set; no client_id / DB needed, so this stays synchronous).
 */
export function sectorsForScopes(provider: OAuthProvider, granted: string[] | null): string[] {
  const scopes = granted ?? providerScopes(provider);
  const map = SCOPE_SECTORS[provider];
  const sectors = new Set<string>();
  for (const scope of scopes) {
    const sector = map.get(normalizeScope(provider, scope));
    if (sector) sectors.add(sector);
  }
  return [...sectors];
}

/** Resolve a path param to a known OAuth provider or 400. */
function requireProvider(raw: string): OAuthProvider {
  if (!isOAuthProvider(raw)) throw new ValidationError(`unknown oauth provider: ${raw}`);
  return raw;
}

/**
 * The HOST half of the default base URL. `localhost`, not `127.0.0.1`: Postern is BYO-app (ADR 0014),
 * so every user registers their own Entra app, and Microsoft's portal refuses an http-scheme IP
 * loopback in the Redirect URIs box (it also port-wildcards `localhost`). Google accepts both; WHOOP
 * is proven on `localhost`.
 *
 * It is a CONSTANT and must stay one: the base is PINNED, never derived from the inbound `Host`
 * header, and never a `*.ts.net` name — ADR 0035 §D5 (nobody owns `ts.net` but Tailscale, so Google's
 * domain-ownership check can never pass for one). Only the PORT below varies.
 */
const DEFAULT_BASE_HOST = "http://localhost";

/**
 * The REST port to assume when `REST_PORT` says nothing. Twin of `REST_DEFAULT_PORT` in
 * `src/bootstrap.ts` — the two MUST agree, because that one decides where the edge listens and this
 * one decides which address we tell a provider to send the user back to. They cannot be one constant
 * without an import cycle (`bootstrap.ts` → `rest/index.ts` → here), so their agreement is asserted
 * instead, by reading both files, in `src/rest/one-origin.packaging.test.ts`.
 */
const REST_DEFAULT_PORT = 8787;

/**
 * The default this gateway serves when PCI_PUBLIC_BASE_URL says nothing usable — `http://localhost`
 * on whatever port the REST edge was told to listen on. It is composed HERE and NOWHERE ELSE:
 * docker-compose deliberately declares the knob as `"${PCI_PUBLIC_BASE_URL:-}"` with an EMPTY
 * default, because two copies of a default is exactly the drift ADR 0035 §D4 removes.
 *
 * It FOLLOWS `REST_PORT` (#117). Frozen at `:8787`, a user who moved their REST port because 8787 was
 * taken kept sending providers a `redirect_uri` on a port their browser never used — consent then
 * fails at Google/Microsoft/WHOOP with a mismatch, blaming a URI the user never typed. Reading the
 * same env var the edge reads makes the two impossible to disagree. The host publish in
 * docker-compose is 1:1 for exactly this reason: inside-the-container port == in-your-browser port.
 *
 * Read at CALL time, never memoized — `canonicalBaseUrl()` already re-reads its env var per call, and
 * a module-load snapshot would freeze whatever the first import happened to see.
 */
function defaultBaseUrl(): string {
  const raw = (process.env.REST_PORT ?? "").trim();
  const parsed = raw === "" ? REST_DEFAULT_PORT : Number(raw);
  // Anything unusable (blank, non-numeric, out of range, or the `0`/negative that DISABLES the edge
  // in bootstrap.ts) falls back rather than throwing: a bad knob must never brick consent, and when
  // the edge is disabled there is no browser origin for this value to be wrong about anyway.
  const port =
    Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : REST_DEFAULT_PORT;
  // Port 80 is http's default: a browser shows (and sends) `http://localhost`, never
  // `http://localhost:80`, and providers exact-match the literal. Emitting the port here would
  // mismatch the URI the operator actually registered.
  return port === 80 ? DEFAULT_BASE_HOST : `${DEFAULT_BASE_HOST}:${port}`;
}

/**
 * The canonical public base URL of this gateway — PCI_PUBLIC_BASE_URL (read at call time), default
 * `http://localhost:<REST_PORT>` (`:8787` on a stock install — see `defaultBaseUrl()`). PINNED here
 * (the HOST is a constant, NOT derived from the inbound Host header) so the redirect_uri
 * we send to the provider is ALWAYS the exact literal the operator registered — providers like WHOOP
 * exact-match the redirect, and a Host-derived value (127.0.0.1 vs localhost, a proxied host) would
 * silently mismatch. Trailing slash trimmed.
 *
 * **The EMPTY STRING is the DEFAULT case, not an edge case.** compose delivers `PCI_PUBLIC_BASE_URL`
 * as `""` to every install whose operator never edited `.env` — which is all of them on day one. A
 * `??` fallback (null/undefined only) would leave `base === ""` and hand every provider the
 * scheme-less `"/api/oauth/<p>/callback"`, breaking consent for every fresh install. So empty and
 * whitespace-only are treated exactly like unset.
 *
 * A malformed or non-http(s) value WARNS and falls back — it never throws. A bad knob must not brick
 * boot (the #97 vault-gate lesson: a fail-closed check bricked prod on its first deploy).
 *
 * Returns the operator's OWN string (trailing slashes trimmed), never `parsed.toString()`:
 * `new URL("https://gw.example.com").toString()` appends a `/`, and providers exact-match the
 * literal. We parse to VALIDATE, not to rewrite.
 */
export function canonicalBaseUrl(): string {
  const fallback = defaultBaseUrl();
  const raw = (process.env.PCI_PUBLIC_BASE_URL ?? "").trim();
  // Unset, empty (what compose delivers), whitespace-only. DO NOT "simplify" this line away because
  // `new URL("")` throws into the same fallback: the throw path WARNS, and warning on the default
  // install teaches every operator to ignore the one warning that means something. That silence is
  // pinned by `oauth-routes.test.ts` — "the shipped default is SILENT".
  if (raw === "") return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`PCI_PUBLIC_BASE_URL is not a URL (${JSON.stringify(raw)}) — using ${fallback}`);
    return fallback;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(`PCI_PUBLIC_BASE_URL must be http(s) — using ${fallback}`);
    return fallback;
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Build this server's own callback URL for a provider from the PINNED canonical base — independent
 * of the inbound request's Host header. `ctx` is accepted for signature stability but unused.
 */
export function callbackUrl(_ctx: RouteContext, provider: OAuthProvider): string {
  return `${canonicalBaseUrl()}/api/oauth/${provider}/callback`;
}

/**
 * Every Console path this route can 302 to. Each MUST resolve to a real route in
 * `apps/web/src/App.tsx`'s exported ROUTE_TABLE — asserted by
 * `apps/web/src/pages/connect/route-contract.test.ts`, which reads THIS declaration by name.
 *
 * `/connections` was the default until 2026-07-25. It was deleted with the dark-SaaS surface
 * (4bbb22f), so every consent — success AND failure — 302'd onto the Console's `*` "— not found"
 * placeholder while the credential had in fact been created (#96 §1). Do not put a path here that
 * is not in the route table.
 *
 * `PCI_CONSOLE_SUCCESS_URL` can point the SUCCESS redirect anywhere and is deliberately outside this
 * contract — it is the operator's own override, and its query-join rule is covered by
 * `src/rest/admin.db.test.ts`.
 */
export const CONSOLE_REDIRECT_TARGETS = {
  /** Where a completed consent lands: the connections ledger the new rows appear on. */
  success: "/sources",
  /** Where a FAILED consent lands: the provider's own connect screen, which renders the
   *  registration steps and the client-id/secret form — the repair, not a report of the break. */
  google: "/connect/google",
  microsoft: "/connect/microsoft",
  whoop: "/connect/whoop",
} as const satisfies Record<"success" | OAuthProvider, string>;

/**
 * The 302 target: `base` with `credential_id` / `oauth_error` + `provider` appended via the proper
 * join rule — `?` when the base has no query string, `&` when an env override already carries one.
 * URL needs a base to parse relative values; the dummy origin is stripped on the way out, so a
 * relative location stays relative. NO secret material — ids and the provider's own code only.
 */
function consoleLocation(base: string, params: Record<string, string>): string {
  const absolute = /^https?:\/\//i.test(base);
  const url = new URL(base, "http://localhost");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

/** The configured success location (PCI_CONSOLE_SUCCESS_URL, read at call time so tests/deploys can
 *  override) or the Console's connections ledger. */
function successLocation(credentialId: string, provider: OAuthProvider): string {
  return consoleLocation(process.env.PCI_CONSOLE_SUCCESS_URL ?? CONSOLE_REDIRECT_TARGETS.success, {
    credential_id: credentialId,
    provider,
  });
}

/**
 * The 302 target on a FAILED consent — the PROVIDER'S OWN connect screen, with `oauth_error` (the
 * provider's non-token-bearing code) + `provider`, so the Console surfaces the failure on the screen
 * that renders the repair (registration steps + client id/secret) instead of a dead end.
 *
 * No env override here: `PCI_CONSOLE_SUCCESS_URL` says success, and an operator who repoints success
 * has not thereby said where a failure belongs. NO secret material.
 */
function errorLocation(provider: OAuthProvider, code: string): string {
  return consoleLocation(CONSOLE_REDIRECT_TARGETS[provider], { oauth_error: code, provider });
}

/**
 * GET /api/oauth/:provider/start — begin consent. The redirect_uri is THIS server's callback for the
 * provider (loopback). Returns { authorizationUrl } only.
 */
export async function oauthStart(ctx: RouteContext): Promise<void> {
  const provider = requireProvider(ctx.params.provider);
  // Resolve table-first (env fallback); throws ConfigError (→ 400) when the BYO app is unconfigured.
  const cfg = await providerConfig(provider);
  const redirectUri = callbackUrl(ctx, provider);
  const { authorizationUrl } = startPkce(provider, redirectUri, cfg);
  sendJson(ctx.res, 200, { authorizationUrl });
}

/**
 * GET /api/oauth/:provider/app — BYO-app status for the Console setup panel. Returns the public
 * `client_id` (or null) + whether the provider is confidential (drives the secret field), plus the
 * `redirect_uri` this gateway will actually send. The client secret NEVER leaves the vault.
 */
export async function oauthAppStatus(ctx: RouteContext): Promise<void> {
  const provider = requireProvider(ctx.params.provider);
  const { configured, clientId } = await getProviderApp(provider);
  sendJson(ctx.res, 200, {
    provider,
    configured,
    clientId,
    confidential: isConfidential(provider),
    // The EXACT literal this gateway will send as redirect_uri — the ONE source of that string.
    // The Console renders it verbatim; it must never compute its own (ADR 0035 §D4). Derived from
    // the same callbackUrl() the consent flow calls, so the displayed value cannot drift from the
    // sent one. `ctx` stays unused inside callbackUrl: no request header can influence it.
    redirectUri: callbackUrl(ctx, provider),
  });
}

/**
 * POST /api/oauth/:provider/app — set the BYO-app credentials. Body: { clientId, clientSecret? }.
 * setProviderApp seals the secret in the vault (row holds only a secret_ref) and enforces the client
 * type (secret REQUIRED for confidential / REJECTED for public) → ConfigError (400) on violation.
 */
export async function oauthAppSet(ctx: RouteContext): Promise<void> {
  const provider = requireProvider(ctx.params.provider);
  const body = (await readJson(ctx.req)) as { clientId?: unknown; clientSecret?: unknown };
  if (typeof body.clientId !== "string") throw new ValidationError("clientId is required");
  if (body.clientSecret !== undefined && typeof body.clientSecret !== "string") {
    throw new ValidationError("clientSecret must be a string");
  }
  await setProviderApp(provider, body.clientId, body.clientSecret ?? null);
  sendJson(ctx.res, 200, { ok: true });
}

/**
 * DELETE /api/oauth/:provider/app — clear a configured BYO app (#20). Removes the
 * `oauth_provider_apps` row and best-effort-retires its sealed `client_secret_ref` from the vault
 * (a public client has none → NULL ref → nothing to retire). The DELETE … RETURNING reads the ref
 * atomically with the row removal; the vault-hygiene step never fails the request (the row is already
 * gone, so a lingering sealed blob is harmless — it can never be re-referenced). Parameterized;
 * localOnly (Host-allowlisted, like the GET/POST peers). Idempotent: a missing row still returns ok.
 * A subsequent GET …/app reports `configured: false`.
 */
export async function oauthAppDelete(ctx: RouteContext): Promise<void> {
  const provider = requireProvider(ctx.params.provider);
  const res = await pool.query(
    `delete from oauth_provider_apps where provider = $1 returning client_secret_ref`,
    [provider],
  );
  const ref = (res.rows[0]?.client_secret_ref ?? null) as string | null;
  if (ref) {
    try {
      await deleteSecret(ref);
    } catch {
      // best-effort vault hygiene: the row is already removed, so a leftover sealed blob is inert.
    }
  }
  sendJson(ctx.res, 200, { ok: true });
}

/**
 * GET /api/oauth/:provider/callback?code=&state= — finish consent. Consumes the state one-shot,
 * exchanges the code, seals both tokens, persists the first-party credential, auto-creates one
 * connector per covered sector (pausing uncovered siblings), and 302-redirects to the Console
 * success page. No token ever reaches the browser.
 */
export async function oauthCallback(ctx: RouteContext): Promise<void> {
  const provider = requireProvider(ctx.params.provider);

  // The provider may bounce back with an error instead of a code (user denied, app misconfigured).
  // Surface that code to the Console (self-diagnosis) rather than dead-ending on a 400.
  const providerError = ctx.query.get("error");
  if (providerError) {
    ctx.res.writeHead(302, { location: errorLocation(provider, providerError) });
    ctx.res.end();
    return;
  }

  const code = ctx.query.get("code");
  const state = ctx.query.get("state");
  if (!code || !state) throw new ValidationError("missing code or state");

  const pending = takePending(state); // one-shot; null = unknown/expired/replayed -> 400
  if (!pending || pending.provider !== provider) {
    throw new ValidationError("invalid or expired state");
  }

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(provider, code, pending.verifier, pending.redirectUri);
  } catch (err) {
    // A token-endpoint failure (bad secret, expired grant, AADSTS misconfig) is self-inflicted by a
    // registration mistake — redirect with the surfaced (non-token-bearing) code so the Console can
    // show it. Other errors (ConfigError, etc.) propagate to the status map.
    if (err instanceof TokenEndpointError) {
      ctx.res.writeHead(302, { location: errorLocation(provider, err.code ?? `http_${err.status}`) });
      ctx.res.end();
      return;
    }
    throw err;
  }

  // Seal access at purpose 'access' (uniform with static-token onboarding) and refresh at 'refresh'.
  const secretRef = await seal(
    { userId: LOCAL_USER_ID, provider, purpose: "access" },
    tokens.accessToken,
  );
  let refreshRef: string | null = null;
  if (tokens.refreshToken) {
    refreshRef = await seal(
      { userId: LOCAL_USER_ID, provider, purpose: "refresh" },
      tokens.refreshToken,
    );
  }

  const expiresAt =
    tokens.expiresInSec != null ? new Date(Date.now() + tokens.expiresInSec * 1000) : null;
  // An ABSENT scope field means granted == requested (RFC 6749 §5.1) — null routes
  // sectorsForScopes to the requested-scope fallback; the column still stores [].
  const granted = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : null;
  const grantedScopes = granted ?? [];

  const credRes = await pool.query(
    // `where external_item_id is null` infers the (user_id, provider) PARTIAL unique index that
    // migration 0007 substituted for the old table-level unique (Plaid is now per-Item keyed). OAuth
    // providers leave external_item_id NULL, so this is the same one-row-per-(user, provider) upsert.
    `insert into provider_credentials
       (user_id, provider, custody, secret_ref, refresh_ref, granted_scopes, status, expires_at)
     values ($1, $2, 'first_party', $3, $4, $5, 'active', $6)
     on conflict (user_id, provider) where external_item_id is null do update set
       custody        = 'first_party',
       secret_ref     = excluded.secret_ref,
       refresh_ref    = excluded.refresh_ref,
       granted_scopes = excluded.granted_scopes,
       status         = 'active',
       expires_at     = excluded.expires_at
     returning id`,
    [LOCAL_USER_ID, provider, secretRef, refreshRef, grantedScopes, expiresAt],
  );
  const credentialId = credRes.rows[0].id as string;

  // Auto-create one connector per covered sector — one consent = a fully connected provider.
  // Verbatim duplicate of the create-connector route's SQL (deliberate — this unit doesn't own
  // admin.ts). Re-consent reactivating a paused/error/revoked connector is intended: a fresh
  // consent supersedes revocation, same as the token re-paste precedent.
  const sectors = sectorsForScopes(provider, granted);
  for (const sector of sectors) {
    await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, $3, $4, 'active')
       on conflict (credential_id, sector) do update set status = 'active'`,
      [LOCAL_USER_ID, credentialId, sector, provider],
    );
  }
  // Pause uncovered siblings — a scope-reduced re-consent must not leave the gateway advertising
  // more than the source grant.
  await pool.query(
    `update connectors set status = 'paused' where credential_id = $1 and not (sector = any($2))`,
    [credentialId, sectors],
  );

  // Redirect to the Console success page (+ credential_id & provider) — tokens never in the response.
  ctx.res.writeHead(302, { location: successLocation(credentialId, provider) });
  ctx.res.end();
}

// Re-export for the index wiring + tests.
export { startPkce, takePending };
