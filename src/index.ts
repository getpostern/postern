import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcp/server.js";
import { startHttpEdge } from "./mcp/http.js";
import { bridgeConfigFromEnv, noteBridgeMount, resolveBridgeConfig } from "./mcp/oauth-bridge.js";
import { resolveLocal } from "./auth/index.js";
import { audit, startAuditWriter } from "./audit/index.js";
import {
  registerConnectors,
  startRestEdge,
  startPushConnectors,
  assertVaultOpens,
} from "./bootstrap.js";
import { startScheduler } from "./sync/scheduler.js";
import { awaitDbReady, closePool } from "./db.js";
import { runMigrations } from "./db/migrate.js";
import { beginShutdown } from "./rest/index.js";

// ── Graceful shutdown ────────────────────────────────────────────────────────────
// The 5 lifecycle handles the boot used to discard, captured + torn down in a fixed order so a
// SIGTERM/SIGINT (`docker compose stop`, Ctrl-C) drains cleanly: no dropped audit, no hung pool.

/** The teardown handles captured at boot. Nullable ones are best-effort subsystems that may not start. */
export interface Subsystems {
  stopScheduler: (() => void) | null;
  stopPush: (() => void) | null;
  httpEdge: { close(): Promise<void> } | null;
  rest: { close(): Promise<void> } | null;
  server: { close(): Promise<void> };
  stopAudit: () => Promise<void>;
  closePool: () => Promise<void>;
}

/** Injectable seams so the shutdown sequence is unit-testable without exiting the test process. */
export interface ShutdownDeps {
  exit?: (code: number) => void;
  timeoutMs?: number;
  log?: (msg: string) => void;
  beginShutdown?: () => void;
}

/**
 * Build the idempotent shutdown(). Order (locked by the spec): flip /healthz to 503 first (drain) →
 * stopScheduler() → stopPush() → close httpEdge → close rest → close the MCP server → drain audit
 * LAST (after every enqueuer has quiesced, so no late audit line is lost) → close the pool → exit(0).
 * A hard timeout forces exit(1) so a wedged handle can never deadlock the shutdown.
 */
export function buildShutdown(subsystems: Subsystems, deps: ShutdownDeps = {}): () => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const begin = deps.beginShutdown ?? beginShutdown;
  let started = false;

  return async function shutdown(): Promise<void> {
    if (started) return; // idempotent — a second signal (or a SIGINT after SIGTERM) is ignored
    started = true;

    try {
      begin(); // /healthz → 503 immediately so an orchestrator drains us before teardown
    } catch {
      // best-effort — never let the drain flag block the teardown
    }

    const hard = setTimeout(() => {
      log("[pci-gateway] graceful shutdown timed out — forcing exit");
      exit(1);
    }, timeoutMs);
    if (typeof hard.unref === "function") hard.unref();

    try {
      // Quiesce the enqueuers (scheduler + push) before the edges so nothing kicks a new sync/action
      // mid-teardown; then the agent edges; then the MCP stdio server.
      subsystems.stopScheduler?.();
      subsystems.stopPush?.();
      await subsystems.httpEdge?.close();
      await subsystems.rest?.close();
      await subsystems.server.close();
      // Drain audit AFTER every enqueuer is down, so the final batch lands and no line is dropped.
      await subsystems.stopAudit();
      // Pool last — everything that could query is stopped.
      await subsystems.closePool();
      clearTimeout(hard);
      log("[pci-gateway] graceful shutdown complete");
      exit(0);
    } catch (err) {
      clearTimeout(hard);
      const msg = err instanceof Error ? err.message : String(err);
      log(`[pci-gateway] shutdown error (forcing exit): ${msg}`);
      exit(1);
    }
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────────

/** Assemble + start the gateway, wire signal handlers, and return when the edges are up. */
export async function main(): Promise<void> {
  // Fail-closed OAuth-bridge config gate (mcp-auth-bridge, ADR 0029) — BEFORE any subsystem starts.
  // bridgeConfigFromEnv throws a named BridgeConfigError when MCP_PUBLIC_URL is set but not https
  // (http is allowed only for localhost/127.0.0.1 dev) or malformed; it also normalizes the value
  // (trailing slash trimmed) so the PRM `resource` exact-match holds. A bridge configured without a
  // listening MCP HTTP edge would silently never mount — refuse to boot instead.
  //
  // THIS GATE IS ENV-ONLY, AND THAT IS DELIBERATE (console-exposure-surface, ADR 0035). Refusing to
  // boot is correct for a value only an operator with shell access can set. The same refusal applied
  // to a value set from the CONSOLE would be a button that bricks the gateway — the #97 vault-gate
  // shape, which took prod down on its first deploy. So the DB-sourced setting NEVER throws here; the
  // "is there an MCP edge to publish?" check lives at WRITE time instead (POST /api/exposure refuses
  // with a named 400). A refusal at the click is legible; a refusal at the next reboot is a brick.
  const envCfg = bridgeConfigFromEnv();
  if (envCfg) {
    const bridgePort = Number(process.env.MCP_HTTP_PORT);
    if (!Number.isInteger(bridgePort) || bridgePort <= 0) {
      throw new Error(
        "MCP_PUBLIC_URL is set but MCP_HTTP_PORT is unset/invalid — the OAuth bridge mounts on the " +
          "MCP HTTP edge; set MCP_HTTP_PORT or unset MCP_PUBLIC_URL",
      );
    }
  }

  // The async audit flusher: started once, app-wide. audit() itself is fire-and-forget; the writer
  // batch-inserts off the response hot path. mcp-edge is the app-assembly point that injects `audit`.
  const stopAudit = startAuditWriter();

  // Register the connectors the gateway ships (pure, in-memory) so the runner + action catalog can
  // resolve any provider. Must precede the edges and the scheduler.
  registerConnectors();

  // Fail-closed boot gate: the DB must be reachable AND migrated before any edge serves traffic.
  // Unlike the best-effort scheduler/push blocks, a DB or migration failure here REFUSES to boot —
  // we never serve against a dead or schema-behind DB.
  await awaitDbReady();
  await runMigrations();

  // Fail-closed vault gate (#97): the resolved master key MUST open the credentials already sealed in
  // this database. An empty vault (a genuine first run) passes. A restored/migrated host whose key does
  // not match now refuses to boot instead of serving green and failing at the first sync weeks later.
  await assertVaultOpens();

  // Resolve the bridge config the way the product resolves it: the Console-owned `gateway_exposure`
  // row first, MCP_PUBLIC_URL as the fallback, nothing at all as the (default) off state. Runs AFTER
  // runMigrations so the table exists on a first boot. NEVER throws — a DB fault or an unusable stored
  // value logs and leaves the bridge OFF rather than refusing to start.
  const resolved = await resolveBridgeConfig();
  if (resolved.problem) {
    console.error(
      `[pci-gateway] MCP OAuth bridge NOT enabled — exposure setting unusable (${resolved.problem}); ` +
        "the gateway is serving loopback-only. Fix it in the Console (Settings → Remote access).",
    );
  }

  // Local stdio edge (always on): the operator AuthContext, resolved once and cached by resolveLocal().
  // resolveCtx ignores `extra` here — stdio has a single, trusted session (the box owner).
  const server = buildServer({ resolveCtx: () => resolveLocal(), audit });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP protocol channel — all logs must go to stderr.
  console.error("[pci-gateway] MCP server running on stdio");

  // REST edge (Console backend + onboarding contract + read mirror + /healthz + same-origin Console):
  // ON by default. All bind-failure handling lives inside startRestEdge (own 'error' listener: logs and
  // gives up) — a port conflict never takes the MCP edges down. REST_PORT=0 (or invalid) disables.
  const rest = startRestEdge();
  if (rest) {
    const bound = await rest.ready;
    console.error(
      bound
        ? `[pci-gateway] REST edge listening on ${process.env.REST_HOST || "127.0.0.1"}:${rest.port}`
        : `[pci-gateway] REST edge failed to bind ${process.env.REST_HOST || "127.0.0.1"}:${rest.port} (continuing without it)`,
    );
  } else {
    console.error("[pci-gateway] REST edge disabled (REST_PORT)");
  }

  // Remote HTTP edge (opt-in): start only when a port is configured. Bearer-authenticated; the agent's
  // ctx is resolved once per session from the bearer. The bearer is never logged.
  let httpEdge: { port: number; close(): Promise<void> } | null = null;
  const httpPort = Number(process.env.MCP_HTTP_PORT);
  if (Number.isInteger(httpPort) && httpPort > 0) {
    const host = process.env.MCP_HTTP_HOST; // default loopback inside startHttpEdge
    httpEdge = startHttpEdge({ host, port: httpPort, audit, bridge: resolved.cfg });
    // Note what this process is ACTUALLY serving, at the one real mount point — never from inside
    // bridgeRoutes (which tests build at describe scope). Outside this block the note is never made,
    // which is correct: with no MCP edge, nothing is published.
    //
    // AFTER startHttpEdge returns, never before: if the edge cannot mount, this process serves no
    // bridge, and a note taken first would leave it claiming to serve one — the exact reverse of
    // §Decision 3 (edge cannot mount ⇒ bridge OFF ⇒ the status route reports it). `serving` is the
    // field the Console's safety sentence is built on; it may only ever describe a mount that happened.
    noteBridgeMount(resolved.cfg);
    console.error(`[pci-gateway] MCP HTTP edge listening on ${host ?? "127.0.0.1"}:${httpEdge.port}/mcp`);
    if (resolved.cfg) {
      console.error(
        `[pci-gateway] MCP OAuth bridge enabled at ${resolved.cfg.publicUrl} ` +
          `(source: ${resolved.source}; ADR 0029/0035)`,
      );
    }
  }

  // Start the generic poll scheduler: it reads the connectors table and drives every poll-mode
  // connection on its declared cadence (push/on_demand are not scheduled); a 60s re-scan picks up
  // connections onboarded after boot. Best-effort — a DB hiccup at boot must not take the agent
  // edges down, so we log and continue rather than crash.
  let stopScheduler: (() => void) | null = null;
  try {
    stopScheduler = await startScheduler();
    console.error("[pci-gateway] poll scheduler started");
  } catch (err) {
    console.error("[pci-gateway] poll scheduler failed to start (continuing):", err);
  }

  // Start every push-mode connection (Home Assistant): open the token from the vault, start the live
  // socket, and re-scan every 60s for connections onboarded after boot. Same best-effort posture as
  // the scheduler — a boot failure here must not take the agent edges down.
  let stopPush: (() => void) | null = null;
  try {
    stopPush = await startPushConnectors();
    console.error("[pci-gateway] push connectors started");
  } catch (err) {
    console.error("[pci-gateway] push connectors failed to start (continuing):", err);
  }

  // Wire graceful shutdown over the captured handles. process.once so a repeated signal is ignored
  // (shutdown() is also idempotent on its own flag).
  const shutdown = buildShutdown({
    stopScheduler,
    stopPush,
    httpEdge,
    rest,
    server: { close: () => server.close() },
    stopAudit,
    closePool,
  });
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

// Boot ONLY when run as the entry point (node dist/index.js / tsx src/index.ts). Importing this module
// (the shutdown unit test) captures buildShutdown without booting the gateway or touching the DB.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[pci-gateway] fatal boot error — refusing to start: ${msg}\n`);
    process.exit(1);
  });
}
