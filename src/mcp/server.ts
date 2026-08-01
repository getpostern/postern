import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSchema } from "../core/schema.js";
import { query } from "../core/query.js";
import { describeContext, getRecord, fetchLive } from "../core/context.js";
import { listActions, invokeAction } from "../core/actions.js";
import { AccessDenied, sectorOf, type AuthContext } from "../auth/index.js";

/**
 * Resolve *who is asking* for a given tool call. The SDK hands the handler an `extra` object
 * (carries `sessionId`, `requestId`); the resolver maps it to the session's cached AuthContext.
 * stdio injects `() => resolveLocal()` (the operator); HTTP injects the bearer-session resolver.
 * extra is `unknown` because the resolver only reads fields the edge controls.
 */
export type CtxResolver = (extra: unknown) => Promise<AuthContext>;

/** One audit line, fired at the edge for every tool call (allow + outcome, or deny). Fire-and-forget. */
export type EdgeAudit = (e: {
  userId: string | null;
  agentId: string | null;
  tool:
    | "describe_context"
    | "get_schema"
    | "query"
    | "get_record"
    | "fetch_live"
    | "list_actions"
    | "invoke_action"
    | "initialize"; // session-init denials at the HTTP edge (mcp-auth-bridge; throttled there)
  sector?: string | null;
  decision: "allow" | "deny";
  denyReason?: string | null;
  /** The (raw) tool params for forensic attribution — redacted + size-capped centrally in audit(). */
  args?: unknown;
  resultCount?: number | null;
  outcome?: "ok" | "error" | null;
  requestId?: string | null;
}) => void;

type EdgeTool = Parameters<EdgeAudit>[0]["tool"];

interface ServerDeps {
  resolveCtx: CtxResolver;
  audit: EdgeAudit;
}

/** The SDK tool-handler context we read: sessionId is set on HTTP sessions, requestId is always present. */
interface ToolExtra {
  sessionId?: string;
  requestId?: string | number;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function requestIdOf(extra: unknown): string | null {
  const id = (extra as ToolExtra | undefined)?.requestId;
  return id == null ? null : String(id);
}

/**
 * The audit-at-the-edge wrapper. Resolve the session's ctx (once-per-session is enforced by the
 * resolver), run the core fn with that ctx, then fire ONE audit line — never awaited, off the
 * response path. On AccessDenied: audit `deny` (denyReason = error message) then rethrow so the SDK
 * returns the error to the agent; the bearer is never part of any audit field.
 *
 * `meta` carries the dims known UP FRONT (before `fn` runs): the call's `sector` and raw `args`. A
 * throw skips `fn`'s return, so these must come from `meta` for the error/deny branches to record
 * them — that's what closes #10 (an errored read used to log sector=NULL) and feeds #9 (`args` on
 * every branch, including deny). `fn` still returns `{ result, sector?, resultCount?, outcome? }` for
 * the success line: `outcome` threads a connector-reported failure (ActionResult.ok:false); reads
 * omit it and keep recording 'ok'. `args` is passed RAW — redaction is central in audit().
 */
async function withEdge<T>(
  deps: ServerDeps,
  tool: EdgeTool,
  extra: unknown,
  meta: { sector?: string | null; args?: unknown },
  fn: (ctx: AuthContext) => Promise<{
    result: T;
    sector?: string | null;
    resultCount?: number | null;
    outcome?: "ok" | "error";
  }>,
): Promise<T> {
  const requestId = requestIdOf(extra);
  let ctx: AuthContext | undefined;
  try {
    ctx = await deps.resolveCtx(extra);
    const { result, sector, resultCount, outcome } = await fn(ctx);
    deps.audit({
      userId: ctx.userId,
      agentId: ctx.agentId,
      tool,
      sector: sector ?? null,
      decision: "allow",
      args: meta.args,
      resultCount: resultCount ?? null,
      outcome: outcome ?? "ok",
      requestId,
    });
    return result;
  } catch (e) {
    if (e instanceof AccessDenied) {
      // `reason` (credential vocabulary: unknown agent/revoked/expired) feeds denyReason and is
      // NEVER written into the sector column — sector stays a sector (mcp-auth-bridge deconflation).
      deps.audit({
        userId: ctx?.userId ?? null,
        agentId: ctx?.agentId ?? null,
        tool,
        sector: e.sector ?? meta.sector ?? null,
        decision: "deny",
        denyReason: e.reason ?? e.message,
        args: meta.args,
        requestId,
      });
    } else {
      // #10: record the up-front sector (the core fn never returned it) so an errored read is
      // attributable instead of sector=NULL; #9: carry the raw args here too.
      deps.audit({
        userId: ctx?.userId ?? null,
        agentId: ctx?.agentId ?? null,
        tool,
        sector: meta.sector ?? null,
        decision: "allow",
        outcome: "error",
        args: meta.args,
        requestId,
      });
    }
    throw e;
  }
}

/**
 * The server's self-introduction, delivered once in the `initialize` result and resident in the
 * agent's context for the whole session. Everything universal belongs HERE or in a tool description,
 * never repeated per object: static text costs zero response tokens, a repeated per-row fact costs
 * them on every call. Exported ONLY so a test can assert its content.
 */
export const POSTERN_INSTRUCTIONS =
  "Postern is this person's personal context gateway: one authenticated surface over the sectors of their life " +
  "(finance, health, mail, contacts, calendar, home). Reads are served from a local cache in milliseconds; " +
  "`fetch_live` is the only path that touches a source at read time. Start with `describe_context` (what you are " +
  "granted, and each connection's freshness), then `get_schema` for the object you want — read its `notes` and " +
  "`fieldDocs` before composing any filter or aggregate; they carry sign conventions and unit traps that the types " +
  "do not. `query` reads ONE sector: there are no cross-sector joins, so fan out and correlate yourself. Responses " +
  "are capped — `has_more: true` means you are looking at a page, not an answer. `list_actions` / `invoke_action` " +
  "act on a source; a granted sector covers both reading and acting. Never assume a field's meaning from its name.";

/**
 * The MCP adapter: tools map 1:1 onto the core functions. No business logic lives here — the only
 * additions are (1) the injected ctx-resolver, so `ctx` comes from the session (operator over stdio,
 * bearer→grants over HTTP) instead of a hardcoded resolveLocal(), and (2) the audit-at-the-edge
 * wrapper, so every tool call is logged (allow/deny/outcome).
 */
export function buildServer(deps: { resolveCtx: CtxResolver; audit: EdgeAudit }): McpServer {
  // `name` is the wire identity an MCP client displays (serverInfo in the initialize result). It is
  // display-only — clients key their config by a user-chosen alias — so this is the ONE place the
  // pre-Postern codename had to go; package.json, the export manifest and the log prefixes stay.
  const server = new McpServer(
    { name: "postern", version: "0.0.1" },
    { instructions: POSTERN_INSTRUCTIONS },
  );

  server.registerTool(
    "describe_context",
    {
      description:
        "What you can reach. `sectors` is the list of sectors you are GRANTED — a granted sector may have NO connection at all, so always check `connections` before concluding a source exists. Each connection carries `connection_id` (use it to name the source to the user), a best-effort `label` (the institution or account name, null when unknown), its sync mode (push|poll|on_demand) and a server-derived freshness tuple {state, last_heard_at, next_expected_at, stream_state, error}. state is ok|syncing|stale|unreachable|error|paused|disconnected|never_synced — trust it over raw timestamps: 'unreachable' means a push stream is down/retrying (the cache is aging even though the connection looks active); 'stale' means past the mode's expectation. Non-active connections (error/syncing/paused) ARE listed so a broken source is visible instead of vanishing; only revoked ones are omitted. Use mode + freshness to decide cache-vs-fetch_live: a push connection with state 'ok' is already live (skip fetch_live); poll/on_demand connections go stale between syncs. Plaid connections also carry health {status: ok|action_required|transient|dead, consentExpiresAt}: status='action_required' means the bank link is broken and the cache is stale even though last_synced_at advanced — prompt the operator to reconnect; non-Plaid connections carry health: null.",
      inputSchema: {},
    },
    async (_args, extra) =>
      // describe_context takes no params → no args to record (#9).
      withEdge(deps, "describe_context", extra, {}, async (ctx) => {
        const result = await describeContext(ctx);
        return { result: text(result), resultCount: result.sectors.length };
      }),
  );

  server.registerTool(
    "get_schema",
    {
      description:
        "The queryable objects and fields per sector — the contract query() validates against. " +
        "Each object carries `notes` and each field may carry a `fieldDocs` entry: authored semantics you MUST read before filtering or aggregating, because they state the sign conventions, enums and unit traps the types cannot. " +
        "Rules that hold everywhere, so they are stated once here instead of per field: `id` is the Postern row uuid (use it with get_record / fetch_live) while `source_object_id` is the provider's own id; timestamps are ISO-8601 UTC; sum/avg/min/max return precision-safe decimal STRINGS and count returns a number; rows the source deleted are excluded from query but still readable via get_record; `raw` is the untouched provider payload and may use different names, units and SIGNS than the normalized columns.",
      inputSchema: { sector: z.string().optional() },
    },
    async ({ sector }, extra) =>
      withEdge(deps, "get_schema", extra, { sector: sector ?? null, args: { sector } }, async (ctx) => {
        // An agent's view = its grants: keep only REGISTRY keys whose sector is granted.
        const full = getSchema(sector);
        const filtered = Object.fromEntries(
          Object.entries(full).filter(([key]) => ctx.grantedSectors.has(sectorOf(key))),
        );
        return { result: text(filtered), sector: sector ?? null, resultCount: Object.keys(filtered).length };
      }),
  );

  server.registerTool(
    "query",
    {
      description:
        "Structured read over ONE sector, served from the cache. Fields are validated against the published schema and results are capped at 500. No cross-sector joins — fan out and correlate on the agent side. " +
        "select narrows the projected columns (default = all flat fields). It MAY also include a sector's jsonb columns — `raw` on every sector, plus `attendees` (calendar) / `attributes` (home) — to read a row AND its raw detail in ONE call instead of a get_record follow-up. Projection only: jsonb stays non-filterable, so where/orderBy/aggregate/groupBy accept flat fields only. raw is opt-in (omitted by default to keep payloads lean). " +
        "where: {field: value} matches equality; {field: null} (or {eq: null}) matches IS NULL; per-field operators are eq, neq, gt, gte, lt, lte, in, contains. " +
        "neq is null-INCLUSIVE (rows where the field is null DO match neq: 'X'); {neq: null} = IS NOT NULL. in takes up to 200 scalars ([] matches nothing). contains is case-insensitive substring match, text fields only. " +
        "Rows are ordered primaryTime desc with id asc as the tiebreak by default; override with orderBy ([{field, dir: 'asc'|'desc'}]). Ordering is deterministic within a snapshot, but offset pages may shift as sync lands rows — deep paging is unsupported (offset caps at 5000), narrow with where instead. " +
        "aggregate ({fn: count|sum|avg|min|max, field?, groupBy?}) computes server-side over the filtered rows and returns {aggregate, count, groups: [{group, value}]} — groups ordered by value desc, limit caps the group count (default 100). count needs no field and returns a JSON number; sum/avg/min/max need a numeric field and return precision-safe decimal STRINGS. aggregate cannot be combined with select, orderBy, or offset. " +
        "Money is SIGNED and negative means money OUT: to total spending filter amount < 0 and negate the sum — a plain sum(amount) nets income against spending and is the most common wrong answer here; get_schema's fieldDocs carry the per-field rule. " +
        "has_more: true means the cap trimmed this result — narrow with where or page with offset; count is what THIS response holds, never a total, so prefer aggregate: {fn: 'count'} over counting a returned page. " +
        "includeShadowed (finance sectors only) is the dedup drill-through: cross-provider duplicates are normally served as ONE merged winner row with the underlying provider rows hidden; includeShadowed: true reveals those pristine provider rows too, with read-only linkage columns appended per row (shadowed_by_id — null on served winners, set on hidden duplicates — plus dedup_group_id on accounts/holdings) so winner and members can be tied together. Aggregates with includeShadowed include the shadowed duplicates (totals may double-count — by design, it is a drill). On a non-finance sector the param is a 400.",
      inputSchema: {
        sector: z.string(),
        where: z.record(z.any()).optional(),
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
        includeShadowed: z.boolean().optional(),
      },
    },
    async (args, extra) =>
      // #10: sector is known up front (a required param) → recorded even if query() throws. #9: the
      // whole DSL is the args.
      withEdge(deps, "query", extra, { sector: args.sector, args }, async (ctx) => {
        const result = await query(ctx, args);
        return { result: text(result), sector: args.sector, resultCount: result.count ?? null };
      }),
  );

  server.registerTool(
    "get_record",
    {
      description:
        "Fetch one raw source record by id (drill past the normalized view). A non-null `deleted_at` means the source has removed this object; the row is retained for drill-down but excluded from query(). " +
        "Multi-object sectors require the full dotted key — finance.transaction, not finance. `id` is the Postern row uuid: an id that is not one returns null rather than an error.",
      inputSchema: { sector: z.string(), id: z.string() },
    },
    async ({ sector, id }, extra) =>
      withEdge(deps, "get_record", extra, { sector, args: { sector, id } }, async (ctx) => {
        const result = await getRecord(ctx, sector, id);
        return { result: text(result), sector, resultCount: result == null ? 0 : 1 };
      }),
  );

  server.registerTool(
    "fetch_live",
    {
      description:
        "The one read-time upstream path — opt-in and bounded; query/get_record stay cache-only. " +
        "Without id: trigger a sync-now of every active poll/on_demand connection in the sector and wait up to 30s for it to land; the response's connections[] carries each connection's POST-sync freshness tuple. Push connections have no pull to run, but their stream truth is reported honestly: a push stream that is down/retrying appends an attributed entry to errors[] and forces synced:false — reconnect the source instead of retrying fetch_live. timed_out:true means we stopped WAITING, not that the sync was cancelled — it continues in the background; re-check describe_context. Concurrent calls are not deduplicated (syncs are idempotent). " +
        "With id: fetch THAT cached record live from its own source connection and return the raw provider payload — record:null means the source says the object is gone (the cache is tombstoned to match). Multi-object sectors require the dotted key with id (e.g. finance.transaction, not finance). Live fetches for footprint-limited sectors (mail bodies) are returned, never stored.",
      inputSchema: { sector: z.string(), id: z.string().optional() },
    },
    async ({ sector, id }, extra) =>
      withEdge(deps, "fetch_live", extra, { sector, args: { sector, id } }, async (ctx) => {
        const result = await fetchLive(ctx, sector, { id });
        return { result: text(result), sector };
      }),
  );

  server.registerTool(
    "list_actions",
    {
      description:
        "The actions a connector can perform on a source (the write analog of get_schema). Empty for read-only sectors. " +
        "Narrow before you read: `domain` is the cheapest filter (it matches home.domain — light, lock, climate, …), then `area`, then `entity_id` for one device. " +
        "The response is {actions, count, truncated}: count is what THIS response holds and truncated: true means the cap cut the catalog — narrow the filter rather than raising `limit` (default 100, max 500), because the cut is taken off an id-sorted list and can drop a whole trailing domain.",
      inputSchema: {
        sector: z.string().optional(),
        area: z.string().optional(),
        domain: z.string().optional(),
        entity_id: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ sector, area, domain, entity_id, limit }, extra) =>
      withEdge(
        deps,
        "list_actions",
        extra,
        { sector: sector ?? null, args: { sector, area, domain, entity_id, limit } },
        async (ctx) => {
          // entity_id → entityId is the ONE mapping between the wire name and the connector seam;
          // dropping it silently disables filtering instead of failing.
          const result = await listActions(ctx, sector, { area, domain, entityId: entity_id, limit });
          return { result: text(result), sector: sector ?? null, resultCount: result.count };
        },
      ),
  );

  // The ONE action entry point — MCP, REST and CLI alike. Per-action typed MCP tools at connect were
  // considered and dropped (context saturation; ADR 0003): the dynamic cache-served catalog answers
  // list_actions in ms, and the generic invoke_action carries the single live dispatch.
  server.registerTool(
    "invoke_action",
    {
      description:
        "Perform a declared action on a source. Action ids are sector-namespaced and come from list_actions — home.light.turn_on, home.lock.lock — never guess one. " +
        "Params carry the target as an explicit id or a structured selector (area/domain/name) that is resolved against the cache server-side, so 'the kitchen light' is one call. " +
        "Gated by the domain grant (a granted sector covers reading and acting) and logged asynchronously, off the response path. " +
        "Params are passed to the source AS GIVEN — the gateway does not type-check them, so a malformed param surfaces as the source's own error in `detail`. Discover ids and their params with list_actions.",
      inputSchema: { action_id: z.string(), params: z.record(z.any()).optional() },
    },
    async ({ action_id, params }, extra) =>
      // #9: the action target + params are the args (a token in service_data is redacted in audit()).
      withEdge(deps, "invoke_action", extra, { args: { action_id, params } }, async (ctx) => {
        const result = await invokeAction(ctx, action_id, params ?? {});
        // Thread the connector-reported result into the audit line: ok:false → outcome 'error'.
        return { result: text(result), outcome: result.ok ? ("ok" as const) : ("error" as const) };
      }),
  );

  return server;
}
