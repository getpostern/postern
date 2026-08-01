// The consent RETURN — what Sources does with `?credential_id=…&provider=…` (#96 §1.5).
//
// The gateway 302s a completed consent to `/sources` carrying the ids it created (never a token —
// src/rest/oauth-routes.ts successLocation). Until 2026-07-25 it 302'd to a deleted `/connections`
// route and nothing in the Console read either param, so a consent that HAD created the credential
// landed on "— not found". Everything here is pure so the announcement is unit-testable.

import { providerDisplay } from "./model";

export interface OauthReturn {
  credentialId: string;
  provider: string;
}

/** Read the consent-return params the gateway appends (src/rest/oauth-routes.ts successLocation).
 *  Both must be present — a half-set of params is not a return and must not announce anything. */
export function readOauthReturn(params: URLSearchParams): OauthReturn | null {
  const credentialId = params.get("credential_id");
  const provider = params.get("provider");
  if (!credentialId || !provider) return null;
  return { credentialId, provider };
}

/** The same params minus `credential_id` + `provider`, every other key preserved in order. */
export function withoutOauthReturn(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("credential_id");
  next.delete("provider");
  return next;
}

/** Oxford-free list join — 1 → `Mail`; 2 → `Mail and Calendar`; 3+ → `Mail, Calendar and Contacts`.
 *  A local copy of ConnectionDetail's private `joinList`: exporting a page-private helper across
 *  modules to save five lines would make that page a de-facto library. */
function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The toast a returning consent earns.
 *
 * `sectorLabels` are the sectors the gateway ACTUALLY activated for this credential, read off the
 * served connector list. **Zero is a real outcome, not an error to hide**: a consent whose granted
 * scopes map to no sector creates zero connector rows and still 302s successfully
 * (`sectorsForScopes`, src/rest/oauth-routes.ts:72; the case is pinned by
 * "unknown-scopes-only → ZERO connector rows, redirect still succeeds" in src/rest/admin.db.test.ts).
 * Saying "connected" over zero sectors is the same lie as the success-toast-over-a-failed-sync (§4).
 */
export function oauthReturnToast(
  provider: string,
  sectorLabels: string[],
): { tone: "ok" | "error"; message: string } {
  const name = providerDisplay(provider);
  if (sectorLabels.length === 0) {
    return {
      tone: "error",
      message: `${name} signed in, but granted no sectors. Check the scopes on your app, then sign in again.`,
    };
  }
  return { tone: "ok", message: `${name} connected — ${joinList(sectorLabels)}.` };
}
