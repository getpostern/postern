// Plaid connection health (wave 13, sub-unit B, ADR 0020).
//
// A broken Item makes /transactions/sync go QUIET — empty added/modified/removed arrays, has_more=false,
// no thrown error — which is indistinguishable from "no new transactions". So `last_synced_at` keeps
// advancing and the cache rots invisibly. The /item/get poll is the fix: it surfaces the Item's
// error_code + consent_expiration_time + update_type, which a small state machine classifies into a
// per-connection health state the Console + describe_context expose, and which drives the re-link prompt.
//
// classifyItemError is PURE (DB-free, network-free) so it is exhaustively unit-tested. pollItemHealth
// performs the /item/get read (in connectors/plaid.ts) and classifies the result; it never throws and
// never logs/echoes the access token.

import { itemGet } from "../connectors/plaid.js";

/** The four-state health machine. `dead` doubles as "terminal / stop retrying" (e.g. a 429 hard quota). */
export type HealthStatus = "ok" | "action_required" | "transient" | "dead";

export interface ItemHealth {
  status: HealthStatus;
  errorCode: string | null;
  consentExpiresAt: string | null;
  updateType: string | null;
}

// ── Error-code buckets (Plaid error_code enums; first-hand-verified, ADR 0020) ──────────────────────

/** Re-link required — the operator must re-consent (login expired / access pulled / consent expiring). */
const ACTION_REQUIRED = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "ACCESS_NOT_GRANTED",
  "USER_PERMISSION_REVOKED",
  "PENDING_EXPIRATION", // consent expiring soon (also pollable via consent_expiration_time)
  "PENDING_DISCONNECT",
]);

/**
 * Transient — back off and retry; the Item is fine. Institution-side outages PLUS `RATE_LIMIT_EXCEEDED`:
 * a rate limit is a temporary throttle that clears on its own (NOT a hard, terminal quota), so it must
 * stay retryable — backing off and retrying is exactly the right response.
 */
const TRANSIENT = new Set<string>([
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_REGISTRATION_REQUIRED",
  "RATE_LIMIT_EXCEEDED", // a temporary throttle — back off and retry, never give up on the Item
]);

/** Dead — a fresh Link is needed (the Item/institution is gone), not a re-consent. */
const DEAD = new Set<string>([
  "ITEM_NOT_FOUND",
  "ITEM_NO_LONGER_SUPPORTED",
  "INSTITUTION_NO_LONGER_SUPPORTED",
]);

/**
 * The TERMINAL Plaid Trial/billing quotas — a hard wall that backoff cannot clear (the team's Item cap
 * is hit / its credits are spent), so retrying forever is futile. Mapped to `dead` (the representable
 * "stop retrying" state in the 4-state machine). NOT `RATE_LIMIT_EXCEEDED` — that is a transient throttle
 * (above), retryable with backoff; only TRIAL_CONNECTION_LIMIT + CREDITS_EXHAUSTED are terminal.
 */
const TERMINAL_QUOTA = new Set<string>(["TRIAL_CONNECTION_LIMIT", "CREDITS_EXHAUSTED"]);

/** Consent within this window of expiring → action_required (the pollable re-consent deadline). */
const CONSENT_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Classify an /item/get outcome into a health state. PURE — no I/O. An error_code wins (terminal-quota
 * → dead; then action/transient/dead buckets; an UNKNOWN code is treated conservatively as
 * action_required so a real break is never silently read as healthy). With no error_code, a
 * soon-to-expire consent clock is action_required; otherwise the Item is ok.
 */
export function classifyItemError(errorCode: string | null, consentExpiresAt: string | null): HealthStatus {
  if (errorCode) {
    if (TERMINAL_QUOTA.has(errorCode)) return "dead"; // terminal Trial/billing quota (RATE_LIMIT_EXCEEDED is transient)
    if (ACTION_REQUIRED.has(errorCode)) return "action_required";
    if (TRANSIENT.has(errorCode)) return "transient";
    if (DEAD.has(errorCode)) return "dead";
    return "action_required"; // unknown code → prompt re-link rather than feign health
  }
  if (consentExpiresAt) {
    const t = Date.parse(consentExpiresAt);
    if (!Number.isNaN(t) && t - Date.now() < CONSENT_SOON_MS) return "action_required";
  }
  return "ok";
}

/**
 * Poll one Item's connection health. /item/get → classify. Total (never throws): a network failure is
 * reported as `transient` (reachable-later), not a crash. The access token is never logged or returned.
 *
 * This is the STANDALONE public health API (a one-shot health read on demand); the connector's sync()
 * does NOT call it — sync() reuses the SAME `itemGet` read it already makes for institution enrichment,
 * classifying + persisting health from that combined call (see connectors/plaid.ts) to avoid a second
 * /item/get round-trip per cycle.
 */
export async function pollItemHealth(accessToken: string): Promise<ItemHealth> {
  let info;
  try {
    info = await itemGet(accessToken);
  } catch {
    // No response (network) — treat as transient; never leak the token.
    return { status: "transient", errorCode: null, consentExpiresAt: null, updateType: null };
  }
  return {
    status: classifyItemError(info.errorCode, info.consentExpirationTime),
    errorCode: info.errorCode,
    consentExpiresAt: info.consentExpirationTime,
    updateType: info.updateType,
  };
}
