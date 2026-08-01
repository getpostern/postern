// Public-exposure routes (console-exposure-surface, ADR 0035 §D1/§D2/§D6/§D9) — the Console's own
// surface for "make my gateway reachable from claude.ai", replacing an SSH + .env + restart ritual.
//
//   GET    /api/exposure  -> ExposureStatus: what the next boot will serve, what THIS process is
//                            serving, whether they disagree, the local MCP endpoint, and the exact
//                            set of routes a whole-port Funnel publishes.
//   POST   /api/exposure  -> { publicUrl, acknowledged } — validate, record consent, store.
//   DELETE /api/exposure  -> stop publishing at the next boot (idempotent) — OR a named 409 when the
//                            box's own MCP_PUBLIC_URL is what publishes this gate (§Decision 5).
//
// ALL THREE ARE localOnly. The loopback Host allowlist is the only authz on this group (CLAUDE.md),
// and a setting that publishes the gateway to the public internet is the last one that may be
// reachable from a rebound origin. Each handler reads its own body with readJson, so they are
// registered DIRECTLY behind localOnly — never via withBody (double-reading the stream hangs).
//
// The publicUrl IS logged in full, in the audit row: it is public by construction (tailnet HTTPS puts
// the machine name in a public certificate ledger) and a redacted one would be useless.
//
// A restart is required for a change to take effect: bridgeRoutes closes over cfg.publicUrl in ten
// places, and its CSRF store and rate limiter live in that same closure. Rebuilding it per change is
// the highest-risk edit available; instead the status route is HONEST about the disagreement and the
// Console renders it. The dangerous direction is the reverse one — a user who clicks "stop
// publishing" must never believe they are private while the edge is still serving — which is why
// restartRequired is computed in BOTH directions.

import { z } from "zod";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { auditAdmin } from "../core/lifecycle.js";
import {
  BridgeConfigError,
  PUBLISHED_ROUTES,
  bridgeConfigFromEnv,
  mountedBridgeConfig,
  resolveBridgeConfig,
  validatePublicUrl,
  type BridgeProblem,
  type BridgeRouteDescriptor,
  type BridgeSource,
} from "../mcp/oauth-bridge.js";
import { getExposure, setExposure, clearExposure } from "../gateway/exposure-config.js";
import { observedAtAddress } from "../gateway/reached-at.js";
import { readJson, sendJson, ValidationError, type RouteContext } from "./router.js";

/** The frozen Console contract. Every one of the three routes responds with exactly this shape. */
export interface ExposureStatus {
  /** What the gateway will serve after the next restart. null = exposure is off. */
  configured: { publicUrl: string; source: BridgeSource; consentedAt: string | null } | null;
  /** What THIS running process mounted. null = nothing is published right now. */
  serving: { publicUrl: string } | null;
  /** configured?.publicUrl !== serving?.publicUrl — true in BOTH directions (saved-not-yet-live AND
   *  cleared-but-still-live). The Console renders a different sentence for each. */
  restartRequired: boolean;
  /** The MCP endpoint this gateway serves on the box; null when there is no MCP HTTP edge at all. */
  localEndpoint: string | null;
  publishedRoutes: BridgeRouteDescriptor[];
  problem: BridgeProblem | null;
  /**
   * Has anything actually reached this process at `configured.publicUrl` since it started? (#119)
   *
   *   null  — we cannot say: either nothing is configured, or no request has arrived at all yet.
   *   false — traffic HAS arrived, but never naming this address. The valuable answer: the problem
   *           is upstream of Postern (Funnel, MagicDNS, certificates), not in the gateway.
   *   true  — something reached us naming this address.
   *
   * OBSERVATION, NOT A REACHABILITY GUARANTEE. It is derived from inbound `Host` headers on the
   * public MCP edge, which any caller chooses (src/gateway/reached-at.ts states both failure modes).
   * Postern cannot know whether the internet can reach it — only whether something did. The Console
   * renders this field and MUST NOT compute it, and no gate anywhere may consume it.
   *
   * Deliberately NOT optional: an always-present field cannot be misread as "this gateway is too old
   * to answer". `null` is the answer for "we cannot say", and it is a real answer.
   */
  observedAtConfiguredAddress: boolean | null;
}

// `.strict()` so an unknown key is REJECTED (400) rather than silently dropped — the REST convention.
//
// `acknowledged` is DELIBERATELY typed `z.unknown()` and NOT `z.literal(true)`. The literal-true test
// lives ONLY in the explicit check in setExposureRoute, so that check is the single mutable
// enforcement point. Split across two places, relaxing the explicit check could not produce a failing
// test — zod would reject "yes"/1 before the check was reached, and the guard would pass while the
// defect it exists to catch was fully present.
const exposureBody = z
  .object({
    publicUrl: z.string().min(1).max(2000),
    acknowledged: z.unknown(),
  })
  .strict();

/**
 * The local MCP endpoint, derived at request time from MCP_HTTP_PORT.
 *
 * MCP_HTTP_HOST is deliberately NOT used: docker-compose sets it to 0.0.0.0 inside the container while
 * publishing 127.0.0.1:8788:8788 on the host, so the bind host says nothing about what a browser can
 * reach. The port does, and the shipped compose publishes it 1:1. Null when the MCP edge is not
 * configured — there is then no local MCP endpoint at all, and inventing one is a flat lie.
 */
export function localMcpEndpoint(): string | null {
  const p = Number(process.env.MCP_HTTP_PORT);
  return Number.isInteger(p) && p > 0 ? `http://localhost:${p}/mcp` : null;
}

/**
 * Build the uniform response. `serving` comes from what the process actually MOUNTED — never derived
 * from `configured`, which is the whole point of the honesty contract.
 */
async function buildStatus(): Promise<ExposureStatus> {
  const resolved = await resolveBridgeConfig();

  // The consent timestamp is only meaningful for a stored row; the env fallback has none. A second
  // read rather than a wider ResolvedBridge: the resolution contract is frozen, and this is a loopback
  // single-operator setting read on demand, not a hot path.
  let consentedAt: string | null = null;
  if (resolved.source === "db" && resolved.cfg) {
    try {
      const row = await getExposure();
      consentedAt = row ? row.consentedAt.toISOString() : null;
    } catch {
      consentedAt = null; // the address resolved; only its timestamp is unavailable
    }
  }

  const configured = resolved.cfg
    ? { publicUrl: resolved.cfg.publicUrl, source: resolved.source as BridgeSource, consentedAt }
    : null;
  const mounted = mountedBridgeConfig();
  const serving = mounted ? { publicUrl: mounted.publicUrl } : null;

  return {
    configured,
    serving,
    restartRequired: configured?.publicUrl !== serving?.publicUrl,
    localEndpoint: localMcpEndpoint(),
    publishedRoutes: [...PUBLISHED_ROUTES],
    problem: resolved.problem,
    // Asked about the CONFIGURED address — the one the user typed and wants confirmed — never about
    // `serving`. When the two disagree the honest answer is that nothing has reached the new address
    // yet, and `restartRequired` is the field that explains why.
    //
    // The direction is the security property: the trusted, already-validated configured address is
    // looked up IN the untrusted observation set. Nothing flows the other way — an observed host
    // never becomes `configured`, never reaches validatePublicUrl, never widens any check.
    observedAtConfiguredAddress: observedAtAddress(configured?.publicUrl ?? null),
  };
}

/** GET /api/exposure — the honest status: configured vs serving, and what publishing exposes. */
export async function getExposureRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, await buildStatus());
}

/**
 * POST /api/exposure { publicUrl, acknowledged } — publish this gate at the next restart.
 *
 * Validation order is load-bearing (each step named so the operator can act on the refusal):
 *   1. body shape                    → 400 (zod, unknown keys rejected)
 *   2. acknowledged === true         → 400. Consent is enforced SERVER-SIDE so a Console bug cannot
 *                                      skip it. Strict identity, not truthiness: "yes" and 1 are not
 *                                      consent.
 *   3. validatePublicUrl             → 400 carrying the validator's own message (the same validator
 *                                      boot uses, so a value accepted here can always be booted with)
 *   4. MCP_HTTP_PORT present + valid → 400. This is the check that used to refuse BOOT; applied to a
 *                                      Console value that would be a button that bricks the gateway
 *                                      (the #97 shape), so it moved to the click, where it is legible.
 *   5. setExposure
 */
export async function setExposureRoute(ctx: RouteContext): Promise<void> {
  const raw = await readJson(ctx.req);
  const parsed = exposureBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("invalid request body: publicUrl (string) and acknowledged required");
  }

  // THE consent gate. One place, strict `=== true`.
  if (parsed.data.acknowledged !== true) {
    throw new ValidationError(
      "publishing this gate requires acknowledged: true — the consequences must be accepted before " +
        "the gateway is published to the public internet",
    );
  }

  let publicUrl: string;
  try {
    publicUrl = validatePublicUrl(parsed.data.publicUrl).publicUrl;
  } catch (e) {
    if (e instanceof BridgeConfigError) throw new ValidationError(e.message);
    throw e;
  }

  if (localMcpEndpoint() === null) {
    throw new ValidationError(
      "there is no MCP endpoint on this gateway to publish — set MCP_HTTP_PORT first",
    );
  }


  try {
    await setExposure(publicUrl);
  } catch (e) {
    auditAdmin(LOCAL_USER_ID, "set_exposure", { publicUrl }, "error");
    throw e;
  }
  auditAdmin(LOCAL_USER_ID, "set_exposure", { publicUrl }, "ok");

  sendJson(ctx.res, 200, await buildStatus());
}

/**
 * The source that would be in effect the instant this gateway has no `gateway_exposure` row — i.e.
 * immediately after a successful DELETE. There is no row by construction at that point, so the
 * post-delete resolution IS `resolveBridgeConfig`'s env branch, and it can be evaluated here without a
 * DB round-trip. Returns null when nothing on the box would publish this gate.
 *
 * This is why the DELETE decision is taken from the RESOLVED SOURCE and never from the delete's row
 * count: `clearExposure()` is idempotent and cannot distinguish "deleted 1" from "deleted 0", so a
 * row-count answer would report success for a gateway that stays published either way.
 *
 * A set-but-UNUSABLE MCP_PUBLIC_URL (BridgeConfigError) yields null deliberately: nothing publishes
 * from it, so clearing the row does achieve what the caller asked for and must not be refused.
 */
function publishedByEnvAfterClear(): { source: BridgeSource; publicUrl: string } | null {
  try {
    const cfg = bridgeConfigFromEnv();
    return cfg ? { source: "env", publicUrl: cfg.publicUrl } : null;
  } catch {
    return null;
  }
}

/**
 * DELETE /api/exposure — stop publishing at the next restart (idempotent), or refuse.
 *
 * §Decision 5 (operator ruling, 2026-07-26). Exposure has TWO storage states (row / no row) but the
 * product needs THREE — published by the Console, explicitly off, and defer to env. Because "no row"
 * means "fall back to MCP_PUBLIC_URL", there is no way to express OFF on a box whose env var is set —
 * and that is what prod is. Deleting a row there removes nothing, env still wins, and reporting 200
 * with `outcome: "ok"` tells the operator they stopped publishing when nothing stopped, and nothing
 * stops after a restart either. So: **a 409 that names the variable and the escape**, never a
 * success-reporting no-op. An explicit-off row was considered and rejected for this wave (a schema
 * change plus a precedence rewrite immediately before beta).
 *
 * The audit row records the REFUSAL, not `outcome: "ok"` — and stays async/detective, fire-and-forget
 * off the response path (CLAUDE.md). Audit is never the thing doing the refusing.
 *
 * On the success path the response still reports `serving` truthfully: until the gateway restarts the
 * edge IS still published, and saying otherwise is the one dishonesty with a real safety cost.
 */
export async function clearExposureRoute(ctx: RouteContext): Promise<void> {
  const envSourced = publishedByEnvAfterClear();
  if (envSourced) {
    auditAdmin(
      LOCAL_USER_ID,
      "clear_exposure",
      { refused: "env_sourced", publicUrl: envSourced.publicUrl },
      "error",
    );
    sendJson(ctx.res, 409, {
      error:
        `this gate is published by MCP_PUBLIC_URL in the box's own .env (${envSourced.publicUrl}), ` +
        "not by this setting, so the Console cannot stop it: with the row gone the environment " +
        "variable would simply win again. Remove MCP_PUBLIC_URL from the box's .env and restart the " +
        "gateway to hand control of the public address to the Console.",
    });
    return;
  }

  try {
    await clearExposure();
  } catch (e) {
    auditAdmin(LOCAL_USER_ID, "clear_exposure", {}, "error");
    throw e;
  }
  auditAdmin(LOCAL_USER_ID, "clear_exposure", {}, "ok");

  sendJson(ctx.res, 200, await buildStatus());
}
