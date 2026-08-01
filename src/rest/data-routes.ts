// Operator data-read routes — the Console data inspector's loopback read path. OPERATOR-ONLY:
// both routes are wrapped in localOnly (the loopback Host-allowlist guard), NOT a bearer/agent path.
// They reuse the SAME core read functions as the bearer mirror (query() / getRecord() — REGISTRY
// validation, parameterized values, tombstone filter, user_id scoping) but as the OPERATOR with ALL
// sectors granted (resolveLocal already grants ALL_SECTORS — the owner sees all their own data,
// exactly like /api/export). No new query engine, no writes, no audit. Read-only; no secrets are
// ever in any response or error.

import { z } from "zod";
import { resolveLocal } from "../auth/index.js";
import { query as coreQuery, QueryValidationError, type QueryParams } from "../core/query.js";
import { getRecord, NotFoundError } from "../core/context.js";
import { REGISTRY } from "../core/schema.js";
import { localOnly } from "./host-allowlist.js";
import { readJson, sendJson, type RouteContext } from "./router.js";

// The /api/query DSL MINUS `sector` (the path supplies it). Mirrors mirror.ts's queryBody field-for-
// field so the inspector gets the full surface (filter/ops/sort/limit/offset/aggregation), and is
// `.strict()` so an UNKNOWN key is REJECTED (400) rather than silently dropped (#1). The path sector
// is authoritative here, so a `sector` in the body now 400s ("unrecognized key") instead of being
// silently ignored — the more-correct behavior: a caller who put it there meant something, and the
// 400 names the key so they can fix it (the path sector still wins for every valid body).
const dataQueryBody = z
  .object({
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
    // Dedup drill-through (finance-dedup-trust-batch) — the inspector gets the full surface too
    // (UI-first): serveDeduped sectors only; core 400s it elsewhere, naming the field.
    includeShadowed: z.boolean().optional(),
    // Per-row provenance (#65/#122). Accepted so the inspector can turn it OFF; it is ON by default
    // in rows mode (see postDataQuery) because on this surface "what came from where" IS the product.
    includeProvenance: z.boolean().optional(),
  })
  .strict();

/**
 * Reject a sector that names no REGISTRY object up front, as a typed 400. For the all-sectors OPERATOR
 * an unknown sector is a *validation* error, never an authz denial: bypassing this, query()/getRecord()
 * would reach assertSector first and a fully-unknown prefix (e.g. "weather") would surface as 403, while
 * a bare multi-object key (e.g. "finance") would 500 from getRecord's plain Error. A QueryValidationError
 * maps uniformly to 400 (errorToStatus). Exact-key match is the getRecord rule: multi-object sectors
 * REQUIRE the full dotted key ("finance.transaction"); a bare "finance" names no single table.
 */
function assertKnownSector(sector: string): void {
  if (!Object.hasOwn(REGISTRY, sector)) {
    throw new QueryValidationError(`unknown sector: ${sector}`);
  }
}

/**
 * POST /api/data/:sector — operator list/read over one sector's cached rows. The body is the /api/query
 * DSL minus `sector`; the route injects the path sector and runs core query() as the operator (all
 * sectors granted — no grant filter, same posture as export). Returns the core query() result:
 * { sector, object, count, rows } in rows mode, or { sector, object, aggregate, count, groups } in
 * aggregate mode. Unknown sector/field or a bad op → QueryValidationError → 400; tombstones are
 * excluded and rows are user_id-scoped, both inherited from query().
 *
 * Rows-mode rows carry `__provenance` ({ connection_id, provider, merged } — see RowProvenance) by
 * DEFAULT here: output only, never a filter/sort key, and no REGISTRY field was added to serve it.
 *
 * Bare handler (the test seam) — call it directly with a constructed RouteContext + parsed body.
 */
export async function postDataQuery(ctx: RouteContext, body: unknown): Promise<void> {
  const sector = ctx.params.sector;
  assertKnownSector(sector);
  const auth = await resolveLocal();
  const parsed = dataQueryBody.parse(body);
  // Provenance ON by default in ROWS mode (#65/#122). Three providers now feed calendar and contacts
  // on a real box and none of those sectors is deduped, so a list of identical rows with nothing to
  // tell them apart is the inspector's most-reported defect — the surface exists to answer "which
  // connection is this row from?", so it must not depend on the client remembering to ask. Defaulted
  // HERE and not in core: the agent surfaces stay lean and opt-in (a uuid + provider per row is real
  // response weight), which is the same reason `raw` is not projected by default.
  // AGGREGATE mode never carries it — core rejects the combination, and silently injecting it would
  // turn every existing aggregate request from this route into a 400. An explicit value always wins,
  // in both directions: `false` opts a rows read out, `true` with an aggregate still earns the typed 400.
  const provenance =
    parsed.aggregate === undefined ? { includeProvenance: parsed.includeProvenance ?? true } : {};
  const params: QueryParams = { ...parsed, sector, ...provenance };
  const out = await coreQuery(auth, params);
  sendJson(ctx.res, 200, out);
}

/**
 * GET /api/data/:sector/:id — operator drill into one cached row by id. Reuses core getRecord(): the
 * FULL row including `raw` (select *), tombstone-truthful (deleted rows ARE returned by the drill —
 * ADR 0004), and user_id-scoped (another user's row resolves to null, never the row). An unknown
 * sector → 400; an absent id → 404.
 *
 * Bare handler (the test seam) — call it directly with a constructed RouteContext.
 */
export async function getDataRecord(ctx: RouteContext): Promise<void> {
  const sector = ctx.params.sector;
  const id = ctx.params.id;
  assertKnownSector(sector);
  const auth = await resolveLocal();
  const row = await getRecord(auth, sector, id);
  if (row === null) throw new NotFoundError(`no ${sector} record with id '${id}'`);
  sendJson(ctx.res, 200, { record: row });
}

/**
 * The wired routes — both localOnly (loopback operator), per spec. The mother registers these in
 * src/rest/index.ts at merge:
 *   router.post("/api/data/:sector", dataQueryRoute);
 *   router.get("/api/data/:sector/:id", dataRecordRoute);
 * dataQueryRoute reads its own JSON body (like the Plaid routes), so it registers directly.
 */
export const dataQueryRoute = localOnly(async (ctx: RouteContext) => {
  const body = await readJson(ctx.req); // PayloadTooLargeError / ValidationError -> 400
  await postDataQuery(ctx, body);
});

export const dataRecordRoute = localOnly(getDataRecord);
