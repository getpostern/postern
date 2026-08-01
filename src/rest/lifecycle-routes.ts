// Lifecycle + status REST handlers (wave 10A) — the operator-local-trusted control plane over a
// connection's liveness and a credential's validity. Every handler acts as the seeded local operator
// (resolveLocal) and is wired behind `localOnly` (the loopback Host-allowlist) by the composition
// root in src/rest/index.ts — the mother re-points GET /api/connectors at listConnectorsEnriched and
// adds the four routes below at merge. Plain handlers (the admin.ts pattern); the router wraps them.
//
// Error mapping: a ConflictError (wrong connector state) → 409 here; NotFoundError (404) /
// ValidationError (400) propagate to the edge's errorToStatus. Secrets are never returned or logged.

import { sendJson, ValidationError, type RouteContext } from "./router.js";
import { resolveLocal } from "../auth/resolve.js";
import {
  pauseConnection,
  resumeConnection,
  revokeCredential,
  syncNowConnection,
  listConnectorsEnriched,
  getConnectionDetail,
  setSyncWindow,
  setSyncInterval,
  ConflictError,
} from "../core/lifecycle.js";

/**
 * Run a lifecycle op and send `status` with its result, mapping a ConflictError (wrong connector
 * state) to 409. Other typed errors (NotFoundError → 404, ValidationError → 400) propagate to the
 * edge dispatcher's errorToStatus so internal detail never leaks.
 */
async function run<T>(ctx: RouteContext, status: number, fn: () => Promise<T>): Promise<void> {
  try {
    sendJson(ctx.res, status, await fn());
  } catch (e) {
    if (e instanceof ConflictError) {
      sendJson(ctx.res, 409, { error: e.message });
      return;
    }
    throw e;
  }
}

/** GET /api/connectors — the enriched connector list (the mother re-points the existing route here). */
export async function listConnectorsEnrichedRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  sendJson(ctx.res, 200, await listConnectorsEnriched(auth));
}

/** GET /api/connectors/:connectionId — one connection's enriched status + per-table live-row counts. */
export async function connectionDetailRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  sendJson(ctx.res, 200, await getConnectionDetail(auth, ctx.params.connectionId));
}

/** POST /api/connectors/:connectionId/pause — active|error → paused (push: best-effort stop). */
export async function pauseRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  await run(ctx, 200, () => pauseConnection(auth, ctx.params.connectionId));
}

/** POST /api/connectors/:connectionId/resume — paused → active (409 if not paused). */
export async function resumeRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  await run(ctx, 200, () => resumeConnection(auth, ctx.params.connectionId));
}

/** POST /api/connectors/:connectionId/sync — operator sync-now (poll/on_demand pull; push: no-op). */
export async function syncNowRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  await run(ctx, 200, () => syncNowConnection(auth, ctx.params.connectionId));
}

/** POST /api/credentials/:credentialId/revoke — revoke the credential + all its connectors. */
export async function revokeCredentialRoute(ctx: RouteContext): Promise<void> {
  const auth = await resolveLocal();
  await run(ctx, 200, () => revokeCredential(auth, ctx.params.credentialId));
}

/**
 * POST /api/connectors/:connectionId/sync-window — set the per-connection recency window (wave 12a).
 * Body { days: number | null }: an integer in [7, 36500], or null for all-history. A missing/wrong-typed
 * body or out-of-range value is a typed 400 (the core validates the range; here we guard the body shape).
 * Returns { ok: true }. localOnly (loopback-trusted, like the other lifecycle verbs).
 */
export async function setSyncWindowRoute(ctx: RouteContext, body: unknown): Promise<void> {
  const auth = await resolveLocal();
  if (body == null || typeof body !== "object" || Array.isArray(body) || !("days" in body)) {
    throw new ValidationError("body must be an object with a 'days' field (number or null)");
  }
  const days = (body as { days: unknown }).days;
  if (days !== null && typeof days !== "number") {
    throw new ValidationError("days must be a number or null");
  }
  await setSyncWindow(auth, ctx.params.connectionId, days);
  sendJson(ctx.res, 200, { ok: true });
}

/**
 * POST /api/connectors/:connectionId/sync-interval — set the per-connection poll cadence (ADR 0025).
 * STRICT body { interval_sec: number | null } — an unknown extra key is a 400, never silently ignored
 * (#1/#2). null resets to the connector default; the core validates the floor/14-day bound (typed
 * 400) and the poll-only rule (409 via `run`). Returns { ok: true }. localOnly, like the other verbs.
 */
export async function setSyncIntervalRoute(ctx: RouteContext, body: unknown): Promise<void> {
  const auth = await resolveLocal();
  if (body == null || typeof body !== "object" || Array.isArray(body) || !("interval_sec" in body)) {
    throw new ValidationError("body must be an object with an 'interval_sec' field (number or null)");
  }
  const extra = Object.keys(body).filter((k) => k !== "interval_sec");
  if (extra.length > 0) {
    throw new ValidationError(`unknown body field(s): ${extra.join(", ")} (only 'interval_sec')`);
  }
  const intervalSec = (body as { interval_sec: unknown }).interval_sec;
  if (intervalSec !== null && typeof intervalSec !== "number") {
    throw new ValidationError("interval_sec must be a number or null");
  }
  await run(ctx, 200, async () => {
    await setSyncInterval(auth, ctx.params.connectionId, intervalSec);
    return { ok: true };
  });
}
