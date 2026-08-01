// The action-catalog REST mirror (#89 item 2, #58) — the ONE thing the Console could not obtain about
// the OUT-bound half of the gateway. `list_actions` was MCP-only, so every sector lens printed an
// honest "not served" where Home has a real entity×service catalog.
//
// OPERATOR-LOOPBACK, not bearer: the Console carries no agent key by construction, so this sits with
// the other operator reads (`/api/data/:sector`, `/api/finance/banks`) behind `localOnly` — the loopback
// Host-allowlist (a DNS-rebinding guard, NOT per-request auth) — and resolves via resolveLocal(). It
// adds NO agent-facing action surface: the agent's action path is still MCP list_actions/invoke_action,
// and this route dispatches nothing (read-only, cache-only, no upstream call).
//
// IT IS A MIRROR, WHICH MEANS IT PASSES CORE'S ANSWER THROUGH UNCHANGED. Core returns
// `ActionCatalog { actions, count, truncated }` and this route serves exactly that, because a bare
// array that was silently trimmed is the same lie as a capped query page reporting itself complete —
// the defect already removed from the MCP surface (src/core/actions.ts). It also means the HA
// admin/system denylist is inherited, not re-implemented: the drop happens inside the connector's
// catalog build (src/connectors/homeassistant.ts `isAdminService`, applied per service INDEPENDENT of
// area/domain/entity filtering), and this route neither re-filters nor offers a path around it.

import { resolveLocal } from "../auth/index.js";
import { ALL_SECTORS } from "../auth/index.js";
import { listActions, type ActionCatalog, type ActionFilter } from "../core/actions.js";
import { QueryValidationError } from "../core/query.js";
import { localOnly } from "./host-allowlist.js";
import { sendJson, type RouteContext } from "./router.js";

/**
 * Reject a `sector` that is not a coarse sector, as a typed 400 naming it — the same reasoning
 * data-routes.ts applies: for the ALL-SECTORS operator an unknown sector is a *validation* error, not
 * an authz denial. Without this, two different wrong answers ship:
 *   - "weather" reaches assertSector, whose sectorOf throws AccessDenied -> 403 for the operator, who
 *     is denied nothing.
 *   - a DOTTED read key ("home.entity") passes assertSector (it reduces to a granted sector) and then
 *     looks up a connector whose `sector` column is literally "home.entity" — no row, so the catalog
 *     comes back EMPTY with a 200. A silent "this sector exposes no actions" for a sector that does.
 */
function assertCoarseSector(sector: string): void {
  if (!ALL_SECTORS.includes(sector)) {
    throw new QueryValidationError(
      `unknown sector: ${sector} (expected one of ${ALL_SECTORS.join(", ")})`,
    );
  }
}

/**
 * GET /api/actions?sector=&area=&domain=&entity_id=&limit= — the cache-served catalog for one sector
 * (or, with no `sector`, every sector), as the operator.
 *
 * Response: core's ActionCatalog VERBATIM — `{ actions, count, truncated }`. `count` is what THIS
 * response holds (never a total) and `truncated: true` means the cap cut an id-sorted list, so the
 * answer is a narrower filter, not a bigger limit.
 *
 * `entity_id` is the wire spelling of core's `entityId` — the ONE name mapping here, exactly as the
 * MCP tool does it; dropping it would silently disable filtering rather than fail. `limit` is passed
 * through as a NUMBER and validated by core (one authority for the cap rule), so a non-numeric value
 * surfaces as core's typed 400 naming the field instead of being coerced into a different question.
 *
 * Bare handler (the test seam) — call it directly with a constructed RouteContext.
 */
export async function getActionCatalog(ctx: RouteContext): Promise<void> {
  const sector = ctx.query.get("sector") ?? undefined;
  if (sector !== undefined) assertCoarseSector(sector);

  const area = ctx.query.get("area") ?? undefined;
  const domain = ctx.query.get("domain") ?? undefined;
  const entityId = ctx.query.get("entity_id") ?? undefined;
  const limitRaw = ctx.query.get("limit");

  const filter: ActionFilter = {};
  if (area !== undefined) filter.area = area;
  if (domain !== undefined) filter.domain = domain;
  if (entityId !== undefined) filter.entityId = entityId;
  if (limitRaw !== null) filter.limit = Number(limitRaw);

  const auth = await resolveLocal();
  const catalog: ActionCatalog = await listActions(
    auth,
    sector,
    Object.keys(filter).length > 0 ? filter : undefined,
  );
  // Served as-is: no re-shape, no re-sort, no re-filter. The Console's "CAN ACT" block distinguishes a
  // genuinely-empty catalog (a read-only connector) from an unreachable one, and that distinction only
  // survives if this hands core's own answer over untouched.
  sendJson(ctx.res, 200, catalog);
}

/**
 * The wired route — localOnly (loopback operator), like the other operator reads. Registered in
 * src/rest/index.ts as `router.get("/api/actions", actionCatalogRoute)`.
 */
export const actionCatalogRoute = localOnly(getActionCatalog);
