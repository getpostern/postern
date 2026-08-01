// buildInsert — the one parameterized, multi-row INSERT into audit_log. Pure: maps a batch of
// AuditEntry objects to { sql, values } with a fixed column order. `args` is bound as jsonb (the
// driver passes the JS object; we cast the placeholder ::jsonb). All values are parameterized —
// no agent input is ever interpolated into SQL. created_at defaults in the DB.

import type { AuditEntry } from "./index.js";

/** Fixed column order — MUST match the value tuple built below and the audit_log schema. */
const COLUMNS = [
  "user_id",
  "agent_id",
  "tool",
  "sector",
  "decision",
  "deny_reason",
  "args",
  "result_count",
  "outcome",
  "request_id",
] as const;

/** Number of bound columns per row (used by tests: values.length === N * COLS_PER_ROW). */
export const COLS_PER_ROW = COLUMNS.length;

/**
 * Build ONE multi-row insert for `entries`:
 *   insert into audit_log (<cols>) values ($1,$2,...,$7::jsonb,...),(...),...
 * `args` is serialized to a JSON string and bound under a `::jsonb` cast (NULL stays NULL).
 * Throws on an empty batch — callers (the flusher) only ever build from a non-empty drain.
 */
export function buildInsert(entries: AuditEntry[]): { sql: string; values: unknown[] } {
  if (entries.length === 0) {
    throw new Error("buildInsert: refusing to build an insert for zero entries");
  }

  const values: unknown[] = [];
  const rowSql: string[] = [];

  for (const e of entries) {
    const base = values.length;
    const placeholders = COLUMNS.map((col, i) => {
      // args binds as jsonb; everything else is a plain parameter.
      return col === "args" ? `$${base + i + 1}::jsonb` : `$${base + i + 1}`;
    });
    rowSql.push(`(${placeholders.join(", ")})`);

    values.push(
      e.userId ?? null,
      e.agentId ?? null,
      e.tool,
      e.sector ?? null,
      e.decision,
      e.denyReason ?? null,
      // jsonb: serialize the (already-redacted) args; undefined/null -> SQL NULL.
      e.args === undefined || e.args === null ? null : JSON.stringify(e.args),
      e.resultCount ?? null,
      e.outcome ?? null,
      e.requestId ?? null,
    );
  }

  const sql =
    `insert into audit_log (${COLUMNS.join(", ")}) values ${rowSql.join(", ")}`;

  return { sql, values };
}
