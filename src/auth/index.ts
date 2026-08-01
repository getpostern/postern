/**
 * authcontext — identity + the domain-grant gate.
 *
 * Resolves *who is asking* into an AuthContext { userId, agentId, grantedSectors } once per session,
 * and provides assertSector(): the guard that denies an ungranted sector BEFORE any SQL runs. The
 * core read primitives thread this context to (1) deny ungranted sectors, and (2) scope every read
 * to ctx.userId. Local stdio = the operator (all sectors); remote = bearer → per-sector grant.
 *
 * The exact, stable surface mcp-edge and the REST edge import.
 */
export type { AuthContext } from "./resolve.js";
export { resolveLocal, resolveBearer, assertSector } from "./resolve.js";
export { ALL_SECTORS, sectorOf } from "./sectors.js";
export { AccessDenied } from "./errors.js";
