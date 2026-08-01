// App bootstrap: declare which connectors the gateway ships, and the boot-wiring helpers the
// composition root (index.ts) assembles into a running gateway. Registration is the seam that makes
// data flow — without it the runner, scheduler, and action catalog can't resolve any provider, so
// nothing syncs even though the engine and edges are up. Registration is pure in-memory (the
// registry Map); the poll scheduler (started by the composition root in index.ts) then reads the
// connectors table and drives each poll-mode connection on its cadence. Push connectors (Home
// Assistant) register here too so the runner/action path can resolve them; their live WebSocket is
// started by startPushConnectors (it needs a per-connection secret), not by the poll scheduler.

import { createServer } from "node:http";
import { registerConnector, getConnector } from "./sync/registry.js";
import { markStreamState, maskError, markError } from "./sync/index.js";
import { SimpleFinConnector } from "./connectors/simplefin.js";
import { PlaidConnector } from "./connectors/plaid.js";
import { HomeAssistantConnector } from "./connectors/homeassistant.js";
import { MicrosoftConnector } from "./connectors/microsoft.js";
import { GmailConnector } from "./connectors/gmail.js";
import { GoogleConnector } from "./connectors/google.js";
import { WhoopConnector } from "./connectors/whoop.js";
import { AppleHealthConnector } from "./connectors/apple-health.js";
import { AppleConnector } from "./connectors/apple.js";
import type { Connector, SyncContext } from "./connectors/types.js";
import { createRestApp } from "./rest/index.js";
import { audit } from "./audit/index.js";
import { open, assertVaultKey, vaultBackupNotice } from "./secrets/index.js";
import { pool } from "./db.js";

// ── Vault boot gate ────────────────────────────────────────────────────────────

let vaultGate: Promise<void> | null = null;

/**
 * Boot gate. Verifies the resolved master key opens the vault that already exists, then emits the
 * un-acknowledged-key banner to STDERR. Argument-free BY DESIGN: there is nothing an outside caller
 * can pass to weaken it. Memoized — safe to call more than once, does one DB scan per process.
 * Throws VaultKeyError; the composition root turns that into "refusing to start".
 *
 * stderr only: stdout is the MCP protocol channel (src/index.ts) and one stray stdout write corrupts
 * every local agent session.
 *
 * Deliberately NOT called from startPushConnectors(): index.ts wraps that call in a try/catch that
 * would convert a fail-closed gate into a swallowed log line. It is wired in index.ts's main(),
 * immediately after runMigrations() and before any edge serves.
 */
export async function assertVaultOpens(): Promise<void> {
  // The memoized promise INCLUDES a rejected one, so a repeated call can neither re-scan nor
  // re-print. The first caller awaits it immediately, so a memoized rejection is always observed.
  vaultGate ??= (async () => {
    await assertVaultKey(); // throws VaultKeyError — fail closed
    const notice = vaultBackupNotice();
    if (notice) process.stderr.write(notice + "\n");
  })();
  return vaultGate;
}

/**
 * Register every connector the gateway ships under its declared `provider`. Idempotent (the
 * registry is last-registration-wins) and side-effect-free — no DB, no network. Call before
 * starting the edges so the action catalog and the runner can resolve any provider immediately.
 */
export function registerConnectors(): void {
  registerConnector(new SimpleFinConnector());
  registerConnector(new PlaidConnector());
  registerConnector(new HomeAssistantConnector());
  registerConnector(new MicrosoftConnector());
  registerConnector(new GmailConnector());
  registerConnector(new GoogleConnector());
  registerConnector(new WhoopConnector());
  registerConnector(new AppleHealthConnector());
  // ONE entry for provider "apple": the composite fans mail+calendar+contacts off one ASP credential
  // (registry keys by provider — the three iCloud sub-connectors would otherwise collide). ADR 0030.
  registerConnector(new AppleConnector());
}

// ── REST edge (boot wiring) ────────────────────────────────────────────────────

/** Default REST bind: loopback only — the admin + OAuth surfaces are operator-local-trusted. */
const REST_DEFAULT_PORT = 8787;
const REST_DEFAULT_HOST = "127.0.0.1";

/**
 * Mount createRestApp on a node:http server OWNED HERE (do NOT call startRestServer — it attaches
 * no 'error' listener, so a failed bind would crash the process and its close() would hang).
 * Attaches server.on('error', …): logs to stderr and gives up — a bind failure NEVER takes the
 * process down. Port from REST_PORT (default 8787; '0' or invalid disables → returns null),
 * host from REST_HOST (default 127.0.0.1). Injects the module-level `audit` as deps.audit —
 * audit() is directly assignable to AuditHook (no adapter).
 *
 * `ready` settles TRUE once the socket is actually bound and FALSE when the bind failed, so the
 * composition root can print an honest "listening on …" instead of announcing a port it never got.
 */
export function startRestEdge(): { port: number; ready: Promise<boolean>; close(): Promise<void> } | null {
  const rawPort = process.env.REST_PORT;
  const port = rawPort == null || rawPort === "" ? REST_DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null; // '0' / invalid = disabled
  const host = process.env.REST_HOST || REST_DEFAULT_HOST;

  const server = createServer(createRestApp({ audit }));

  // Settles on EITHER outcome so close() never hangs out a bind that already failed — and carries
  // WHICH outcome, so the caller can report the bind honestly.
  const ready = new Promise<boolean>((resolve) => {
    server.once("listening", () => resolve(true));
    server.once("error", () => resolve(false));
  });
  server.on("error", (err) => {
    // Log and give up — the MCP edges keep serving. The error carries no secrets (bind errno only).
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pci-gateway] REST edge failed on ${host}:${port} (continuing without it): ${msg}`);
  });
  server.listen(port, host);

  return {
    port,
    ready,
    close: async () => {
      if (!(await ready)) return; // bind failed (already logged) — nothing to close
      if (!server.listening) return; // closed by someone else in the meantime
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// ── Push connectors (boot wiring) ──────────────────────────────────────────────

/** Re-scan cadence: connections onboarded AFTER boot start without a restart. */
const PUSH_RESCAN_INTERVAL_MS = 60_000;
/** Initial-start retry backoff: 5s doubling to a 60s cap. */
const PUSH_RETRY_MIN_MS = 5_000;
const PUSH_RETRY_MAX_MS = 60_000;

/**
 * The duck-typed live surface of a push connector. `start`/`stop` are deliberately NOT on the
 * Connector interface (poll connectors have no live lifecycle), so the starter feature-detects.
 */
interface PushLifecycle {
  // haUrl: the per-connection Home Assistant address, threaded from provider_credentials.instance_url
  // (homeassistant.ts reads ctx.haUrl ?? process.env.HA_URL). Optional — other push connectors ignore it.
  start(ctx: SyncContext & { haUrl?: string }): Promise<void>;
  stop?(connectionId: string): void;
}

/** Feature-detect a push connector's live lifecycle. Null for poll/on_demand or start-less connectors. */
function pushLifecycle(connector: Connector | undefined): PushLifecycle | null {
  if (!connector || connector.policy.mode !== "push") return null;
  if (typeof (connector as { start?: unknown }).start !== "function") return null;
  return connector as unknown as PushLifecycle;
}

/** Per-connection runtime state for the push starter. */
interface PushState {
  connector: PushLifecycle;
  retryTimer: NodeJS.Timeout | null;
  backoffMs: number;
  started: boolean;
  /** Skipped misconfiguration or terminal auth failure — never (re)attempted, re-scans stay quiet. */
  terminal: boolean;
  /**
   * The credential/config this entry was built with (#41): the RESTART KEY. A dead entry (started
   * then stream 'down', or terminal) is evicted and re-attempted ONLY when the scan row's current
   * secret_ref or instance_url differs from these — never on a timer (the auth no-hammer rule:
   * HA throttles/bans repeated auth failures, so a same-token dead entry stays visibly dead).
   */
  secretRef: string | null;
  instanceUrl: string | null;
}

/**
 * Start every push-mode connection: select active connectors ⋈ credentials; for each row whose
 * registered connector has policy.mode === 'push' AND a `start` function (duck-typed — `start` is
 * deliberately not on the Connector interface), open the token and call
 * start({ userId, connectionId, secretRef, secret }). Re-scans the table every 60s so connections
 * onboarded after boot start without a restart. Returns stop() (cancels timers/retries, calls the
 * connector's stop(connectionId) for started connections).
 *
 * Retry policy: an initial start() failure retries with capped backoff (5s doubling → 60s cap),
 * EXCEPT (a) misconfiguration — missing HA_URL / missing credential — which is skipped with one
 * stderr line and never retried, and (b) an auth failure, which is TERMINAL (the WS client
 * deliberately does not reconnect-loop on a bad token, and HA throttles/bans repeated auth
 * failures). Recovery from a dead entry is keyed on a CREDENTIAL/CONFIG CHANGE, never a timer
 * (#41): the re-scan evicts and freshly re-attempts a dead entry (started-then-stream-'down' or
 * terminal) when the row's secret_ref or instance_url differs from the one the attempt was built
 * with — re-seal the token / fix the URL in the Console and the connection heals within ≤60s,
 * no restart, no hammering. Before every retry the connector's stop(connectionId) runs first — a partially-started
 * connection stays in the connector's map and would make the retry a silent no-op with no event
 * subscriptions. Accepted V0 trade (documented, not fixed): a failure window before the connection
 * is registered can leak one authenticated socket per attempt, bounded by the backoff; and a stop()
 * racing an in-flight attempt can orphan one connection (process exit is the only stop() caller).
 */
export async function startPushConnectors(): Promise<() => void> {
  const tracked = new Map<string, PushState>();
  let stopped = false;

  /** One start attempt. NEVER throws — a failure schedules a retry (or goes terminal on auth failure). */
  async function attempt(
    connectionId: string,
    userId: string,
    provider: string,
    secretRef: string,
    instanceUrl: string | null,
    state: PushState,
  ): Promise<void> {
    if (stopped || state.terminal) return;
    try {
      // Token via the vault (plaintext, never logged); re-opened on every retry so an in-place
      // re-seal UNDER THE SAME REF (e.g. `npm run rotate`) is picked up without a restart. A Console
      // re-paste mints a FRESH sec_<uuid> ref on the same credential row — that path is healed by the
      // scan's credential-change evict (#41), not by this re-open.
      const secret = (await open(secretRef, { userId, provider, purpose: "access" })).toString("utf8");
      // haUrl: per-connection instance_url takes precedence; homeassistant.ts falls back to HA_URL.
      await state.connector.start({ userId, connectionId, secretRef, secret, haUrl: instanceUrl ?? undefined });
      state.started = true;
      // #4: generic recovery for any push connector — clear a prior 'error' back to active on a
      // successful start (guarded on status='error' so it's a no-op on the happy path). For HA,
      // markSynced on the first snapshot also clears it; this is the fallback for non-self-stamping
      // push connectors.
      await pool
        .query(
          `update connectors set status = 'active', last_error = null, last_error_at = null
            where id = $1 and status = 'error'`,
          [connectionId],
        )
        .catch(() => {});
      // #39: the stream is live — persist it (transition-stamped, status untouched, best-effort).
      await markStreamState(connectionId, "connected");
      if (stopped) {
        // A stop() raced this attempt — close the orphan window where we can (best-effort).
        try {
          state.connector.stop?.(connectionId);
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Auth failure is TERMINAL. Detected by the WS client's stable message (fixed by design in
      // homeassistant-ws.ts — it never echoes the token or HA's message verbatim).
      if (msg.includes("home assistant auth failed: invalid token")) {
        console.error(
          `[pci-gateway] push connector ${provider} (${connectionId}): auth failed — not retrying`,
        );
        // #4: report the honest status before going terminal (the message is static/secret-free).
        // markError (not a local write): it carries `status not in ('paused','revoked')`, so an
        // operator pause landing between the scan and this write is never resurrected to 'error' (#97).
        await markError(connectionId, "auth failed: invalid token");
        // #39: terminal = the stream is down for good (no retry loop will bring it back).
        await markStreamState(connectionId, "down", "auth failed: invalid token");
        state.terminal = true;
        return;
      }
      if (stopped) return;
      // #39: the retry loop is live but the stream is not — persist 'retrying' + the masked reason
      // (status deliberately untouched: a generic start failure is not a terminal connector fault).
      await markStreamState(connectionId, "retrying", msg);
      const delayMs = state.backoffMs;
      state.backoffMs = Math.min(state.backoffMs * 2, PUSH_RETRY_MAX_MS);
      console.error(
        // maskError (#41): the DB write above already masks; the stderr line must match — a start
        // failure can echo a credentialed URL (scheme://user:pass@host) and must never log it raw.
        `[pci-gateway] push connector ${provider} (${connectionId}) failed to start (retrying in ${delayMs}ms): ${maskError(msg)}`,
      );
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        // stop() BEFORE every retry: a partially-started connection stays in the connector's map
        // and would make the retry a silent no-op with no event subscriptions.
        try {
          state.connector.stop?.(connectionId);
        } catch {
          // best-effort
        }
        void attempt(connectionId, userId, provider, secretRef, instanceUrl, state);
      }, delayMs);
    }
  }

  /** One pass over connectors ⋈ credentials: start new push connections, drop departed rows. */
  async function scan(): Promise<void> {
    if (stopped) return;
    const res = await pool.query(
      `select c.id, c.user_id, c.provider, c.stream_state, pc.secret_ref, pc.instance_url
         from connectors c
         join provider_credentials pc on pc.id = c.credential_id
        where c.status in ('active', 'error')`,
    );
    if (stopped) return;

    const seen = new Set<string>();
    const attempts: Promise<void>[] = [];
    for (const row of res.rows) {
      const provider = row.provider as string;
      const lifecycle = pushLifecycle(getConnector(provider));
      if (!lifecycle) continue; // poll/on_demand, unregistered, or start-less — not ours to start
      const connectionId = row.id as string;
      seen.add(connectionId);

      // Per-connection instance_url (HA WebSocket address) takes precedence; process.env.HA_URL is the
      // global/dogfood fallback (#3).
      const instanceUrl = (row.instance_url ?? null) as string | null;
      const secretRef = (row.secret_ref ?? null) as string | null;

      const existing = tracked.get(connectionId);
      if (existing) {
        // #41 credential-change-keyed restart. A DEAD entry — started but its stream is 'down'
        // (the WS client's mid-run terminal auth death: its own reconnect loop gave up), or a
        // terminal bootstrap skip (bad token / misconfiguration) — is evicted and re-attempted in
        // THIS same scan pass, but ONLY when the row shows the credential or config materially
        // changed since the attempt was built: a different secret_ref or instance_url. Never on a
        // timer (the auth no-hammer rule — HA throttles/bans repeated auth failures), so an
        // unchanged-credential dead entry stays visibly dead (pause→resume and re-onboarding stay
        // the manual hatches). 'retrying' entries (bootstrap backoff OR the WS client's own
        // reconnect loop — started with stream_state != 'down') are NEVER touched: their loop is
        // alive and will pick things up itself.
        //
        // Which Console flows change the key (verified against src/rest/):
        //   * POST /api/credentials (re-paste a token / fix the HA URL): upserts the SAME
        //     provider_credentials row per (user, provider) but seal() mints a FRESH `sec_<uuid>`
        //     ref every call, so secret_ref (and instance_url) repoint IN PLACE — the connector row
        //     and connection_id survive. THIS is the heal-in-place flow this branch serves.
        //   * DELETE /api/connectors/:id + reconnect: mints a NEW connection id — handled by the
        //     departed-rows branch below + a fresh start, never this branch.
        //   * `npm run rotate` (ADR 0011): re-seals vault ROWS in place, refs unchanged → no evict
        //     (correct — the token itself did not change).
        const dead = (existing.started && row.stream_state === "down") || existing.terminal;
        const changed = existing.secretRef !== secretRef || existing.instanceUrl !== instanceUrl;
        if (!(dead && changed)) continue; // healthy / retrying / unchanged-dead (no-hammer)
        // Evict exactly like the departed-rows branch, then fall through to a fresh start below.
        if (existing.retryTimer) clearTimeout(existing.retryTimer);
        try {
          existing.connector.stop?.(connectionId); // idempotent-by-map; silently no-ops if never started
        } catch {
          // best-effort
        }
        tracked.delete(connectionId);
        await markStreamState(connectionId, "down", "restarting: credential or config changed");
      }

      // Misconfiguration is NOT retried (one stderr line, then quiet). HA's start() needs an address:
      // skip ONLY when there is neither a per-connection instance_url NOR a global HA_URL — otherwise
      // a UI-only HA connect (no env) could never start. With either present, start() proceeds.
      if (provider === "home_assistant" && !instanceUrl && !process.env.HA_URL) {
        console.error(
          `[pci-gateway] push connector ${provider} (${connectionId}): no instance URL (HA_URL unset) — skipping`,
        );
        // #4: report the honest status before this row goes terminal (guarded — see markError above).
        await markError(connectionId, "no instance URL (HA_URL unset)");
        // #39: terminal misconfiguration — the stream never comes up.
        await markStreamState(connectionId, "down", "no instance URL (HA_URL unset)");
        tracked.set(connectionId, {
          connector: lifecycle,
          retryTimer: null,
          backoffMs: PUSH_RETRY_MIN_MS,
          started: false,
          terminal: true,
          secretRef, // #41: the restart key — setting an instance_url later evicts + re-attempts
          instanceUrl,
        });
        continue;
      }
      if (!secretRef) {
        console.error(
          `[pci-gateway] push connector ${provider} (${connectionId}): no credential — skipping`,
        );
        // #4: report the honest status before this row goes terminal (guarded — see markError above).
        await markError(connectionId, "no credential");
        // #39: terminal misconfiguration — the stream never comes up.
        await markStreamState(connectionId, "down", "no credential");
        tracked.set(connectionId, {
          connector: lifecycle,
          retryTimer: null,
          backoffMs: PUSH_RETRY_MIN_MS,
          started: false,
          terminal: true,
          secretRef, // null here — pasting a credential later evicts + re-attempts (#41)
          instanceUrl,
        });
        continue;
      }

      const state: PushState = {
        connector: lifecycle,
        retryTimer: null,
        backoffMs: PUSH_RETRY_MIN_MS,
        started: false,
        terminal: false,
        secretRef, // #41: the restart key this attempt closure is built with
        instanceUrl,
      };
      tracked.set(connectionId, state);
      attempts.push(
        attempt(connectionId, row.user_id as string, provider, secretRef, instanceUrl, state),
      );
    }

    // Rows no longer active/error (revoked/deleted): cancel retries, stop started connections.
    for (const [connectionId, state] of tracked) {
      if (seen.has(connectionId)) continue;
      if (state.retryTimer) clearTimeout(state.retryTimer);
      if (state.started) {
        try {
          state.connector.stop?.(connectionId);
        } catch {
          // best-effort
        }
      }
      tracked.delete(connectionId);
      // #39: WE closed the stream — record it (stream columns only; status stays whatever the
      // departing verb set: paused/revoked/deleted, never resurrected from here).
      await markStreamState(connectionId, "down", "stopped");
    }

    await Promise.all(attempts); // attempt() never rejects; awaited so boot sees the first pass through
  }

  await scan(); // initial pass — a DB failure here propagates (index.ts logs and continues)

  // Periodic re-scan: membership only — started connections and pending retries are untouched.
  const rescan = setInterval(() => {
    void scan().catch((err) => {
      // A flaky DB read must not kill the re-scan loop — the next tick retries.
      console.error(
        "[pci-gateway] push connector re-scan failed (will retry):",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, PUSH_RESCAN_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(rescan);
    for (const [connectionId, state] of tracked) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
      if (state.started) {
        try {
          state.connector.stop?.(connectionId);
        } catch {
          // best-effort
        }
      }
    }
    tracked.clear();
  };
}
