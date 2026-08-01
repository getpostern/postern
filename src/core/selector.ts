// Server-side target resolution — "the kitchen light" → an HA call_service target, deterministically,
// from the CACHE only (this user + connection's home_entities). No LLM, no live HA call.
//
// Precedence: an explicit entityId wins; else match on area + domain/name against the cached entities.
// Prefer returning { area_id } for area-wide targets (let HA expand server-side — robust to new
// devices); else { entity_id: [...] }. Throws a clear error when nothing matches, so the agent can
// retry with a better selector (this is the only "guardrail": you can't act on what doesn't resolve).

import { pool } from "../db.js";

export interface Selector {
  area?: string;
  domain?: string;
  name?: string;
  entityId?: string;
}

/** An HA call_service `target`. area_id lets HA expand; entity_id is an explicit list. */
export interface ResolvedTarget {
  entity_id?: string[];
  area_id?: string;
}

/** One cached entity row, the subset the selector reasons over. */
interface CachedEntity {
  entity_id: string;
  domain: string | null;
  area: string | null;
  friendly_name: string | null;
}

/** Normalize a human label for tolerant matching: lowercased, trimmed, spaces/underscores unified. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_]+/g, " ");
}

/**
 * Resolve a selector against the user+connection's cached entities. Reads home_entities ONLY
 * (cache-only, instant). Injectable `loader` keeps it unit-testable without a DB.
 */
export async function resolveSelector(
  userId: string,
  connectionId: string,
  sel: Selector,
  loader: (userId: string, connectionId: string) => Promise<CachedEntity[]> = loadEntities,
): Promise<ResolvedTarget> {
  const entities = await loader(userId, connectionId);

  // 1. Explicit entityId — must exist in THIS user+connection's cache (can't be tricked onto
  //    another user's device, and an unknown id throws rather than silently dispatching).
  if (sel.entityId) {
    const hit = entities.find((e) => e.entity_id === sel.entityId);
    if (!hit) throw new Error(`selector: no cached entity '${sel.entityId}' for this connection`);
    return { entity_id: [hit.entity_id] };
  }

  if (!sel.area && !sel.name && !sel.domain) {
    throw new Error("selector: provide entityId, or area and/or domain/name");
  }

  const wantArea = sel.area ? norm(sel.area) : undefined;
  const wantDomain = sel.domain ? norm(sel.domain) : undefined;
  const wantName = sel.name ? norm(sel.name) : undefined;

  let candidates = entities;
  if (wantArea) candidates = candidates.filter((e) => e.area != null && norm(e.area) === wantArea);
  if (wantDomain) candidates = candidates.filter((e) => e.domain != null && norm(e.domain) === wantDomain);
  if (wantName) {
    candidates = candidates.filter((e) => {
      const fn = e.friendly_name ? norm(e.friendly_name) : "";
      const en = norm(e.entity_id);
      return fn === wantName || fn.includes(wantName) || en.includes(wantName);
    });
  }

  if (candidates.length === 0) {
    throw new Error(`selector: no entity matches ${describe(sel)} in this connection's cache`);
  }

  // Area-wide target (an area, possibly narrowed by domain, but NOT a specific name): prefer
  // returning area_id so HA expands it server-side and the target survives new devices.
  if (wantArea && !wantName) {
    const areaId = canonicalArea(candidates);
    if (areaId) {
      // Only safe to hand HA a bare area when every candidate truly shares that area.
      return wantDomain
        ? { area_id: areaId, entity_id: candidates.map((e) => e.entity_id) }
        : { area_id: areaId };
    }
  }

  // Otherwise, an explicit entity list (deduped, stable).
  const ids = [...new Set(candidates.map((e) => e.entity_id))];
  return { entity_id: ids };
}

/** The shared area label across candidates (the cache stores the resolved area name as area_id). */
function canonicalArea(candidates: CachedEntity[]): string | undefined {
  const areas = new Set(candidates.map((e) => e.area).filter((a): a is string => a != null));
  return areas.size === 1 ? [...areas][0] : undefined;
}

function describe(sel: Selector): string {
  const parts: string[] = [];
  if (sel.area) parts.push(`area='${sel.area}'`);
  if (sel.domain) parts.push(`domain='${sel.domain}'`);
  if (sel.name) parts.push(`name='${sel.name}'`);
  return `{ ${parts.join(", ")} }`;
}

/**
 * Default loader: the LIVE cached entities for this user+connection (friendly_name out of
 * attributes). Tombstoned rows are excluded — a source-removed entity is not a dispatch target.
 */
async function loadEntities(userId: string, connectionId: string): Promise<CachedEntity[]> {
  const res = await pool.query(
    `select entity_id, domain, area, attributes->>'friendly_name' as friendly_name
       from home_entities
      where user_id = $1 and connection_id = $2 and deleted_at is null`,
    [userId, connectionId],
  );
  return res.rows as CachedEntity[];
}
