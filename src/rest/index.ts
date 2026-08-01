// REST edge — the HTTP API behind the Console + a non-MCP harness path. Four surfaces wired onto
// one Node `http` server via a minimal router:
//   1. Admin (operator-local-trusted): credential/connector onboarding, agent keys + grants, audit.
//   2. OAuth: first-party PKCE consent (start + callback) -> sealed first-party credential.
//   3. Agent read-mirror (bearer-gated + audited): the five core reads, 1:1 over HTTP.
//   4. Operator read-mirror (loopback, #89): the reads the Console cannot reach on (3) because it
//      holds no agent key — `/api/data/*`, `/api/actions`, `/api/operator/*`. Same core functions,
//      same AuthContext discipline, resolveLocal() instead of a bearer (src/rest/mirror.ts §2).
//
// The admin + OAuth + operator surfaces carry NO per-request auth — the server binds 127.0.0.1 by
// default, so reaching them implies operator trust. The agent mirror enforces a bearer on every call.
// Audit is INJECTED (never imported) and fired off the response path; secrets/tokens are never
// returned/logged.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, readJson, sendJson, errorToStatus, type RouteContext } from "./router.js";
import { localOnly } from "./host-allowlist.js";
import { serveStatic } from "./static.js";
import { pool } from "../db.js";
import {
  mintAgentKey,
  mintWebhookSecret,
  postCredential,
  postConnector,
  postAppleOnboard,
  postAgent,
  listAgents,
  patchAgent,
  revokeAgent,
  deleteAgent,
  getAudit,
  deleteConnectorRoute,
} from "./admin.js";
import {
  listConnectorsEnrichedRoute,
  connectionDetailRoute,
  pauseRoute,
  resumeRoute,
  syncNowRoute,
  revokeCredentialRoute,
  setSyncWindowRoute,
  setSyncIntervalRoute,
} from "./lifecycle-routes.js";
import { eraseRoute } from "./erase-routes.js";
import { exportRoute } from "./export-routes.js";
import { dataQueryRoute, dataRecordRoute } from "./data-routes.js";
import {
  financeBanksRoute,
  financeDedupCandidatesRoute,
  financeDedupConfirmRoute,
  financeDedupUnconfirmRoute,
} from "./finance-routes.js";
import { oauthStart, oauthCallback, oauthAppStatus, oauthAppSet, oauthAppDelete } from "./oauth-routes.js";
import {
  postPlaidLinkToken,
  postPlaidExchange,
  getPlaidAppRoute,
  setPlaidAppRoute,
  deletePlaidAppRoute,
  postPlaidHostedLink,
  postPlaidPoll,
  postPlaidRelink,
} from "./plaid-routes.js";
import { getExposureRoute, setExposureRoute, clearExposureRoute } from "./exposure-routes.js";
import { ingestPush } from "./ingest.js";
import {
  mirrorContext,
  mirrorSchema,
  mirrorQuery,
  mirrorGetRecord,
  mirrorFetchLive,
  operatorContext,
  operatorSchema,
  operatorFetchLive,
} from "./mirror.js";
import { actionCatalogRoute } from "./actions-routes.js";

export { mintAgentKey };

/**
 * The audit entry shape the edge emits for every mirror read. INJECTED via RestDeps — this unit has
 * no build-dependency on audit-writer. `decision` is 'allow' on a served read, 'deny' on an
 * AccessDenied. The hook is fired off the response path and never awaited.
 */
export type AuditHook = (entry: {
  userId: string | null;
  agentId: string | null;
  tool: "describe_context" | "get_schema" | "query" | "get_record" | "fetch_live";
  sector?: string | null;
  decision: "allow" | "deny";
  denyReason?: string | null;
  args?: unknown;
  resultCount?: number | null;
  requestId?: string | null;
}) => void;

export interface RestDeps {
  audit?: AuditHook;
  /**
   * Root dir for the built Console served same-origin on a non-/api GET miss. Default: `apps/web/dist`
   * resolved relative to THIS MODULE (see defaultStaticDir), overridable with `PCI_CONSOLE_DIR`.
   */
  staticDir?: string;
}

/** Default bind: loopback only — the admin + OAuth surfaces are operator-local-trusted. */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

// ── Console assets: where the built SPA lives ───────────────────────────────────

/** This module's own directory: `<root>/src/rest` under tsx, `<root>/dist/rest` under node. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The env override: an absolute (or cwd-relative) path to a built Console. Empty string = unset. */
const CONSOLE_DIR_ENV = "PCI_CONSOLE_DIR";

/**
 * Where the built Console lives, resolved RELATIVE TO THIS MODULE — never to the process cwd.
 *
 * This was the literal `"apps/web/dist"`, a cwd-relative path, which is only correct when the
 * process happens to be started from the repository/image root. `node dist/index.js` run from
 * anywhere else (a systemd unit with a different WorkingDirectory, `cd /` then start, an operator
 * running the compiled server by hand) resolved it against that other directory, found nothing, and
 * served a JSON 404 for every browser request — the API healthy, the Console simply absent, and no
 * message anywhere saying why. Both real layouts put the build exactly two levels up from this
 * module (`<root>/dist/rest` -> `<root>/apps/web/dist`; `<root>/src/rest` -> the same), so anchoring
 * on `import.meta.url` makes the answer independent of where the process was launched. Same idiom as
 * `migrationsDir()` in src/db/migrate.ts, and for the same reason.
 *
 * `PCI_CONSOLE_DIR` overrides it for anyone serving a Console built somewhere else.
 *
 * Exported so the cwd-independence can be asserted directly: the property that matters is that two
 * calls from two different working directories return the SAME path, and nothing observable from
 * outside this module can show that otherwise.
 */
export function defaultStaticDir(): string {
  const override = process.env[CONSOLE_DIR_ENV];
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.resolve(MODULE_DIR, "..", "..", "apps", "web", "dist");
}

/** One line per process, at most — a reloading browser must not turn a diagnostic into a flood. */
let missingConsoleReported = false;

/**
 * Say ONCE that the Console assets are not where we looked. Without it the failure is completely
 * silent: the API answers, /healthz is green, and the browser gets `{"error":"not found"}` with
 * nothing in the logs to connect it to a missing or mislocated build.
 *
 * Called on a REAL MISS, not at mount, and that placement is deliberate on two counts. It fires at
 * the moment the problem actually exists — someone asked for the Console and there is none — so it
 * can name the request that failed instead of a hypothetical one, and it self-corrects if the build
 * appears later (the directory is re-checked, not remembered from boot). And mounting the app is not
 * evidence of anything: the REST app is constructed by several test suites that never serve a page,
 * and a scary "Console assets not found" line from an unrelated suite is noise someone will chase.
 *
 * `existsSync` here is the whole discrimination: a missing DIRECTORY is a packaging problem worth a
 * line, while a missing file inside a present directory is an ordinary 404 that needs no commentary.
 *
 * stderr, not stdout — stdout is the MCP protocol channel and one stray write corrupts every local
 * agent session.
 */
function reportMissingConsole(dir: string, pathname: string): void {
  if (missingConsoleReported) return;
  if (existsSync(dir)) return; // the build is there; this was just a missing file
  missingConsoleReported = true;
  console.error(
    `[pci-gateway] Console assets not found at ${dir} — serving 404 for ${pathname}. The API is ` +
      `fine, but every browser request will 404 until this is fixed. Build the Console ` +
      `(npm run build --prefix apps/web) or set ${CONSOLE_DIR_ENV} to the directory holding its ` +
      `index.html.`,
  );
}

// ── Liveness / readiness draining ───────────────────────────────────────────────
// A single process-wide flag flipped by beginShutdown() at the start of graceful shutdown so an
// in-flight /healthz readiness probe sees 503 and a load balancer drains us BEFORE we tear down.
let shuttingDown = false;

/** Flip /healthz to 503 (readiness drain). Called by the composition root's shutdown(). Idempotent. */
export function beginShutdown(): void {
  shuttingDown = true;
}

/**
 * Liveness + readiness probe (bare — no bearer, no Host-allowlist; a probe must reach it, like the
 * ingest webhook). 503 while shutting down (so the orchestrator drains us first); otherwise a cheap
 * `select 1` proves the DB is reachable → 200, else 503. No internal detail is ever leaked.
 */
async function healthz(ctx: RouteContext): Promise<void> {
  if (shuttingDown) {
    sendJson(ctx.res, 503, { status: "shutting_down" });
    return;
  }
  try {
    await pool.query("select 1");
    sendJson(ctx.res, 200, { status: "ok" });
  } catch {
    sendJson(ctx.res, 503, { status: "unavailable" });
  }
}

/** Build the routing table. Mirror routes receive the injected audit hook; admin/oauth don't. */
function buildRouter(deps: RestDeps): Router {
  const audit = deps.audit;
  const router = new Router();

  // ── Health probe (bare: no bearer, no Host-allowlist — must be probe-reachable) ──
  router.get("/healthz", healthz);

  // ── Admin (local-trusted; no bearer) ── wrapped in localOnly: the no-bearer group enforces a
  //    loopback Host-header allowlist (DNS-rebinding guard), so a rebound evil.com page can't reach
  //    the key-minting/onboarding routes. Not auth — a same-origin guard; rejects non-loopback -> 403.
  router.post("/api/credentials", localOnly((ctx) => withBody(ctx, postCredential)));
  router.post("/api/connectors", localOnly((ctx) => withBody(ctx, postConnector)));
  // Apple / iCloud one-step fan-out (#26): one ASP credential → mail + calendar + contacts connectors.
  router.post("/api/onboard/apple", localOnly((ctx) => withBody(ctx, postAppleOnboard)));
  router.get("/api/connectors", localOnly(listConnectorsEnrichedRoute));
  router.post("/api/agents", localOnly((ctx) => withBody(ctx, postAgent)));
  router.get("/api/agents", localOnly(listAgents));
  router.patch("/api/agents/:agentId", localOnly((ctx) => withBody(ctx, patchAgent)));
  router.post("/api/agents/:agentId/revoke", localOnly(revokeAgent));
  router.delete("/api/agents/:agentId", localOnly(deleteAgent)); // #24 Remove a revoked agent (revoke-then-remove gate)
  router.get("/api/audit", localOnly(getAudit));
  // Mint/rotate the per-connection push-ingest webhook secret — operator-local (Host-guarded), like
  // the rest of admin. (The ingest endpoint the secret gates is registered bare below.)
  router.post("/api/connectors/:connectionId/webhook", localOnly(mintWebhookSecret));

  // ── Data control plane (wave 10, ADR 0012; operator-local — every route localOnly) ──
  //    Lifecycle + status, hard-delete erase, and the portability export. The destructive verbs
  //    (erase/revoke/pause) carry NO per-request auth — the confirm token on /api/erase is a
  //    fat-finger guard, NOT authorization; the loopback Host-allowlist is the ONLY authz here. The
  //    export bundle returns the WHOLE store (unscoped by grant), so it is operator-loopback-only too.
  router.get("/api/connectors/:connectionId", localOnly(connectionDetailRoute));
  router.delete("/api/connectors/:connectionId", localOnly((ctx) => withBody(ctx, deleteConnectorRoute))); // #18 Disconnect (destructive; confirm-token in body)
  router.post("/api/connectors/:connectionId/pause", localOnly(pauseRoute));
  router.post("/api/connectors/:connectionId/resume", localOnly(resumeRoute));
  router.post("/api/connectors/:connectionId/sync", localOnly(syncNowRoute));
  router.post(
    "/api/connectors/:connectionId/sync-window",
    localOnly((ctx) => withBody(ctx, setSyncWindowRoute)),
  ); // wave 12a — set the per-connection mail recency window
  router.post(
    "/api/connectors/:connectionId/sync-interval",
    localOnly((ctx) => withBody(ctx, setSyncIntervalRoute)),
  ); // ADR 0025 — set the per-connection poll cadence (floor-bounded; null = connector default)
  router.post("/api/credentials/:credentialId/revoke", localOnly(revokeCredentialRoute));
  router.post("/api/erase", localOnly((ctx) => withBody(ctx, (c, b) => eraseRoute(c, b, audit))));
  router.get("/api/export", exportRoute); // exportRoute is ALREADY localOnly-wrapped — register directly

  // ── Operator data read (the Console inspector; operator-loopback, all-sectors, no grant filter) ──
  //    Reuses core query()/getRecord() as the operator. Register the localOnly-WRAPPED versions
  //    (dataQueryRoute/dataRecordRoute) — NOT the bare postDataQuery/getDataRecord (test seams).
  router.post("/api/data/:sector", dataQueryRoute);
  router.get("/api/data/:sector/:id", dataRecordRoute);

  // ── Action catalog mirror (#89 item 2 / #58; operator-loopback, cache-only, dispatches NOTHING) ──
  //    The Console's "CAN ACT" block: `list_actions` was MCP-only, so every sector lens printed an
  //    honest "not served" where Home has a real catalog. actionCatalogRoute is ALREADY localOnly-
  //    wrapped — register it directly. It serves core's ActionCatalog { actions, count, truncated }
  //    VERBATIM; a bare array would re-acquire the silent-truncation lie removed from MCP.
  router.get("/api/actions", actionCatalogRoute);

  // ── Operator read mirror (#89 fifth seam / #57 / #82) ── the three primitives that exist ONLY on the
  //    bearer mirror, served to the loopback operator so the Console's schema preview and per-record
  //    live drill stop being dead affordances. SAME handler bodies as the bearer mirror with
  //    resolveLocal() substituted (src/rest/mirror.ts documents why that widens nothing) — and behind
  //    localOnly, like every other no-bearer route. The bearer routes below are NOT touched: two
  //    disjoint resolvers on two disjoint path spaces, so neither is an escalation path into the other.
  router.get("/api/operator/context", localOnly(operatorContext));
  router.get("/api/operator/schema", localOnly(operatorSchema));
  router.post(
    "/api/operator/fetch_live",
    localOnly((ctx) => withBody(ctx, (c, body) => operatorFetchLive(c, body, audit))),
  );

  // ── Finance banks-by-institution (#33; operator-local, read-only over the #34b deduped data) ──
  //    One row per connected institution (the #34b dedup key) with provider provenance, per-Item
  //    health, last-4, and the LIVE deduped account count. localOnly like the other admin reads.
  router.get("/api/finance/banks", localOnly(financeBanksRoute));
  // ── Finance dedup trust (flag + confirm-merge; operator-local like the rest of admin). The core
  //    fns own validation/ownership/audit; these are thin wrappers (dedup-trust-batch child C). ──
  router.get("/api/finance/dedup-candidates", localOnly(financeDedupCandidatesRoute));
  router.post("/api/finance/dedup-confirmations", localOnly((ctx) => withBody(ctx, financeDedupConfirmRoute)));
  router.delete("/api/finance/dedup-confirmations/:id", localOnly(financeDedupUnconfirmRoute));

  // ── OAuth (local-trusted; first-party PKCE) ── same Host-allowlist guard.
  router.get("/api/oauth/:provider/start", localOnly(oauthStart));
  router.get("/api/oauth/:provider/callback", localOnly(oauthCallback));
  // BYO-app config (oauth-onboarding): GET status / POST client_id (+ client_secret, sealed). POST
  // accepts a secret over loopback, so both MUST stay behind localOnly (Host-allowlist).
  router.get("/api/oauth/:provider/app", localOnly(oauthAppStatus));
  router.post("/api/oauth/:provider/app", localOnly(oauthAppSet));
  router.delete("/api/oauth/:provider/app", localOnly(oauthAppDelete)); // #20 Clear a configured BYO app + its sealed secret

  // ── Plaid onboarding (local-trusted). EVERY handler reads its OWN body (readJson), so they are
  //    registered DIRECTLY behind localOnly — NEVER via withBody (double-reading the stream would
  //    hang). Same loopback Host guard as the rest of the no-bearer group. The grounded wave-13
  //    hosted-link surface (#14): BYO app creds + hosted-link mint + multi-Item poll + update-relink;
  //    the legacy single-Item link-token/exchange pair is kept below. ──
  router.get("/api/plaid/app", localOnly(getPlaidAppRoute));
  router.post("/api/plaid/app", localOnly(setPlaidAppRoute));
  router.delete("/api/plaid/app", localOnly(deletePlaidAppRoute));
  router.post("/api/plaid/hosted-link", localOnly(postPlaidHostedLink));
  router.post("/api/plaid/poll", localOnly(postPlaidPoll));
  router.post("/api/plaid/relink", localOnly(postPlaidRelink));
  router.post("/api/plaid/link-token", localOnly(postPlaidLinkToken));
  router.post("/api/plaid/exchange", localOnly(postPlaidExchange));

  // ── Public exposure (ADR 0035 §D1; console-exposure-surface). The setting that publishes this
  //    gateway to the internet — localOnly like the rest of admin, and the last route that may ever be
  //    reachable from a rebound origin. Handlers read their OWN body, so registered DIRECTLY. ──
  router.get("/api/exposure", localOnly(getExposureRoute));
  router.post("/api/exposure", localOnly(setExposureRoute));
  router.delete("/api/exposure", localOnly(clearExposureRoute));

  // ── Agent read-mirror (bearer-gated + audited) ──
  router.get("/api/context", (ctx) => mirrorContext(ctx, audit));
  router.get("/api/schema", (ctx) => mirrorSchema(ctx, audit));
  router.post("/api/query", (ctx) => withBody(ctx, (c, body) => mirrorQuery(c, body, audit)));
  router.get("/api/records/:sector/:id", (ctx) => mirrorGetRecord(ctx, audit));
  router.post("/api/fetch_live", (ctx) => withBody(ctx, (c, body) => mirrorFetchLive(c, body, audit)));

  // ── Push-ingest (intentionally EXTERNAL: NO Host-allowlist, NO bearer). Registered BARE — the
  //    per-connection webhook secret verified inside ingestPush is its gate (mirroring how the bearer
  //    mirror routes are bare). Exempting this does not unguard admin/OAuth/Plaid (still localOnly). ──
  router.post("/api/ingest/:connectionId", (ctx) => ingestPush(ctx, audit));

  return router;
}

/** Read + parse the JSON body (1MB-capped), then call the handler with it. */
async function withBody(
  ctx: RouteContext,
  handler: (ctx: RouteContext, body: unknown) => Promise<void> | void,
): Promise<void> {
  const body = await readJson(ctx.req); // PayloadTooLargeError/ValidationError -> 400
  await handler(ctx, body);
}

/**
 * Build the request listener. Resolves the route (404 unknown / 405 wrong method), runs the handler,
 * and maps any thrown error to a SAFE status (errorToStatus) — internals never leak. Exported so the
 * Console/tests can mount the app without binding a socket.
 */
export function createRestApp(
  deps: RestDeps = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter(deps);
  const staticDir = deps.staticDir ?? defaultStaticDir();

  return (req, res) => {
    void handle(router, req, res, staticDir);
  };
}

async function handle(
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = router.match(req.method ?? "GET", url.pathname);

    if (matched.kind === "not_found") {
      // Same-origin Console: a non-/api GET miss serves the built SPA (asset or index.html
      // fallback). /api/* misses stay JSON 404; serveStatic is path-traversal-safe and returns
      // false when nothing matched (no dist built, or a traversal attempt) → JSON 404.
      const method = (req.method ?? "GET").toUpperCase();
      const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
      if (method === "GET" && !isApi) {
        if (await serveStatic(req, res, staticDir)) return;
        // A browser asked for a Console page and got nothing. Only worth a log line when the whole
        // build directory is absent — reportMissingConsole makes that distinction and says it once.
        reportMissingConsole(staticDir, url.pathname);
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (matched.kind === "method_not_allowed") {
      res.setHeader("allow", matched.allow.join(", "));
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    const ctx: RouteContext = {
      req,
      res,
      params: matched.params,
      query: url.searchParams,
    };
    await matched.handler(ctx);
  } catch (err) {
    const { status, body } = errorToStatus(err);
    if (!res.headersSent) {
      sendJson(res, status, body);
    } else {
      res.end();
    }
  }
}

/**
 * Bind the app to a socket. Defaults to 127.0.0.1 (operator-local-trusted). Returns the bound port
 * (0 -> an OS-assigned port, useful in tests) and an async close().
 */
export function startRestServer(
  opts: { host?: string; port?: number } & RestDeps = {},
): { port: number; close(): Promise<void> } {
  const { host = DEFAULT_HOST, port = DEFAULT_PORT, ...deps } = opts;
  const server = createServer(createRestApp(deps));

  // Resolves once the socket is bound — so close() can wait out an in-flight listen (e.g. port 0).
  const ready = new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.listen(port, host);

  // For an explicit non-zero port the bound port is known immediately; for port 0 it's assigned on
  // 'listening' (callers needing the assigned port should mount createRestApp on their own server).
  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;

  return {
    port: boundPort,
    close: async () => {
      await ready;
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
