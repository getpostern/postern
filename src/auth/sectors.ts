import { REGISTRY } from "../core/schema.js";
import { AccessDenied } from "./errors.js";

/**
 * The coarse sectors — the unit of permission. Derived from the REGISTRY keys (single source of
 * truth): dotted multi-object keys ("finance.transaction") and bare single-object keys ("mail")
 * collapse to their leading sector. Yields: finance, health, mail, contacts, calendar, home.
 */
export const ALL_SECTORS: readonly string[] = [
  ...new Set(Object.keys(REGISTRY).map((k) => k.split(".")[0])),
];

const SECTOR_SET = new Set(ALL_SECTORS);

/**
 * Map a query target (a REGISTRY key like "finance.transaction" or a bare sector like "mail") to
 * its coarse sector. FAIL-CLOSED: a target whose prefix is not a known sector throws AccessDenied,
 * so an unknown/typo'd target can never be silently mapped onto a real grant.
 */
export function sectorOf(target: string): string {
  const s = target.split(".")[0];
  if (!SECTOR_SET.has(s)) throw new AccessDenied(s);
  return s;
}

/** The seeded self-host operator user (db/schema.sql). A constant in V0; moves to config when multi-user lands. */
export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";
