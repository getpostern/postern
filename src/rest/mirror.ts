// Read-mirror — the five read primitives, 1:1 over HTTP. TWO surfaces, ONE implementation.
//
// 1. THE AGENT MIRROR (bearer-gated + audited). Every handler resolves `Authorization: Bearer <key>`
//    via authcontext.resolveBearer FIRST:
//      - missing/garbage bearer            -> 401 (UnauthorizedError)
//      - resolveBearer throws AccessDenied -> 403 + audit{decision:'deny'}
//      - success                           -> core fn + audit{decision:'allow', resultCount}
//
// 2. THE OPERATOR MIRROR (loopback, #89 fifth seam / #57 / #82). The Console holds no agent key by
//    construction, so `get_schema` / `describe_context` / `fetch_live` 401'd at it and three drawn
//    affordances were dead. The operator equivalents are the SAME handler bodies with resolveLocal()
//    substituted for the bearer resolve, wrapped in `localOnly` (the loopback Host-allowlist) at the
//    composition root, on their own `/api/operator/*` paths.
//
//    WHY THAT IS NOT A WIDENING, per primitive. Loopback reachability already implies operator trust
//    and the operator already reads strictly more through this same edge: `/api/data/:sector` runs
//    core query()/getRecord() as the all-sectors operator and returns the ROWS; `/api/export` returns
//    the WHOLE store; `/api/connectors` serves every connection's provider/status/freshness/scopes.
//    Against that baseline `describe_context` (the sector list + connection metadata) and `get_schema`
//    (the static REGISTRY contract — no user data at all) add no reachable fact. `fetch_live` in
//    sector mode is capability-identical to POST /api/connectors/:id/sync, which is already loopback
//    and which the Console already fans out across a sector; only its per-record drill is new, and
//    that reaches the operator's own row through the operator's own credential, grant-checked and
//    user-scoped inside core.
//
//    AND THE DISCIPLINE IS IDENTICAL BY CONSTRUCTION, not by parallel maintenance: the resolver is the
//    only difference, so `get_schema` still filters to `auth.grantedSectors` and every core call still
//    takes AuthContext as its first argument with assertSector ahead of any SQL. There is no bearer
//    fallback on an operator route and no loopback exemption on a bearer route — two disjoint
//    resolvers on two disjoint path spaces, so neither can become an escalation path into the other.
//
//    AUDIT follows the posture the operator surface already has, and the split is deliberate: the
//    cache-only operator READS are not audited (exactly like `/api/data/:sector`, whose header records
//    the same choice for the same primitives — and the ledger's reachable window is a capped 1000 rows
//    with no cursor (#61), so filling it with the operator's own page loads would push real agent rows
//    out of reach). The operator `fetch_live` IS audited, because it touches upstream and mutates the
//    cache — exactly like its loopback sibling POST /api/connectors/:id/sync (auditAdmin 'sync_now').
//
// The audit hook is INJECTED (default no-op) and fired OFF the response path — never awaited — so it
// adds zero latency and a slow/throwing sink can't affect the response. Secrets/tokens are never in
// any of these payloads; get_schema is filtered to the caller's granted sectors.

import { z } from "zod";
import { resolveBearer, resolveLocal, AccessDenied, type AuthContext } from "../auth/index.js";
import { describeContext, getRecord, fetchLive } from "../core/context.js";
import { query as coreQuery } from "../core/query.js";
import { getSchema, REGISTRY } from "../core/schema.js";
import { sendJson, UnauthorizedError, type RouteContext } from "./router.js";
import type { AuditHook } from "./index.js";

/** A core tool name, for the audit entry. */
type Tool = "describe_context" | "get_schema" | "query" | "get_record" | "fetch_live";

/** Pull the raw bearer from the Authorization header, or throw 401 if absent/malformed. */
function requireBearer(ctx: RouteContext): string {
  const header = ctx.req.headers["authorization"];
  if (!header || Array.isArray(header)) throw new UnauthorizedError("missing bearer");
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m || !m[1]) throw new UnauthorizedError("malformed bearer");
  return m[1];
}

/** Fire the injected audit hook off the response path. Never awaited; a throwing sink can't escape. */
function fireAudit(audit: AuditHook | undefined, entry: Parameters<AuditHook>[0]): void {
  if (!audit) return;
  try {
    // Intentionally not awaited: detective, async, zero hot-path cost.
    void Promise.resolve().then(() => audit(entry)).catch(() => {});
  } catch {
    // A synchronous throw from the hook must never affect the response.
  }
}

/**
 * Resolve the bearer to an AuthContext. A missing/garbage bearer is a 401 (UnauthorizedError); an
 * AccessDenied from resolveBearer (unknown/revoked agent) propagates so the caller can audit a deny
 * and the router maps it to 403.
 */
async function authenticate(ctx: RouteContext): Promise<AuthContext> {
  const bearer = requireBearer(ctx);
  return resolveBearer(bearer); // may throw AccessDenied -> 403
}

/**
 * How a handler obtains its AuthContext — the ONLY thing that differs between the two surfaces.
 * Everything downstream (the granted-sector filter, the core call, the audit branches) is literally
 * the same code, so the agent mirror and the operator mirror cannot drift apart on AuthContext
 * discipline: a change to one is a change to both.
 */
type AuthResolver = (ctx: RouteContext) => Promise<AuthContext>;

/**
 * The loopback operator: the seeded user, all sectors. It reads NOTHING off the request — no
 * Authorization header is consulted, so an operator route can never be escalated by presenting a
 * bearer, and (conversely) a bearer route can never be satisfied by arriving on loopback.
 */
async function asOperator(_ctx: RouteContext): Promise<AuthContext> {
  return resolveLocal();
}

// Mirrors the core QueryParams surface 1:1, and is `.strict()` so an UNKNOWN key is REJECTED (400),
// not silently dropped: a misnamed param (`filter` for `where`, a top-level `groupBy`) used to return
// 200-with-the-param-unapplied (#1) — wrong results the agent couldn't see. Every queryable field
// must still be declared here, since strict rejects anything not listed (omitting orderBy/offset/
// aggregate would 400 a legitimate ordered/paged/aggregated query). A `sector` in the body is the
// authoritative param here (POST /api/query carries it in the body, unlike the data routes).
const queryBody = z
  .object({
    sector: z.string().min(1),
    where: z.record(z.unknown()).optional(),
    select: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().min(0).optional(),
    orderBy: z
      .array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() }))
      .optional(),
    aggregate: z
      .object({
        fn: z.enum(["count", "sum", "avg", "min", "max"]),
        field: z.string().optional(),
        groupBy: z.array(z.string()).optional(),
      })
      .optional(),
    // Dedup drill-through (finance-dedup-trust-batch): serveDeduped sectors only — core 400s it
    // elsewhere, naming the field. Declared here because .strict() would otherwise 400 the feature.
    includeShadowed: z.boolean().optional(),
  })
  .strict();

// `.strict()` too: a misnamed `id` must 400, not silently degrade a per-record live drill into a
// whole-sector sync-now (#1).
const fetchLiveBody = z
  .object({
    sector: z.string().min(1),
    id: z.string().optional(),
  })
  .strict();

/** describeContext over one resolved identity — shared by both surfaces. */
async function serveContext(
  ctx: RouteContext,
  resolve: AuthResolver,
  audit: AuditHook | undefined,
): Promise<void> {
  const auth = await resolve(ctx);
  const out = await describeContext(auth);
  fireAudit(audit, {
    userId: auth.userId,
    agentId: auth.agentId,
    tool: "describe_context",
    decision: "allow",
    resultCount: out.connections.length,
  });
  sendJson(ctx.res, 200, out);
}

/** GET /api/context — describeContext as the bearer agent. Audited allow with the connection count. */
export async function mirrorContext(ctx: RouteContext, audit?: AuditHook): Promise<void> {
  return serveContext(ctx, authenticate, audit);
}

/**
 * GET /api/operator/context — the same read as the operator (loopback; localOnly at the composition
 * root). Cache-only metadata, so unaudited like `/api/data/:sector` — see the file header.
 */
export async function operatorContext(ctx: RouteContext): Promise<void> {
  return serveContext(ctx, asOperator, undefined);
}

/** getSchema over one resolved identity, filtered to ITS granted sectors — shared by both surfaces. */
async function serveSchema(
  ctx: RouteContext,
  resolve: AuthResolver,
  audit: AuditHook | undefined,
): Promise<void> {
  const auth = await resolve(ctx);
  const sector = ctx.query.get("sector") ?? undefined;

  // getSchema throws on a fully-unknown sector; treat that as an empty (filtered) result.
  let raw: Record<string, { object: string; table: string; fields: Record<string, string>; primaryTime?: string }>;
  try {
    raw = getSchema(sector) as typeof raw;
  } catch {
    raw = {} as typeof raw;
  }

  // Filter to granted sectors: a REGISTRY key's leading segment must be in grantedSectors.
  const filtered: typeof raw = {} as typeof raw;
  for (const [key, schema] of Object.entries(raw)) {
    const sec = key.split(".")[0];
    if (auth.grantedSectors.has(sec)) filtered[key] = schema;
  }

  fireAudit(audit, {
    userId: auth.userId,
    agentId: auth.agentId,
    tool: "get_schema",
    sector: sector ?? null,
    decision: "allow",
    args: { sector }, // #9
    resultCount: Object.keys(filtered).length,
  });
  sendJson(ctx.res, 200, filtered);
}

/**
 * GET /api/schema?sector= — getSchema filtered to the caller's granted sectors. An ungranted sector
 * is simply absent from the result (no leak of what exists); with no `sector` param every granted
 * sector's objects are returned.
 */
export async function mirrorSchema(ctx: RouteContext, audit?: AuditHook): Promise<void> {
  return serveSchema(ctx, authenticate, audit);
}

/**
 * GET /api/operator/schema?sector= — the same read as the operator (loopback; localOnly at the
 * composition root). The filter is NOT skipped for the operator: it still runs against
 * `auth.grantedSectors`, which resolveLocal populates from ALL_SECTORS — so if ALL_SECTORS ever
 * narrows, both surfaces narrow together instead of one keeping a hardcoded "everything".
 * Cache-only static contract, so unaudited — see the file header.
 */
export async function operatorSchema(ctx: RouteContext): Promise<void> {
  return serveSchema(ctx, asOperator, undefined);
}

/** POST /api/query — query(ctx, params). Ungranted sector -> AccessDenied (403) + audit deny. */
export async function mirrorQuery(ctx: RouteContext, body: unknown, audit?: AuditHook): Promise<void> {
  const auth = await authenticate(ctx);
  const params = queryBody.parse(body);
  await runAudited(ctx, auth, "query", params.sector, params, audit, async () => {
    const out = await coreQuery(auth, params);
    sendJson(ctx.res, 200, out);
    // count is present in both result modes: rowCount in rows mode, group count in aggregate mode.
    return out.count ?? 0;
  });
}

/** GET /api/records/:sector/:id — getRecord(ctx, sector, id). */
export async function mirrorGetRecord(ctx: RouteContext, audit?: AuditHook): Promise<void> {
  const auth = await authenticate(ctx);
  const sector = ctx.params.sector;
  const id = ctx.params.id;
  await runAudited(ctx, auth, "get_record", sector, { id }, audit, async () => {
    const row = await getRecord(auth, sector, id);
    sendJson(ctx.res, 200, { record: row });
    return row ? 1 : 0;
  });
}

/** fetchLive over one resolved identity — shared by both surfaces. */
async function serveFetchLive(
  ctx: RouteContext,
  body: unknown,
  resolve: AuthResolver,
  audit: AuditHook | undefined,
): Promise<void> {
  const auth = await resolve(ctx);
  const { sector, id } = fetchLiveBody.parse(body);
  await runAudited(ctx, auth, "fetch_live", sector, { id }, audit, async () => {
    const out = await fetchLive(auth, sector, { id });
    sendJson(ctx.res, 200, out as unknown as object);
    return null;
  });
}

/** POST /api/fetch_live — fetchLive(ctx, sector, { id }): sector sync-now, or per-record live drill. */
export async function mirrorFetchLive(ctx: RouteContext, body: unknown, audit?: AuditHook): Promise<void> {
  return serveFetchLive(ctx, body, authenticate, audit);
}

/**
 * POST /api/operator/fetch_live — the same one read-time upstream path as the operator (loopback;
 * localOnly at the composition root). The body stays `.strict()`, so a misnamed `id` still 400s rather
 * than silently degrading a per-record drill into a whole-sector sync (#1).
 *
 * AUDITED, unlike the operator's cache-only reads: this reaches a source and mutates the cache, which
 * is exactly the line POST /api/connectors/:id/sync already sits on (auditAdmin 'sync_now'). The entry
 * carries agentId 'operator' from resolveLocal, so the ledger distinguishes it from an agent's drill.
 */
export async function operatorFetchLive(
  ctx: RouteContext,
  body: unknown,
  audit?: AuditHook,
): Promise<void> {
  return serveFetchLive(ctx, body, asOperator, audit);
}

/**
 * Run a sector-scoped core call with audit on EVERY outcome: an AccessDenied (ungranted sector)
 * audits a deny and re-throws (router -> 403); any OTHER throw (a QueryValidationError, a live-fetch
 * failure, …) audits an allowed-but-errored read and re-throws — closing the adjacent gap where an
 * errored REST read produced NO audit row at all (#10-adjacent); success audits an allow with the
 * resultCount. `args` (the raw DSL / params) is recorded on every branch for forensic attribution
 * (#9; redaction is central in audit()). The audit fire is off the response path in every branch.
 */
async function runAudited(
  ctx: RouteContext,
  auth: AuthContext,
  tool: Tool,
  sector: string,
  args: unknown,
  audit: AuditHook | undefined,
  run: () => Promise<number | null>,
): Promise<void> {
  try {
    const resultCount = await run();
    fireAudit(audit, {
      userId: auth.userId,
      agentId: auth.agentId,
      tool,
      sector: baseSector(sector),
      decision: "allow",
      args,
      resultCount,
    });
  } catch (err) {
    if (err instanceof AccessDenied) {
      fireAudit(audit, {
        userId: auth.userId,
        agentId: auth.agentId,
        tool,
        sector: err.sector ?? baseSector(sector),
        decision: "deny",
        denyReason: err.message,
        args,
      });
    } else {
      // The read passed the grant but failed in core. Record an allowed-but-errored row so the call
      // is no longer invisible. The denyReason carries the error STRING only (secret-free — never the
      // row data); the REST AuditHook has no `outcome` field, so 'allow' + the message is the signal.
      fireAudit(audit, {
        userId: auth.userId,
        agentId: auth.agentId,
        tool,
        sector: baseSector(sector),
        decision: "allow",
        denyReason: err instanceof Error ? err.message : String(err),
        args,
      });
    }
    throw err;
  }
}

/** Coarse sector for the audit row (the REGISTRY key's leading segment), best-effort. */
function baseSector(target: string): string | null {
  const s = target.split(".")[0];
  return REGISTRY[target] || s ? s : null;
}
