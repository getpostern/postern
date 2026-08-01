import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { ALL_SECTORS, LOCAL_USER_ID, sectorOf } from "./sectors.js";
import { AccessDenied } from "./errors.js";

/**
 * Who is asking, resolved once per session. The grant check is an in-memory Set membership test —
 * never a DB round-trip on the hot path. A '*' grant is PRE-EXPANDED to ALL_SECTORS at resolve time.
 */
export interface AuthContext {
  readonly userId: string;
  readonly agentId: string; // 'operator' (local stdio) | agent_grants.agent_id (remote)
  readonly grantedSectors: ReadonlySet<string>;
  /**
   * Hard deadline for this credential, or null/undefined = none (operator, never-expiring key).
   * resolveBearer: agent_grants.expires_at. Bridge tokens: min(access_expires_at, grant.expires_at).
   * (Frozen seam for mcp-auth-bridge — populated by the expiry unit; readers treat absent as no deadline.)
   */
  readonly expiresAt?: Date | null;
}

let localCtx: AuthContext | undefined;

/**
 * The local stdio operator: the seeded user, all sectors, zero setup — the gateway is not a guard
 * against you on your own box. Memoized: resolve once = the "once per session" model (no DB, no I/O).
 */
export async function resolveLocal(): Promise<AuthContext> {
  if (!localCtx) {
    localCtx = {
      userId: LOCAL_USER_ID,
      agentId: "operator",
      grantedSectors: new Set(ALL_SECTORS),
    };
  }
  return localCtx;
}

/** sha256 hex of the presented bearer — the only form ever compared; the raw key is never stored or logged. */
function sha256Hex(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}

/**
 * A remote bearer caller: sha256(bearer) → agent_grants row. Default-deny per sector.
 * - unknown hash → AccessDenied('unknown agent'); revoked row → AccessDenied('revoked');
 *   past agent_grants.expires_at → AccessDenied('expired') — a key is dead AT its expiry instant.
 * - '*' grant expands to ALL_SECTORS; otherwise the granted sectors are intersected with ALL_SECTORS.
 * - empty sectors is NOT an error: the agent connects but every assertSector denies (default-deny).
 */
export async function resolveBearer(bearer: string): Promise<AuthContext> {
  const keyHash = sha256Hex(bearer);
  const res = await pool.query(
    `select user_id, agent_id, sectors, revoked_at, expires_at from agent_grants where key_hash = $1`,
    [keyHash],
  );
  const row = res.rows[0];
  // Credential failures carry `reason`, never `sector` — the audit deny_reason vocabulary stays out
  // of the sector column on every path (ADR 0029; errors.ts documents the two fields).
  if (!row) throw new AccessDenied(undefined, "unknown agent");
  if (row.revoked_at != null) throw new AccessDenied(undefined, "revoked");
  const expiresAt = row.expires_at != null ? new Date(row.expires_at) : null;
  if (expiresAt != null && expiresAt.getTime() <= Date.now()) throw new AccessDenied(undefined, "expired");

  const sectors: string[] = Array.isArray(row.sectors) ? row.sectors : [];
  const grantedSectors = sectors.includes("*")
    ? new Set(ALL_SECTORS)
    : new Set(sectors.filter((s) => ALL_SECTORS.includes(s)));

  return {
    userId: row.user_id as string,
    agentId: row.agent_id as string,
    grantedSectors,
    expiresAt,
  };
}

/**
 * The single chokepoint every read calls FIRST: map the target to its coarse sector and require a
 * grant. Throws AccessDenied (with .sector set) BEFORE any SQL runs.
 */
export function assertSector(ctx: AuthContext, target: string): void {
  const s = sectorOf(target);
  if (!ctx.grantedSectors.has(s)) throw new AccessDenied(s);
}
