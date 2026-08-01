// Off-hot-path duration instrumentation for the core reads (L7).
//
// `timed(label, meta, fn)` runs `fn`, measures how long it took, and emits a single structured line
// to STDERR after `fn` resolves — so the read's return value and timing are unchanged (no awaited
// logging on the hot path), and a logging failure can never surface to the caller. stdout stays
// clean (MCP speaks JSON-RPC over stdout on stdio; instrumentation must never pollute it).
//
// `meta` is read AFTER `fn` resolves, so a caller may MUTATE the object inside `fn` to record a
// value only known post-read (e.g. query stamps `meta.rows` with the row/group count). No timing
// data is returned on the wire — this is operator-facing telemetry only.

import { performance } from "node:perf_hooks";

/**
 * Run `fn`, then log `{ label, ...meta, duration_ms }` to stderr. Fire-and-forget: the read's value
 * and latency are unchanged, and a thrown logger is swallowed (never propagates into the read). On an
 * `fn` rejection the error propagates as-is and NO line is emitted (we log only after a result resolves).
 */
export async function timed<T>(
  label: string,
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const duration_ms = performance.now() - start;
  try {
    // console.error → stderr. `meta` is spread here (post-resolution) so any mutation `fn` made lands.
    console.error(JSON.stringify({ label, ...meta, duration_ms }));
  } catch {
    // Best-effort telemetry: a logging failure must never become a read failure.
  }
  return result;
}
