import pg from "pg";
import { config } from "./config.js";

// The one process-wide pool. Tuned for a self-host single box: a small connection cap (the audit
// flusher holds at most one connection; reads are short), a bounded idle lifetime, and a bounded
// connect wait so awaitDbReady fails fast per attempt instead of hanging on a dead DB.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

// An idle client can emit 'error' asynchronously (DB restart, network blip, server-side disconnect).
// Without a listener Node treats a pool 'error' as an UNHANDLED error event and CRASHES the process.
// Swallow it (stderr only, never the message verbatim past errno/text — pg errors carry no secret) so
// a transient DB hiccup degrades gracefully instead of taking the gateway down.
pool.on("error", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[pci-gateway] db pool error (ignored, pool self-heals): ${msg}\n`);
});

let poolClosed = false;

/** Replace `//user:pass@` in any string with `//***:***@`. DATABASE_URL carries the password, and a
 *  boot diagnostic that echoes a driver error verbatim is how it ends up in a log aggregator. */
function scrubCredentials(s: string): string {
  return s.replace(/\/\/[^/@\s]*:[^/@\s]*@/g, "//***:***@");
}

/** The DB target as `host:port` for log lines — never the URL, which carries the password. */
function dbTargetLabel(): string {
  try {
    const u = new URL(config.databaseUrl);
    return `${u.hostname || "?"}:${u.port || "5432"}`;
  } catch {
    // An unparseable DATABASE_URL is itself a common cause of the wait (a password containing `/`
    // or `@` produces exactly this), so say so rather than printing the value.
    return "the configured database (DATABASE_URL does not parse as a URL)";
  }
}

/** Log the first failed attempt, then every 5th — enough to show progress, never a per-retry flood. */
const WAIT_LOG_EVERY = 5;

/**
 * Block until the DB accepts a `select 1`, retrying with capped exponential backoff. Lets the app
 * tolerate a DB that is still coming up (compose `depends_on` gates on the db healthcheck, but a
 * fresh volume + first-boot init can still race the app). Throws after `tries` exhausted so boot
 * fails closed rather than serving against a dead DB.
 *
 * It SAYS SO while it waits. At the defaults this loop can run for about two and a half minutes, and
 * it used to do that in complete silence: no output, no listening port, nothing to distinguish "the
 * database is 3 seconds from ready" from "the hostname is wrong and this will never work". The
 * container entrypoint used to fail loudly on the first connection error instead — worse behaviour
 * (it could not survive a race the server survives) but louder, so removing it must not also remove
 * the only signal. One line per five attempts, carrying the target and the driver's own reason,
 * credential-scrubbed.
 */
export async function awaitDbReady(opts?: { tries?: number; baseMs?: number }): Promise<void> {
  const tries = opts?.tries ?? 30;
  const baseMs = opts?.baseMs ?? 250;
  const capMs = 5_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await pool.query("select 1");
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === tries - 1) break;
      if (attempt === 0 || (attempt + 1) % WAIT_LOG_EVERY === 0) {
        const why = scrubCredentials(err instanceof Error ? err.message : String(err));
        process.stderr.write(
          `[pci-gateway] waiting for the database at ${dbTargetLabel()} ` +
            `(attempt ${attempt + 1}/${tries}): ${why}\n`,
        );
      }
      const delay = Math.min(baseMs * 2 ** attempt, capMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  const msg = scrubCredentials(lastErr instanceof Error ? lastErr.message : String(lastErr));
  throw new Error(`database not ready after ${tries} attempts: ${msg}`);
}

/** Close the pool (graceful shutdown). Idempotent — a second call is a no-op. */
export async function closePool(): Promise<void> {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
}
