// PKCE (RFC 7636) + CSRF state for the first-party authorization-code flow.
//
// startPkce builds the authorization URL (S256 challenge) and stashes {verifier,state,provider,
// redirectUri} in an in-memory pending map under a short TTL. takePending is ONE-SHOT: it consumes
// the state (deletes it on read), so a state can satisfy exactly one callback — a replayed or
// forged `state` finds nothing and the callback rejects. This is the CSRF defense for the loopback
// redirect. (In-memory only: a process restart mid-consent loses pending state — the user re-
// initiates. Acceptable for V0 per the spec's open question.)

import { createHash, randomBytes } from "node:crypto";
import { envProviderConfig, type OAuthProvider, type ProviderConfig } from "./providers.js";

/** How long a pending authorization may sit before the user must re-initiate. */
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface Pending {
  provider: OAuthProvider;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

// state -> pending. In-memory by design (single-process self-host). Never logged.
const pending = new Map<string, Pending>();

/** base64url with no padding — the encoding both the verifier and the S256 challenge use. */
function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** RFC 7636 S256: challenge = base64url(sha256(verifier)). */
function challengeOf(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Drop any expired pending entries (called opportunistically; the map stays small). */
function sweep(now: number): void {
  for (const [state, p] of pending) {
    if (p.expiresAt <= now) pending.delete(state);
  }
}

/**
 * Begin an authorization-code-with-PKCE flow. Generates a high-entropy verifier + state, stores the
 * pending tuple, and returns the authorization URL to open plus the state. The URL carries the
 * client_id, the redirect_uri, the requested scopes, the S256 code_challenge, and the state.
 *
 * `cfg` is the resolved provider config (table-first), threaded in by the async route after it has
 * awaited providerConfig. When omitted (DB-free callers/tests) it falls back to the synchronous
 * ENV-only resolution — the only path that doesn't consult the oauth_provider_apps table.
 */
export function startPkce(
  provider: OAuthProvider,
  redirectUri: string,
  cfg?: ProviderConfig,
): { authorizationUrl: string; state: string } {
  const config = cfg ?? envProviderConfig(provider); // throws if the provider is unconfigured
  const now = Date.now();
  sweep(now);

  const verifier = base64url(randomBytes(32)); // 43-char high-entropy verifier
  const state = base64url(randomBytes(32)); // CSRF token, one-shot
  const challenge = challengeOf(verifier);

  pending.set(state, {
    provider,
    verifier,
    redirectUri,
    expiresAt: now + PENDING_TTL_MS,
  });

  const url = new URL(config.auth);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Google ONLY: ask for a refresh token + a fresh consent. These params are Google-specific —
  // microsoft drives refresh off the `offline_access` SCOPE (access_type is inert there) and whoop
  // off `scope=offline`; sending them elsewhere is at best noise, at worst a rejected authorize.
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }

  return { authorizationUrl: url.toString(), state };
}

/**
 * One-shot consume of a pending authorization by its state. Returns null when the state is unknown
 * or expired (the callback then 400s). Deleting on read makes state single-use → CSRF-safe.
 */
export function takePending(
  state: string,
): { provider: OAuthProvider; verifier: string; redirectUri: string } | null {
  const p = pending.get(state);
  if (!p) return null;
  pending.delete(state); // one-shot: consumed regardless of expiry outcome
  if (p.expiresAt <= Date.now()) return null;
  return { provider: p.provider, verifier: p.verifier, redirectUri: p.redirectUri };
}
