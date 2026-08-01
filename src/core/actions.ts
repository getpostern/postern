/**
 * The write surface — parallel to the read primitives, and the reason this is a *gateway*, not a
 * store: whatever the connected credential can do, an agent can do through us (no regression vs a
 * direct connection), plus portability and an audit trail.
 *
 * Permission is DOMAIN-LEVEL: the same `agent_grants.sectors` grant that gates reads gates actions —
 * a granted sector covers read AND act, with no finer per-action/tier/confirmation gating. The grant
 * is resolved once per session into an in-memory set, so the check adds no latency. Audit is ASYNC
 * (off the response hot path); it is detective, not preventive — and is wired at the EDGE, not here.
 *
 * Action speed (the mantra): discovery is served from the cache + static catalog (ms), never a live
 * poll — only the single dispatch is live. invoke_action accepts a deterministic structured selector
 * (area/domain/name) resolved against the cache server-side — "the kitchen light" is one call, no LLM.
 */

import type { AuthContext } from "../auth/index.js";
import { assertSector, ALL_SECTORS } from "../auth/index.js";
import type { ActionSpec, ActionResult, ActionContext } from "../connectors/types.js";
import { getConnector } from "../sync/index.js";
import { QueryValidationError } from "./query.js";
import { pool } from "../db.js";
import { open } from "../secrets/index.js";

/**
 * Narrowing for the dynamic catalog. area/domain/entityId are passed through VERBATIM to
 * connector.listActions (src/connectors/types.ts) — the connector owns their meaning (HA joins them
 * against the cached entity×service catalog). `limit` is a CORE concern and never reaches a
 * connector: a real HA install yields 75-200 specs with full param lists, and shipping the whole
 * catalog to turn on one light is the defect this closes.
 */
export interface ActionFilter {
  area?: string;
  domain?: string;
  entityId?: string;
  /** Cap on returned specs. Default ACTION_LIMIT_DEFAULT, hard cap ACTION_LIMIT_MAX. */
  limit?: number;
}

/**
 * The action catalog. NOT a bare array: an array that was silently trimmed is the same lie as a
 * capped query page reporting itself complete — `truncated` is the honest signal, and the answer to
 * it is a narrower filter, not a bigger limit.
 */
export interface ActionCatalog {
  actions: ActionSpec[];
  /** actions.length — items in THIS response, never a total. */
  count: number;
  /** true when the cap trimmed the catalog: narrow with area/domain/entityId. */
  truncated: boolean;
}

/** Mirrors query()'s default/max so the whole agent surface has ONE cap rule to remember. */
export const ACTION_LIMIT_DEFAULT = 100;
export const ACTION_LIMIT_MAX = 500;

/** The active connection backing a sector for this user: which connector + its credential ref. */
interface SectorConnection {
  connectionId: string;
  provider: string;
  secretRef: string | null;
  userId: string;
}

/**
 * Resolve the active connection for a sector, scoped to ctx.userId. Returns null when the user has
 * no active connector in that sector (the caller surfaces "no connection"). Picks the most recently
 * created when several exist.
 */
async function activeConnection(userId: string, sector: string): Promise<SectorConnection | null> {
  const res = await pool.query(
    `select c.id, c.provider, pc.secret_ref
       from connectors c
       join provider_credentials pc on pc.id = c.credential_id
      where c.user_id = $1 and c.sector = $2 and c.status = 'active'
      order by c.created_at desc
      limit 1`,
    [userId, sector],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    connectionId: row.id as string,
    provider: row.provider as string,
    secretRef: (row.secret_ref ?? null) as string | null,
    userId,
  };
}

/** Build the connector ActionContext for a connection, resolving the token plaintext (never logged). */
async function actionContextFor(conn: SectorConnection): Promise<ActionContext> {
  const secret = conn.secretRef
    ? (await open(conn.secretRef, { userId: conn.userId, provider: conn.provider, purpose: "access" })).toString("utf8")
    : null;
  return { userId: conn.userId, connectionId: conn.connectionId, secretRef: conn.secretRef, secret };
}

/**
 * The dynamic, cache-served catalog across the caller's GRANTED sectors (or one named sector).
 * Delegates to each sector's connector `listActions` (HA: the cached entity×service join); a
 * connector without `listActions` contributes its static `actions`. Served from cache — no live call.
 *
 * `filter` narrows at the connector (area/domain/entityId) and caps in core (limit); the result is an
 * ActionCatalog so a trimmed catalog says so instead of passing itself off as the whole surface.
 */
export async function listActions(
  ctx: AuthContext,
  sector?: string,
  filter?: ActionFilter,
): Promise<ActionCatalog> {
  // Which sectors to enumerate: the named one (grant-checked) or every granted sector.
  let sectors: string[];
  if (sector) {
    assertSector(ctx, sector); // denies an ungranted sector BEFORE any work
    sectors = [sector];
  } else {
    sectors = ALL_SECTORS.filter((s) => ctx.grantedSectors.has(s));
  }

  // Validated up front (before any connection lookup) and NOT silently coerced: a Math.floor here
  // would answer a different question than the agent asked.
  if (filter?.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1)) {
    throw new QueryValidationError(`limit must be an integer >= 1 (capped at ${ACTION_LIMIT_MAX})`);
  }
  // Only the connector-meaningful keys cross the seam — `limit` is a core cap and would be ignored
  // by buildCatalog, silently vanishing.
  const connectorFilter =
    filter && (filter.area !== undefined || filter.domain !== undefined || filter.entityId !== undefined)
      ? { area: filter.area, domain: filter.domain, entityId: filter.entityId }
      : undefined;

  const out: ActionSpec[] = [];
  for (const s of sectors) {
    const conn = await activeConnection(ctx.userId, s);
    if (!conn) continue;
    const connector = getConnector(conn.provider);
    if (!connector) continue;
    if (connector.listActions) {
      const actionCtx = await actionContextFor(conn);
      out.push(...(await connector.listActions(actionCtx, connectorFilter)));
    } else {
      // Static-catalog connector: its declared actions (read-only connectors contribute none).
      // Not filtered on HA-shaped keys — those arrays are empty or tiny and carry no area/domain.
      out.push(...connector.actions);
    }
  }

  // The cap lives in CORE, not the adapter ("everything else is an adapter over core"). Truncation
  // cuts an id-sorted list, so it can drop a whole trailing domain — which is why the honest answer
  // is truncated:true plus a description that teaches domain/area, not a bigger default.
  const cap = Math.min(filter?.limit ?? ACTION_LIMIT_DEFAULT, ACTION_LIMIT_MAX);
  return { actions: out.slice(0, cap), count: Math.min(out.length, cap), truncated: out.length > cap };
}

/**
 * Dispatch ONE action. Grant-check the action's sector, resolve the active connector + its token,
 * and delegate to connector.execute(actionId, params, ctx). The connector owns selector resolution,
 * the single live dispatch (no retry), and the async targeted re-sync. Audit is the edge's job.
 */
export async function invokeAction(
  ctx: AuthContext,
  actionId: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  // actionId is sector-namespaced ("home.<domain>.<service>"); its sector gates the call.
  assertSector(ctx, actionId);
  const sector = actionId.split(".")[0];

  const conn = await activeConnection(ctx.userId, sector);
  if (!conn) return { ok: false, detail: `no active connection for sector '${sector}'` };

  const connector = getConnector(conn.provider);
  if (!connector) return { ok: false, detail: `no connector registered for ${conn.provider}` };

  const actionCtx = await actionContextFor(conn);
  return connector.execute(actionId, params, actionCtx);
}
