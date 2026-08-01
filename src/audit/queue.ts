// The bounded in-memory audit queue + background flusher.
//
// audit() enqueues here and returns. A background flusher drains in batches and runs ONE pool.query
// at a time (a `draining` flag guarantees at most one insert in flight → audit holds at most one pool
// connection, never contending with the read hot path). Best-effort: on overflow we refuse the
// INCOMING entry (bounded memory, no throw); on insert error we log to stderr and drop the batch
// (detective, never crash). Nothing here is ever awaited on a caller's path.
//
// Overflow policy is DROP-NEWEST, deliberately (ADR 0035 §D3 item 5). Dropping the oldest let a
// sustained anonymous denial flood evict genuine audit rows before they were ever inserted — an
// integrity failure in the repo's only detective control. A flood is by definition the newest
// traffic; the forensic value of an append-only log is the record of what was already happening.
// Honest residual: a sustained flood blinds the log going FORWARD instead of erasing the past. The
// per-handler deny throttles (mcp/oauth-bridge.ts, mcp/http.ts — ~30/min each) are what keep that
// residual unreachable from an anonymous source. Both halves are required; either alone is not the fix.

import { pool as defaultPool } from "../db.js";
import type { AuditEntry } from "./index.js";
import { buildInsert } from "./insert.js";

/** The minimal pg surface the flusher needs — a single parameterized query. Injectable for tests. */
export interface QueryablePool {
  query(sql: string, values: unknown[]): Promise<unknown>;
}

export interface AuditWriterOptions {
  /** Flush cadence in ms (timer trigger). Default 1000. */
  intervalMs?: number;
  /** Max entries drained + inserted per flush; also the size trigger. Default 100. */
  batchSize?: number;
  /** Bounded queue capacity; overflow refuses the incoming entry. Default 10_000. */
  capacity?: number;
  /** Pool override (tests inject a spy). Defaults to the shared pg pool. */
  pool?: QueryablePool;
}

const DEFAULTS = { intervalMs: 1000, batchSize: 100, capacity: 10_000 } as const;

/**
 * The single process-wide queue. We keep one shared instance so the free `audit()` function (no
 * handle threading at the edge) enqueues into the same buffer the started writer drains.
 */
class AuditQueue {
  private buf: AuditEntry[] = [];
  private capacity: number = DEFAULTS.capacity;
  private batchSize: number = DEFAULTS.batchSize;
  private intervalMs: number = DEFAULTS.intervalMs;
  private pool: QueryablePool = defaultPool;

  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false; // at-most-one-insert-in-flight guard
  private stopping = false;

  /** Count of entries dropped on overflow since process start (logged periodically). */
  dropped = 0;
  private lastDroppedLogged = 0;

  /** Synchronous enqueue. On overflow refuse the INCOMING entry and bump `dropped` — history
   *  already queued is never evicted. Never throws, never awaits. */
  enqueue(entry: AuditEntry): void {
    if (this.buf.length >= this.capacity) {
      this.dropped++;
      // Throttle the stderr notice so an overload doesn't itself spam logs.
      if (this.dropped - this.lastDroppedLogged >= this.capacity) {
        this.lastDroppedLogged = this.dropped;
        process.stderr.write(`[audit] queue overflow — dropped ${this.dropped} entries total\n`);
      }
      return; // drop NEWEST — the queued history survives the flood
    }
    this.buf.push(entry);

    // Size trigger: kick a flush (fire-and-forget) once we've reached a full batch. The draining
    // flag inside flush() makes this a no-op when an insert is already in flight. Skipped once
    // stop() has begun — stop() owns the final drain so a late enqueue can't spawn a racing insert.
    if (!this.stopping && this.buf.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** (Re)configure + start the timer. Idempotent-ish: a prior timer is cleared first. */
  start(opts?: AuditWriterOptions): void {
    this.intervalMs = opts?.intervalMs ?? DEFAULTS.intervalMs;
    this.batchSize = opts?.batchSize ?? DEFAULTS.batchSize;
    this.capacity = opts?.capacity ?? DEFAULTS.capacity;
    if (opts?.pool) this.pool = opts.pool;

    this.stopping = false;
    this.draining = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
    // Don't keep the event loop alive purely for audit flushing.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /**
   * Drain up to batchSize entries and run ONE insert. The `draining` flag enforces at most one
   * insert in flight; concurrent calls (timer + size trigger) early-return. Never throws — an insert
   * failure is logged to stderr and the batch is dropped (best-effort).
   */
  async flush(): Promise<void> {
    if (this.draining) return; // an insert is already in flight
    if (this.buf.length === 0) return;

    this.draining = true;
    try {
      const batch = this.buf.splice(0, this.batchSize);
      if (batch.length === 0) return;
      const { sql, values } = buildInsert(batch);
      await this.pool.query(sql, values);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[audit] flush failed, dropped batch: ${msg}\n`);
      // Batch already spliced out → dropped. Detective, never re-queue/retry, never crash.
    } finally {
      this.draining = false;
    }
  }

  /**
   * Graceful stop: stop the timer, then drain-flush the remainder best-effort. Loops flush() until
   * the buffer empties (or an insert fails, which flush() swallows) so stop() empties the buffer even
   * when more than one batch is buffered. Never throws.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Best-effort drain. Guard with a bound so a persistently-failing insert can't spin forever.
    let guard = 0;
    while (this.buf.length > 0 && guard < 100_000) {
      const before = this.buf.length;
      await this.flush();
      guard++;
      // If flush made no progress (insert threw → batch dropped is still progress; only a no-op
      // when draining was somehow true) break to avoid a hot spin.
      if (this.buf.length >= before) break;
    }
  }

  /** Test/diagnostic: current buffered count. */
  size(): number {
    return this.buf.length;
  }
}

/** The single shared queue instance backing the free `audit()` function. */
export const queue = new AuditQueue();
