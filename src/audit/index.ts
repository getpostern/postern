// audit-writer — the async, fire-and-forget writer for the append-only audit_log.
//
// Mantra: lightning fast. audit() redacts + enqueues in memory and returns synchronously — it NEVER
// awaits I/O and NEVER throws, so the response hot path pays zero latency for the audit line. A
// background flusher (started by startAuditWriter) batch-inserts with at most one insert in flight,
// so audit never contends with reads for a pool connection. Detective, not preventive: under extreme
// overload or a hard crash, entries may drop (with a logged counter). Best-effort by design.
//
// This unit only EXPOSES audit(); wiring it into the core primitives / MCP / REST edge belongs to
// mcp-edge and rest-onboarding (which also catch AccessDenied to log a 'deny').

import { AccessDenied } from "../auth/index.js";
import { redactArgs } from "./redact.js";
import { queue, type AuditWriterOptions } from "./queue.js";

export { redactArgs } from "./redact.js";
export { buildInsert } from "./insert.js";

/**
 * The audit-line vocabulary: the seven core primitives + the wave-10 operator admin verbs
 * (loopback-only data-control plane) + the mcp-auth-bridge events (`oauth_token` = bridge token
 * issue/refresh; `initialize` = MCP session-init denials, previously entirely silent). The audit_log
 * `tool` column is free text; this union keeps the recorded vocabulary honest so callers don't have
 * to cast.
 */
export type AuditTool =
  | "describe_context"
  | "get_schema"
  | "query"
  | "get_record"
  | "fetch_live"
  | "list_actions"
  | "invoke_action"
  | "pause"
  | "resume"
  | "revoke"
  | "sync_now"
  | "erase"
  | "export"
  | "oauth_token"
  | "initialize";

/** One audit line. `args` is redacted + size-capped on enqueue (callers pass raw args). */
export interface AuditEntry {
  userId: string | null;
  agentId: string | null;
  tool: AuditTool;
  sector?: string | null;
  decision: "allow" | "deny";
  denyReason?: string | null;
  args?: unknown; // redacted + size-capped on enqueue
  resultCount?: number | null; // reads
  outcome?: "ok" | "error" | null; // actions
  requestId?: string | null;
}

/**
 * Fire-and-forget audit. Redacts `args`, enqueues onto the bounded in-memory queue, and returns
 * immediately. NEVER awaits I/O and NEVER throws — safe to call even if the writer was never started
 * or the DB is down (the entry simply waits in the queue / is eventually dropped on overflow).
 */
export function audit(entry: AuditEntry): void {
  try {
    const redacted: AuditEntry = { ...entry, args: redactArgs(entry.args) };
    queue.enqueue(redacted);
  } catch {
    // audit() must never throw on the caller's path. An enqueue that somehow fails is swallowed —
    // a missing audit line is acceptable (best-effort); a thrown audit error is not.
  }
}

/**
 * Start the background flusher. A timer fires every `intervalMs` (default 1000) and a size trigger
 * fires at `batchSize` (default 100); each flush drains up to `batchSize` entries and runs ONE
 * insert. Returns stop(), which clears the timer and drain-flushes the remainder best-effort.
 */
export function startAuditWriter(opts?: AuditWriterOptions): () => Promise<void> {
  queue.start(opts);
  return () => queue.stop();
}

/**
 * Edge convenience for the act/deny path: run `fn`, fire one audit entry (non-blocking), return fn's
 * result. On AccessDenied → audits decision:'deny' (denyReason = error message) then rethrows; any
 * other throw → audits outcome:'error' (decision:'allow') then rethrows. The audit() call itself
 * never blocks the return. (Reads that need resultCount call audit() directly.)
 */
export async function withAudit<T>(
  base: Omit<AuditEntry, "decision" | "outcome">,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const r = await fn();
    audit({ ...base, decision: "allow", outcome: "ok" });
    return r;
  } catch (e) {
    if (e instanceof AccessDenied) {
      audit({ ...base, decision: "deny", denyReason: e.message });
    } else {
      audit({ ...base, decision: "allow", outcome: "error" });
    }
    throw e;
  }
}
