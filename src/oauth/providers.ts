// OAuth provider registry — BYO-app onboarding (ADR 0014).
//
// One ProviderConfig per provider: the authorization + token endpoints, the scopes WE request, and
// the operator's BYO-app credentials. Per-provider client type (verified — official docs):
//   - microsoft  = PUBLIC client (PKCE; NO client secret). signInAudience = personal+org.
//   - google     = CONFIDENTIAL in practice (register an OAuth "Desktop app"; client_id + secret).
//   - whoop      = CONFIDENTIAL-ONLY (no public type exists; the secret is the only proof — PKCE
//                  is ignored by WHOOP). Refresh additionally requires `scope=offline`.
//
// Credentials resolve TABLE-FIRST (oauth_provider_apps, configured from the Console) with an ENV
// fallback for back-compat / headless deploys. An unconfigured provider throws ConfigError (→ 400)
// so a half-configured deploy fails loud and actionably rather than minting a broken authorize URL.
//
// SCOPE DISCIPLINE (locked): google is SENSITIVE-ONLY — calendar.readonly + contacts.readonly.
// It MUST NOT request any Gmail scope: Gmail is onboarded as an IMAP app-password (static token),
// never OAuth. A test asserts no `gmail` scope ever appears in the authorization URL.

import { loadProviderApp } from "./provider-apps.js";

export type OAuthProvider = "google" | "microsoft" | "whoop";

/**
 * Provider app is not configured (no oauth_provider_apps row + no env fallback), or a secret was
 * supplied for a public client / omitted for a confidential one. Mapped to HTTP 400 in router.ts so
 * "provider not configured" / bad-credential states surface actionably (closes #15).
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface ProviderConfig {
  /** Authorization endpoint (where the consent URL points). */
  auth: string;
  /** Token endpoint (where exchangeCode / refreshToken POST). */
  token: string;
  /** The scopes our app requests. */
  scopes: string[];
  /** The operator's BYO client_id (table-first, env fallback). */
  clientId: string;
  /** Sealed-then-opened client secret; null for public clients (microsoft). */
  clientSecret: string | null;
  /** microsoft=false (public/PKCE); google=true; whoop=true (confidential — sends the secret). */
  confidential: boolean;
}

interface ProviderStatic {
  auth: string;
  token: string;
  scopes: string[];
  confidential: boolean;
  /** env var carrying the BYO client_id (back-compat fallback when no table row). */
  clientIdEnv: string;
  /** env var carrying the BYO client_secret (confidential providers only). */
  clientSecretEnv: string;
}

/**
 * Static endpoint + scope + client-type facts per provider. The `client_id`/`client_secret` are
 * resolved at call time (table-first, env fallback) so tests and deploys configure them without
 * editing code.
 *
 * google: SENSITIVE-ONLY — Calendar + Contacts read. NEVER a Gmail scope (Gmail = IMAP). CONFIDENTIAL.
 * microsoft: Mail.Read + Calendars.Read + Contacts.Read + offline_access (one consent fans out to
 *            the mail+calendar+contacts connectors — ADR 0006, second instance). PUBLIC (no secret).
 * whoop: read:* + offline (refresh). CONFIDENTIAL-ONLY.
 */
const PROVIDERS: Record<OAuthProvider, ProviderStatic> = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
    ],
    confidential: true,
    clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  microsoft: {
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Mail.Read", "Calendars.Read", "Contacts.Read", "offline_access"],
    confidential: false,
    clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
  },
  whoop: {
    auth: "https://api.prod.whoop.com/oauth/oauth2/auth",
    token: "https://api.prod.whoop.com/oauth/oauth2/token",
    scopes: ["read:recovery", "read:cycles", "read:sleep", "read:workout", "read:profile", "offline"],
    confidential: true,
    clientIdEnv: "WHOOP_OAUTH_CLIENT_ID",
    clientSecretEnv: "WHOOP_OAUTH_CLIENT_SECRET",
  },
};

export function isOAuthProvider(p: string): p is OAuthProvider {
  return p === "google" || p === "microsoft" || p === "whoop";
}

/** Does this provider require a client secret (confidential client)? Static, sync, DB-free. */
export function isConfidential(p: OAuthProvider): boolean {
  return PROVIDERS[p].confidential;
}

/** The static scopes this provider's app requests (fresh array; DB-free). */
export function providerScopes(p: OAuthProvider): string[] {
  return [...PROVIDERS[p].scopes];
}

/**
 * Resolve a provider's config TABLE-FIRST (oauth_provider_apps) with an ENV fallback. Reads + opens
 * the sealed client secret for confidential providers; public providers always carry `clientSecret:
 * null`. Throws ConfigError when no client_id can be resolved (fail-loud → 400). scopes is a fresh
 * array so callers can't mutate the registry. NEVER logs the secret.
 */
export async function providerConfig(p: OAuthProvider): Promise<ProviderConfig> {
  const def = PROVIDERS[p];
  if (!def) throw new ConfigError(`unknown oauth provider: ${p}`);

  const app = await loadProviderApp(p); // table-first; null when no row
  const clientId = app?.clientId ?? process.env[def.clientIdEnv] ?? null;
  if (!clientId) {
    throw new ConfigError(
      `oauth provider '${p}' is not configured: set its client_id in the Console (or ${def.clientIdEnv})`,
    );
  }

  let clientSecret: string | null = null;
  if (def.confidential) {
    clientSecret = app?.clientSecret ?? process.env[def.clientSecretEnv] ?? null;
  }

  return {
    auth: def.auth,
    token: def.token,
    scopes: [...def.scopes],
    clientId,
    clientSecret,
    confidential: def.confidential,
  };
}

/**
 * Synchronous ENV-ONLY resolution — the back-compat path for sync callers (startPkce's fallback when
 * no pre-resolved config is threaded in, plus DB-free unit tests). Production resolves table-first
 * via the async providerConfig and threads the result in. Throws ConfigError when env is unset.
 */
export function envProviderConfig(p: OAuthProvider): ProviderConfig {
  const def = PROVIDERS[p];
  if (!def) throw new ConfigError(`unknown oauth provider: ${p}`);
  const clientId = process.env[def.clientIdEnv];
  if (!clientId) {
    throw new ConfigError(`oauth provider '${p}' is not configured: set ${def.clientIdEnv}`);
  }
  const clientSecret = def.confidential ? (process.env[def.clientSecretEnv] ?? null) : null;
  return {
    auth: def.auth,
    token: def.token,
    scopes: [...def.scopes],
    clientId,
    clientSecret,
    confidential: def.confidential,
  };
}
