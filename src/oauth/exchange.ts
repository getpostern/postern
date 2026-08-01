// Authorization-code exchange + refresh — the two POSTs to a provider's token endpoint.
//
// exchangeCode trades the code (+ the PKCE verifier) for tokens; refreshToken trades a stored
// refresh token for a fresh access token. Per-provider client type (ADR 0014):
//   - microsoft = PUBLIC: code_verifier only, NO client_secret.
//   - google / whoop = CONFIDENTIAL: append client_secret (the secret is the proof; WHOOP ignores
//     PKCE entirely). WHOOP refresh ALSO requires `scope=offline`.
//
// Tokens are returned to the caller (admin/oauth handler) which seals them immediately. They are
// NEVER logged here. On a non-2xx we parse the provider's OAuth error response — which by RFC 6749
// §5.2 carries NO token material (only error / error_description / error_uri) — and surface the
// non-token-bearing code + description so a misconfiguration is self-diagnosable, never echoing the
// raw body (which on a 2xx path would carry tokens).

import { providerConfig, type OAuthProvider } from "./providers.js";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  scope?: string;
}

/** Provider token-endpoint JSON shape (snake_case). Only the fields we map are typed. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * A non-2xx (or in-band error) from a token endpoint. Carries the provider's NON-token-bearing
 * error code (e.g. `invalid_client`, `invalid_grant`, or an `AADSTS####`) + description so the
 * onboarding path can surface it; the message is built from those safe fields only. NEVER carries
 * the raw response body.
 */
export class TokenEndpointError extends Error {
  override name = "TokenEndpointError";
  constructor(
    public status: number,
    /** The provider's short error code (RFC 6749 / AADSTS), when present. */
    public code: string | null,
    /** The provider's human error description, when present (non-token-bearing). */
    public description: string | null,
  ) {
    super(
      `token endpoint returned ${status}${code ? `: ${code}` : ""}${
        description ? ` (${description})` : ""
      }`,
    );
  }
}

/** AADSTS codes ride inside Microsoft's error_description; pull the first one out for the redirect. */
function aadstsCode(description: string | null): string | null {
  if (!description) return null;
  const m = /AADSTS\d+/.exec(description);
  return m ? m[0] : null;
}

/** Best-effort parse of an OAuth error response into {code, description} (no token material). */
function parseError(body: string): { code: string | null; description: string | null } {
  try {
    const json = JSON.parse(body) as TokenResponse;
    const description = json.error_description ?? null;
    const code = json.error ?? aadstsCode(description);
    return { code, description };
  } catch {
    return { code: null, description: null };
  }
}

/** POST an x-www-form-urlencoded body to the token endpoint and map the response to a TokenSet. */
async function postToken(tokenUrl: string, body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    // An OAuth error response (RFC 6749 §5.2) carries error / error_description — NO tokens. Surface
    // those non-token-bearing fields; NEVER echo the raw body verbatim.
    const { code, description } = parseError(await res.text().catch(() => ""));
    throw new TokenEndpointError(res.status, code, description);
  }

  const json = (await res.json()) as TokenResponse;
  if (json.error || !json.access_token) {
    // Some providers return 200 with an in-band error; treat it the same (still no token present).
    throw new TokenEndpointError(res.status, json.error ?? "no_access_token", json.error_description ?? null);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSec: json.expires_in,
    scope: json.scope,
  };
}

/**
 * Exchange an authorization code for tokens. Always sends the PKCE code_verifier; additionally sends
 * client_secret for CONFIDENTIAL providers (google/whoop) — NEVER for the public microsoft client.
 */
export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenSet> {
  const cfg = await providerConfig(provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  if (cfg.confidential && cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  return postToken(cfg.token, body);
}

/**
 * Trade a refresh token for a fresh access token. Sends client_secret for CONFIDENTIAL providers
 * (never for microsoft) and `scope=offline` for WHOOP (its refresh requires the offline scope to
 * keep a usable refresh token).
 */
export async function refreshToken(provider: OAuthProvider, refreshToken: string): Promise<TokenSet> {
  const cfg = await providerConfig(provider);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.confidential && cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  if (provider === "whoop") body.set("scope", "offline");
  return postToken(cfg.token, body);
}
