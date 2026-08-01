import { pool } from "../db.js";
import { REGISTRY, UNION_SOID_PREFIX, UUID_RE, objectKeysFor, type SectorSchema } from "./schema.js";
import { assertSector, sectorOf, type AuthContext } from "../auth/index.js";
import { timed } from "../obs/duration.js";

/**
 * Every input-validation failure on the read path. Messages name the field/op and what's allowed so
 * agents can self-correct; the REST edge maps it to a 400 (MCP surfaces the message via the SDK).
 */
export class QueryValidationError extends Error {
  override name = "QueryValidationError";
}

export interface OrderBy {
  field: string;
  dir?: "asc" | "desc"; // default "asc"
}

export interface Aggregate {
  fn: "count" | "sum" | "avg" | "min" | "max";
  field?: string; // required for sum/avg/min/max; forbidden for count
  groupBy?: string[]; // REGISTRY fields
}

export interface QueryParams {
  sector: string;
  where?: Record<string, unknown>;
  select?: string[];
  limit?: number; // cap 500; in aggregate mode caps GROUP count (default 100)
  offset?: number; // int >= 0, cap 5000; rows mode only
  orderBy?: OrderBy[]; // rows mode only; default [{ field: primaryTime, dir: "desc" }]
  aggregate?: Aggregate;
  /**
   * Dedup drill-through (serveDeduped sectors ONLY — the finance objects). When true, the
   * `shadowed_by_id is null` predicate is OMITTED so the pristine provider rows behind a merged
   * account/transaction/holding are served alongside the synthetic winner, and rows mode appends the
   * core-applied READ-ONLY linkage columns (`shadowed_by_id`, plus `dedup_group_id` where the table
   * has one — finance_transactions doesn't) to each returned row. The linkage columns stay OUT of the
   * REGISTRY `fields` list on purpose: that list is ALSO the ingest write allow-list (applyRecords)
   * and the filter/sort/aggregate vocabulary — exposing them would let a connector pre-shadow its own
   * rows. Aggregate mode follows the same predicate-omission: an `includeShadowed` aggregate INCLUDES
   * shadow rows BY DESIGN (opt-in semantics — a drill-through sum over a merged pair double-counts,
   * which is exactly what the caller asked to see). On a non-serveDeduped sector the param is a typed
   * 400 naming the field (never a silent no-op).
   */
  includeShadowed?: boolean;
  /**
   * Per-row PROVENANCE — "which source produced this row" (#65/#122). ROWS MODE ONLY; combining it
   * with `aggregate` is a typed 400 naming the field (a group is not a row, and grouping BY
   * provenance would require `connection_id` in the filter vocabulary — see below).
   *
   * When true, every served row gains ONE synthetic output key, `__provenance` (`RowProvenance`),
   * and NO row keys are removed. It is OUTPUT ONLY: `connection_id` remains absent from the REGISTRY
   * `fields` map, so it stays un-filterable, un-sortable, un-groupable AND un-writable. That is the
   * whole design constraint: `fields` is BOTH the read vocabulary and the ingest write allow-list
   * (applyRecords), so declaring the column there to serve it would hand a provider the power to say
   * which connection its rows belong to. A read-only projection under an internal alias serves the
   * fact without widening the allow-list — the same trick the dedup linkage columns use.
   *
   * Absent/false → the key is not present on any row and the emitted SQL is byte-identical to before
   * the param existed. Absent therefore means "not asked for", NEVER "unknown".
   */
  includeProvenance?: boolean;
}

/**
 * One row's provenance, as `__provenance` (#65/#122). Every field is a fact read from the row's own
 * `connection_id` + that connection's `connectors` row — never inferred from row content, because
 * there is no honest way to guess a row's origin (the finance `__source` marker can flag a merge
 * winner but cannot NAME a provider, which is the whole of #122).
 *
 * The three shapes that actually occur, all honest:
 *   - a normal provider row → `{ connection_id: <uuid>, provider: "google", merged: false }`.
 *     `provider` is the connector's stored provider slug, served verbatim (never a display name —
 *     the Console owns the "google" → "Google" rendering, as it already does on the record drill).
 *     A REVOKED connection still resolves: the row DID come from it, and provenance is history.
 *   - a cross-provider dedup SYNTHETIC winner → `{ connection_id: null, provider: null,
 *     merged: true }`. It stands for two providers' copies, so naming one would be a lie. Its member
 *     rows (each with its own provenance) are reachable via `includeShadowed`.
 *   - a row whose connection cannot be resolved in THIS sector for THIS user →
 *     `{ connection_id: <uuid>, provider: null, merged: false }` — "unknown source", never invented.
 *     `provider: null` is the fail-closed answer, not an error: nothing about a row's provenance is
 *     worth failing a read over, and resolution is deliberately scoped so a caller can never learn a
 *     provider fact about a sector they were not granted.
 */
export interface RowProvenance {
  /** `connectors.id` — the id describe_context/fetch_live key on. null ⟺ merged (no single source). */
  connection_id: string | null;
  /** The connector's provider slug ("google", "microsoft", "apple", …). null = merged or unresolvable. */
  provider: string | null;
  /** true = a dedup synthetic standing for >1 connection. Read off the reserved soid namespace. */
  merged: boolean;
}

/** The synthetic output key carrying `RowProvenance`. Leading "__" cannot collide: no REGISTRY name starts with "_". */
export const PROVENANCE_FIELD = "__provenance";

/**
 * Internal SQL aliases for the provenance projection, lifted back off every row before it is served
 * (the AGG_ALIAS pattern). They are never part of the response: an escaped `connection_id`-shaped key
 * would read as a REGISTRY field and invite exactly the filter/write widening this design refuses.
 */
const PROV_CONN_ALIAS = "__pci_conn";
const PROV_SOID_ALIAS = "__pci_soid";

const MAX_LIMIT = 500;
const MAX_OFFSET = 5000;
const MAX_IN_ELEMENTS = 200;
const MAX_LIST_ELEMENTS = 50; // select / orderBy / groupBy element cap

// Runtime whitelists mapping agent input to HARDCODED SQL strings. TS unions are erased at runtime
// and core is the chokepoint for non-zod callers, so an op/dir/fn fed straight through QueryParams
// must resolve against these tables — the input string itself is NEVER interpolated. Every lookup
// into these tables (and into REGISTRY / schema.fields) is own-property-guarded via Object.hasOwn:
// an unguarded truthy bracket read would resolve prototype members ("constructor", "toString",
// "__proto__", ...) and BYPASS validation.
const OPS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * The dedup linkage columns appended (READ-ONLY, core-applied — like `id`, never agent-interpolated)
 * to rows-mode results when `includeShadowed` is set on a serveDeduped sector, keyed by table.
 * finance_transactions has NO dedup_group_id column (migration 0009 added only shadowed_by_id there),
 * so it projects the one. These names are HARDCODED table facts, deliberately NOT REGISTRY fields —
 * see the includeShadowed jsdoc for why they must never enter the filter/ingest vocabulary.
 */
export const DEDUP_LINKAGE_COLS: Record<string, readonly string[]> = {
  finance_accounts: ["shadowed_by_id", "dedup_group_id"],
  finance_transactions: ["shadowed_by_id"],
  finance_holdings: ["shadowed_by_id", "dedup_group_id"],
};
const DIRS: Record<string, string> = { asc: "asc", desc: "desc" };
const AGG_FNS: Record<string, string> = { count: "count", sum: "sum", avg: "avg", min: "min", max: "max" };

/**
 * The internal SQL alias for the aggregate column. REGISTRY names never start with "_", so it cannot
 * collide with a real column (health.sample has a real `value` column — which is exactly why the
 * OUTPUT shape nests group columns under `group` and the aggregate under `value`, mapped in JS).
 */
const AGG_ALIAS = "__pci_agg";

/** Escape `\`, `%`, `_` so a contains value matches literally (backslash = the Postgres default ESCAPE). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * A bare sector that names REGISTRY objects gets a TEACHING error naming them; anything else lists
 * the known keys. `assertSector` runs first at every call site, so the enumerating branch is only
 * ever reached by a caller already granted that sector — and the REGISTRY key list is a fixed,
 * open-source product fact, never user data.
 */
export function unknownSectorError(sector: string, verb = "query"): QueryValidationError {
  const keys = objectKeysFor(sector.split(".")[0]);
  if (keys.length > 0) {
    return new QueryValidationError(
      `${verb} requires a full object key (${keys.join(" or ")}), got '${sector}'`,
    );
  }
  return new QueryValidationError(
    `unknown sector: ${sector} (known: ${Object.keys(REGISTRY).join(", ")})`,
  );
}

/**
 * A `"uuid"` field takes uuid-shaped VALUES only. Without this a `where: {id: "abc"}` builds valid
 * SQL and dies in Postgres as a 22P02 — an opaque 500 at the bearer mirror and a raw driver message
 * over MCP. Turning it into a typed 400 that names the type is the whole point of declaring `uuid`.
 * null is exempt: {eq: null} / {neq: null} are IS NULL / IS NOT NULL and carry no value.
 */
function assertUuidValue(field: string, val: unknown): void {
  if (val === null) return;
  if (typeof val !== "string" || !UUID_RE.test(val)) {
    throw new QueryValidationError(`"${field}" takes a uuid; got '${String(val)}'`);
  }
}

/** One where condition -> a parameterized SQL clause. `op` resolves through the OPS whitelist only. */
function buildCondition(
  field: string,
  fieldType: string,
  op: string,
  val: unknown,
  values: unknown[],
): string {
  const isUuid = fieldType === "uuid";
  switch (op) {
    case "eq":
      if (val === null) return `"${field}" is null`;
      if (isUuid) assertUuidValue(field, val);
      values.push(val);
      return `"${field}" = $${values.length}`;
    case "neq":
      // Null-INCLUSIVE inequality: rows where the column is null DO match `neq: 'X'` — the
      // agent-friendly reading (SimpleFIN's null categories must not vanish from "spend outside food").
      if (val === null) return `"${field}" is not null`;
      if (isUuid) assertUuidValue(field, val);
      values.push(val);
      return `"${field}" is distinct from $${values.length}`;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (fieldType === "bool") {
        throw new QueryValidationError(`operator ${op} is invalid on bool field "${field}" (use eq/neq)`);
      }
      if (val === null) {
        throw new QueryValidationError(`operator ${op} on "${field}" cannot take null (use {eq: null} or {neq: null})`);
      }
      if (isUuid) assertUuidValue(field, val);
      if (!Object.hasOwn(OPS, op)) {
        // Unreachable behind the switch literals, but every whitelist read is hasOwn-guarded uniformly.
        throw new QueryValidationError(`unsupported operator: ${op} (allowed: eq, neq, gt, gte, lt, lte, in, contains)`);
      }
      values.push(val);
      return `"${field}" ${OPS[op]} $${values.length}`;
    case "in": {
      if (!Array.isArray(val)) {
        throw new QueryValidationError(`operator in on "${field}" requires an array of scalars`);
      }
      if (val.length > MAX_IN_ELEMENTS) {
        throw new QueryValidationError(`operator in on "${field}" allows at most ${MAX_IN_ELEMENTS} elements (got ${val.length})`);
      }
      for (const el of val) {
        if (!isScalar(el)) {
          throw new QueryValidationError(`operator in on "${field}" takes scalar elements only (no null/object/array)`);
        }
        if (isUuid) assertUuidValue(field, el);
      }
      values.push(val); // the whole array is ONE parameter; [] is legal and matches nothing
      return `"${field}" = any($${values.length})`;
    }
    case "contains":
      if (fieldType !== "text") {
        throw new QueryValidationError(`operator contains is only valid on text fields; "${field}" is ${fieldType}`);
      }
      if (typeof val !== "string") {
        throw new QueryValidationError(`operator contains on "${field}" requires a string`);
      }
      values.push(`%${escapeLike(val)}%`);
      return `"${field}" ilike $${values.length}`;
    default:
      throw new QueryValidationError(`unsupported operator: ${op} (allowed: eq, neq, gt, gte, lt, lte, in, contains)`);
  }
}

/** The agent's where conditions, validated field-by-field against the REGISTRY. */
function buildWhere(schema: SectorSchema, where: Record<string, unknown> | undefined, values: unknown[]): string[] {
  const clauses: string[] = [];
  for (const [field, cond] of Object.entries(where ?? {})) {
    if (!Object.hasOwn(schema.fields, field)) {
      throw new QueryValidationError(`unknown field in where: ${field}`);
    }
    const fieldType = schema.fields[field];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const ops = Object.entries(cond as Record<string, unknown>);
      if (ops.length === 0) throw new QueryValidationError(`empty operator object for "${field}"`);
      for (const [op, val] of ops) clauses.push(buildCondition(field, fieldType, op, val, values));
    } else if (Array.isArray(cond)) {
      throw new QueryValidationError(`bare array value for "${field}" — use {in: [...]}`);
    } else if (cond === null) {
      clauses.push(`"${field}" is null`); // bare null === {eq: null}
    } else {
      // Bare scalar === {eq: value}; it bypasses buildCondition, so the uuid value guard is repeated
      // here on purpose — the bare form is the one an agent actually writes for an id.
      if (fieldType === "uuid") assertUuidValue(field, cond);
      values.push(cond);
      clauses.push(`"${field}" = $${values.length}`);
    }
  }
  return clauses;
}

/** Rows mode: projected columns, deterministic ordering (default primaryTime desc), limit/offset. */
function buildRowsSelect(
  schema: SectorSchema,
  params: QueryParams,
  whereSql: string,
  limit: number,
  values: unknown[],
): { sql: string; values: unknown[] } {
  if (params.select !== undefined && params.select.length > MAX_LIST_ELEMENTS) {
    throw new QueryValidationError(`select allows at most ${MAX_LIST_ELEMENTS} fields (got ${params.select.length})`);
  }
  // Default select (omitted) = flat fields only — raw/jsonb is NEVER projected by default, so payloads
  // stay lean (selecting raw forces a TOAST fetch+decompress per row). A select entry is valid if it's
  // a flat REGISTRY field OR one of the table's declared jsonb columns (opt-in find-then-detail): jsonb
  // is PROJECTABLE here but stays NON-filterable/sortable/aggregatable (buildWhere/orderBy/groupBy/
  // aggregate validate against schema.fields ONLY). `.includes` is a value match over the
  // REGISTRY-declared jsonb list — not a property lookup — so prototype keys can never sneak in, and a
  // projected name is a quoted, REGISTRY-sourced identifier (never agent-interpolated).
  const select = params.select?.length ? params.select : Object.keys(schema.fields);
  for (const f of select) {
    const isField = Object.hasOwn(schema.fields, f);
    const isJsonb = schema.jsonb?.includes(f) ?? false;
    if (!isField && !isJsonb) throw new QueryValidationError(`unknown field in select: ${f}`);
  }

  // Deterministic-within-snapshot ordering: the agent's orderBy (validated), else primaryTime desc;
  // "id" asc as the final tiebreak unless the agent already ordered by id. dir resolves through the
  // DIRS whitelist (own-property-guarded), never interpolated.
  const orderParts: string[] = [];
  let idOrdered = false;
  if (params.orderBy !== undefined) {
    if (params.orderBy.length > MAX_LIST_ELEMENTS) {
      throw new QueryValidationError(`orderBy allows at most ${MAX_LIST_ELEMENTS} entries (got ${params.orderBy.length})`);
    }
    const seen = new Set<string>();
    for (const ob of params.orderBy) {
      if (!Object.hasOwn(schema.fields, ob.field)) {
        throw new QueryValidationError(`unknown field in orderBy: ${ob.field}`);
      }
      if (seen.has(ob.field)) throw new QueryValidationError(`duplicate field in orderBy: ${ob.field}`);
      seen.add(ob.field);
      const dirKey = ob.dir ?? "asc";
      if (!Object.hasOwn(DIRS, dirKey)) {
        throw new QueryValidationError(`invalid orderBy dir: ${String(ob.dir)} (allowed: asc, desc)`);
      }
      orderParts.push(`"${ob.field}" ${DIRS[dirKey]}`);
      if (ob.field === "id") idOrdered = true;
    }
  } else if (schema.primaryTime) {
    orderParts.push(`"${schema.primaryTime}" desc`);
  }
  if (!idOrdered) orderParts.push(`"id" asc`);

  // Drill-through linkage projection: with includeShadowed on a serveDeduped sector, append the
  // table's READ-ONLY linkage columns (hardcoded in DEDUP_LINKAGE_COLS — never agent input, never
  // REGISTRY fields) AFTER the validated select, so every returned row carries its shadow linkage.
  // The default path (param absent/false) appends nothing — byte-identical SQL to before.
  const linkage =
    schema.serveDeduped && params.includeShadowed === true && Object.hasOwn(DEDUP_LINKAGE_COLS, schema.table)
      ? DEDUP_LINKAGE_COLS[schema.table]
      : [];
  // Provenance projection (#65/#122): with includeProvenance, project the row's own `connection_id`
  // under an INTERNAL alias — a HARDCODED table fact (every domain table carries the column; the
  // db/schema.sql template mandates it), never agent input, and deliberately NOT a REGISTRY field, so
  // this adds a served column WITHOUT widening the filter vocabulary or the ingest write allow-list.
  // On a serveDeduped table `source_object_id` rides along under a second alias: merged-ness is read
  // off the RESERVED `union:` namespace, the one marker the write path refuses (see UNION_SOID_PREFIX),
  // and never off the provider-writable `dedup_status` column. Both aliases are lifted off the row in
  // attachProvenance. Param absent/false appends nothing — byte-identical SQL to before.
  const provenance: string[] = [];
  if (params.includeProvenance === true) {
    provenance.push(`"connection_id" as "${PROV_CONN_ALIAS}"`);
    if (schema.serveDeduped) provenance.push(`"source_object_id" as "${PROV_SOID_ALIAS}"`);
  }
  const cols = [...[...select, ...linkage].map((f) => `"${f}"`), ...provenance].join(", ");
  // The one-row PROBE that powers has_more: ask Postgres for limit + 1 and trim in query(). Costs
  // exactly one extra row; without it a capped page is indistinguishable from a complete answer.
  values.push(limit + 1);
  let sql = `select ${cols} from "${schema.table}" ${whereSql} order by ${orderParts.join(", ")} limit $${values.length}`;

  if (params.offset !== undefined) {
    if (!Number.isInteger(params.offset) || params.offset < 0) {
      throw new QueryValidationError(`offset must be an integer >= 0 (capped at ${MAX_OFFSET})`);
    }
    values.push(Math.min(params.offset, MAX_OFFSET));
    sql += ` offset $${values.length}`;
  }

  return { sql, values };
}

/** Aggregate mode: group columns + the aggregate under AGG_ALIAS; group/order by ORDINALS only. */
function buildAggregateSelect(
  schema: SectorSchema,
  params: QueryParams,
  whereSql: string,
  limit: number,
  values: unknown[],
): { sql: string; values: unknown[] } {
  // Cross-field exclusions live HERE, not in edge zod (a ZodRawShape cannot express them).
  if (params.select !== undefined) throw new QueryValidationError(`select cannot be combined with aggregate`);
  if (params.orderBy !== undefined) {
    throw new QueryValidationError(`orderBy cannot be combined with aggregate (groups are ordered by the aggregate value desc)`);
  }
  if (params.offset !== undefined) throw new QueryValidationError(`offset cannot be combined with aggregate`);
  // Provenance is PER ROW; a group is not a row. Rejected on PRESENCE (even false), like the three
  // above — never a silent no-op. "Rows per provider" is a real want and is NOT served here: it would
  // need connection_id in the groupBy vocabulary, i.e. inside the ingest write allow-list. Group by
  // the sector's own columns, or page the rows and count their provenance.
  if (params.includeProvenance !== undefined) {
    throw new QueryValidationError(
      `includeProvenance cannot be combined with aggregate (provenance is per-row; a group has no single source connection)`,
    );
  }

  const agg = params.aggregate as Aggregate;
  if (!Object.hasOwn(AGG_FNS, agg.fn)) {
    throw new QueryValidationError(`unsupported aggregate fn: ${String(agg.fn)} (allowed: count, sum, avg, min, max)`);
  }
  const fnSql = AGG_FNS[agg.fn];

  let aggExpr: string;
  if (agg.fn === "count") {
    if (agg.field !== undefined) throw new QueryValidationError(`count takes no field (it counts rows)`);
    aggExpr = `count(*)`;
  } else {
    if (agg.field === undefined) throw new QueryValidationError(`aggregate fn ${agg.fn} requires a field`);
    if (!Object.hasOwn(schema.fields, agg.field)) {
      throw new QueryValidationError(`unknown field in aggregate: ${agg.field}`);
    }
    const fieldType = schema.fields[agg.field];
    if (fieldType !== "numeric") {
      throw new QueryValidationError(`aggregate fn ${agg.fn} requires a numeric field; "${agg.field}" is ${fieldType}`);
    }
    aggExpr = `${fnSql}("${agg.field}")`;
  }

  const groupCols = agg.groupBy ?? [];
  if (groupCols.length > MAX_LIST_ELEMENTS) {
    throw new QueryValidationError(`groupBy allows at most ${MAX_LIST_ELEMENTS} fields (got ${groupCols.length})`);
  }
  const seenGroups = new Set<string>();
  for (const g of groupCols) {
    if (!Object.hasOwn(schema.fields, g)) throw new QueryValidationError(`unknown field in groupBy: ${g}`);
    if (seenGroups.has(g)) throw new QueryValidationError(`duplicate field in groupBy: ${g}`);
    seenGroups.add(g);
  }

  // Group columns first, the aggregate last under the internal alias. GROUP BY / ORDER BY use ordinal
  // positions only (the aggregate desc, then group ordinals asc) — never the alias name (ambiguity).
  const cols = [...groupCols.map((g) => `"${g}"`), `${aggExpr} as "${AGG_ALIAS}"`].join(", ");
  let sql = `select ${cols} from "${schema.table}" ${whereSql}`;
  if (groupCols.length > 0) sql += ` group by ${groupCols.map((_, i) => i + 1).join(", ")}`;
  const ordinals = [`${groupCols.length + 1} desc`, ...groupCols.map((_, i) => `${i + 1} asc`)];
  sql += ` order by ${ordinals.join(", ")}`;
  // Same probe in aggregate mode — a truncated GROUP list is the same lie as a truncated row list.
  values.push(limit + 1); // caps the GROUP count in aggregate mode (+1 = the has_more probe)
  sql += ` limit $${values.length}`;

  return { sql, values };
}

/**
 * Build the parameterized SELECT for a query — rows or aggregate mode. table/column names come only
 * from the REGISTRY (never agent input); ops/dirs/fns resolve through runtime whitelists to hardcoded
 * SQL; all values are parameterized; results are capped at MAX_LIMIT. TWO clauses are NON-NEGOTIABLE
 * in every generated statement, rows and aggregate alike: the `user_id` scope (a query can never
 * reach another user's rows) and `"deleted_at" is null` (a source-removed object is never served —
 * ADR 0004; getRecord stays unfiltered as the truthful drill). Extracted so both are unit-testable
 * without a DB.
 *
 * Returns `rowLimit` = the EFFECTIVE cap the caller asked for (rows: the row cap; aggregate: the
 * group cap). The emitted SQL asks for `rowLimit + 1` — the one-row probe query() trims back off to
 * decide `has_more`. Callers that only destructure {sql, values} keep working unchanged.
 */
export function buildSelect(
  ctx: AuthContext,
  params: QueryParams,
): { sql: string; values: unknown[]; rowLimit: number } {
  if (!Object.hasOwn(REGISTRY, params.sector)) {
    throw unknownSectorError(params.sector);
  }
  const schema = REGISTRY[params.sector];

  const values: unknown[] = [];
  const clauses = buildWhere(schema, params.where, values);

  // Always scope to the caller's user and exclude tombstones. Never optional, never agent-supplied;
  // both apply BEFORE grouping in aggregate mode.
  values.push(ctx.userId);
  clauses.push(`"user_id" = $${values.length}`);
  clauses.push(`"deleted_at" is null`);
  // Cross-provider dedup (#34b, ADR 0021): on a serveDeduped sector (finance only), serve the synthetic
  // winner / single-provider rows and HIDE the shadowed reals with ONE reversible predicate — uniform
  // across rows AND aggregate (so sum() totals never double-count). A non-dedup sector emits no clause and
  // never references the column (byte-for-byte unchanged). Inherited by buildAggregateSelect's whereSql.
  // Drill-through (finance-dedup-trust-batch): `includeShadowed` OMITS the predicate — rows AND
  // aggregate alike (opt-in semantics; see the QueryParams jsdoc). On a non-dedup sector the param's
  // PRESENCE (even false) is a typed 400 naming the field — never a silent no-op.
  if (params.includeShadowed !== undefined && !schema.serveDeduped) {
    throw new QueryValidationError(
      `includeShadowed is not valid on sector "${params.sector}" (only dedup-served sectors: finance.account, finance.transaction, finance.holding)`,
    );
  }
  if (schema.serveDeduped && params.includeShadowed !== true) clauses.push(`"shadowed_by_id" is null`);
  const whereSql = `where ${clauses.join(" and ")}`;

  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new QueryValidationError(`limit must be an integer >= 1 (capped at ${MAX_LIMIT})`);
  }
  const limit = Math.min(params.limit ?? 100, MAX_LIMIT);

  const built = params.aggregate
    ? buildAggregateSelect(schema, params, whereSql, limit, values)
    : buildRowsSelect(schema, params, whereSql, limit, values);
  return { ...built, rowLimit: limit };
}

/**
 * Resolve the served rows' provenance and swap the internal aliases for one `__provenance` key.
 *
 * ONE extra bounded query per read (never per row), and only when rows were actually served: the
 * distinct connection ids of a page are at most the user's connection count. It reads `connectors`
 * only — never a domain table, never another user's row — and is scoped THREE ways:
 *   - `user_id` = the caller: a domain row is already user-scoped, but a row whose connection_id
 *     points at ANOTHER user's connector must resolve to null, never to that user's provider.
 *   - `sector` = the sector being read: assertSector already granted THIS sector; resolving outside it
 *     would let a caller learn "you have a google connection in contacts" from a calendar read. Rows
 *     never legitimately cross that line (applyRecords writes each record into its connection's own
 *     sector), so the clause costs nothing and fails closed if one ever does.
 *   - the ids come from the already-user-scoped, tombstone-filtered page — never from caller input.
 * A row it cannot resolve keeps its connection_id and reports `provider: null`.
 */
async function attachProvenance(
  ctx: AuthContext,
  sector: string,
  schema: SectorSchema,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  /** Merged ⟺ a serveDeduped table's row sits in the reserved (provider-unforgeable) soid namespace. */
  const isMerged = (row: Record<string, unknown>): boolean => {
    if (schema.serveDeduped !== true) return false;
    const soid = row[PROV_SOID_ALIAS];
    return typeof soid === "string" && soid.startsWith(UNION_SOID_PREFIX);
  };

  const wanted = new Set<string>();
  for (const row of rows) {
    const id = row[PROV_CONN_ALIAS];
    if (!isMerged(row) && typeof id === "string") wanted.add(id);
  }
  const providerById = new Map<string, string>();
  if (wanted.size > 0) {
    const res = await pool.query(
      `select id, provider from connectors where user_id = $1 and sector = $2 and id = any($3)`,
      [ctx.userId, sectorOf(sector), [...wanted]],
    );
    for (const r of res.rows) providerById.set(r.id as string, r.provider as string);
  }

  return rows.map((row) => {
    const merged = isMerged(row);
    const raw = row[PROV_CONN_ALIAS];
    const connectionId = !merged && typeof raw === "string" ? raw : null;
    const served = { ...row };
    // The aliases are internal plumbing: they leave with the row shape they arrived in, never in it.
    delete served[PROV_CONN_ALIAS];
    delete served[PROV_SOID_ALIAS];
    const provenance: RowProvenance = {
      connection_id: connectionId,
      provider: connectionId === null ? null : providerById.get(connectionId) ?? null,
      merged,
    };
    return { ...served, [PROVENANCE_FIELD]: provenance };
  });
}

/**
 * Structured read over a single sector. NO cross-sector joins.
 * Denies an ungranted sector BEFORE any SQL (assertSector is the first statement), then runs the
 * user-scoped, tombstone-filtered SELECT built by buildSelect.
 *
 * Rows mode returns { sector, object, count, has_more, rows } (deterministically ordered). Aggregate
 * mode returns { sector, object, aggregate: { fn, field? }, count, has_more, groups } where each
 * group is { group: Record<string, unknown>, value }; with no groupBy, groups is exactly
 * [{ group: {}, value }].
 * Wire types — value is number | string | null: count -> JSON number; sum/avg/min/max -> pg numeric
 * decimal STRING (precision-safe), or null (SQL NULL) when the aggregated set is empty.
 *
 * `count` means "items in THIS response" and never a total (a total needs a second COUNT(*) — #84).
 * `has_more: true` means the cap trimmed the answer: it is derived from the probe row buildSelect
 * asked for, NOT from `count === limit` (an exactly-full final page must read has_more: false).
 */
export async function query(ctx: AuthContext, params: QueryParams) {
  assertSector(ctx, params.sector);
  if (!Object.hasOwn(REGISTRY, params.sector)) {
    throw unknownSectorError(params.sector);
  }
  const schema = REGISTRY[params.sector];

  // L7 instrumentation: time the read off the hot path. `rows` is unknown until the SELECT lands, so
  // the fn stamps it onto `meta` before resolving (timed reads meta post-resolution).
  const meta: Record<string, unknown> = {
    sector: params.sector,
    mode: params.aggregate ? "aggregate" : "rows",
    rows: 0,
  };
  return timed("query", meta, async () => {
    const { sql, values, rowLimit } = buildSelect(ctx, params);
    const res = await pool.query(sql, values);
    // The probe: SQL asked for rowLimit + 1, so anything beyond the cap means there IS more. Trim it
    // off before anything else touches the rows — the caller must never see the probe row.
    const hasMore = res.rows.length > rowLimit;
    const served = hasMore ? res.rows.slice(0, rowLimit) : res.rows;

    if (params.aggregate) {
      const { fn, field } = params.aggregate;
      // Lift the internal alias out of each row: group columns nest under `group`, the aggregate
      // becomes `value` (count coerced to a JS number; the rest stay pg decimal strings, or null —
      // SQL NULL — when sum/avg/min/max aggregated an empty set).
      const groups = served.map((row: Record<string, unknown>) => {
        const { [AGG_ALIAS]: value, ...group } = row;
        return { group, value: fn === "count" ? Number(value) : value };
      });
      meta.rows = groups.length; // the TRIMMED count — the L7 line never reports the probe row
      return {
        sector: params.sector,
        object: schema.object,
        aggregate: field === undefined ? { fn } : { fn, field },
        count: groups.length,
        has_more: hasMore,
        groups,
      };
    }

    // Provenance is resolved AFTER the probe trim, so the dropped probe row never costs a lookup and
    // never influences the id set. Off (absent/false) → `served` is passed through untouched.
    const rows =
      params.includeProvenance === true
        ? await attachProvenance(ctx, params.sector, schema, served as Array<Record<string, unknown>>)
        : served;

    meta.rows = rows.length;
    return {
      sector: params.sector,
      object: schema.object,
      count: rows.length,
      has_more: hasMore,
      rows,
    };
  });
}
