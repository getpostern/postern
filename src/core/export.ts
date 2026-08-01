// export — the operator's portability bundle (manifest + data, including the `raw` payload).
//
// Custody / "own your data": a single JSON takeout of the cached store, plus the pre-erase safety
// copy (10B). Read-only; there is NO import path (faithful-cache: "undo an erase" = reconnect +
// re-sync from the live source; "restore the whole gateway" = the 9C pg_dump backup).
//
// This returns EVERYTHING for the user, UNSCOPED by sector grant — which is exactly why the REST
// route is loopback-only (operator-at-the-box), NOT a bearer/agent path. The agent's data access
// stays the grant-scoped, capped `query` mirror.

import { pool } from "../db.js";
import { allDomainTables, tablesForSector, type DomainTableRef } from "./schema.js";
import { QueryValidationError } from "./query.js";
import { audit, type AuditEntry } from "../audit/index.js";
import type { AuthContext } from "../auth/index.js";

export interface ExportBundle {
  manifest: {
    gateway: "pci-gateway";
    exported_at: string;
    user_id: string;
    connections: Array<{
      connectionId: string;
      provider: string;
      sector: string;
      status: string;
      last_synced_at: string | null;
    }>;
    sectors: string[];
    counts: Record<string, number>;
  };
  /** Keyed by REGISTRY key (e.g. "finance.transaction") → full live rows, incl. `raw`. */
  data: Record<string, unknown[]>;
}

/** Normalize a pg timestamp (Date | string | null/undefined) to an ISO string or null. */
function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Build the operator's portability bundle. For each in-scope domain table, selects every LIVE row
 * (`deleted_at is null`) in FULL — including the `raw` jsonb — for a byte-faithful takeout copy.
 * Tombstoned rows are "gone at the source", not the operator's data, so they are excluded.
 *
 * `opts.sector` narrows to one sector's tables (prefix-match; an unknown sector throws a typed
 * QueryValidationError → the route answers 400). Only REGISTRY-frozen table identifiers ever reach
 * SQL; `user_id` is the sole, parameterized value — every read is user-scoped (no cross-user leak).
 *
 * Writes one async audit line (tool='export'); the call is fire-and-forget and never blocks the
 * response. `args` carries only the optional sector — never row values, never a secret.
 */
export async function exportBundle(
  ctx: AuthContext,
  opts?: { sector?: string },
): Promise<ExportBundle> {
  // Resolve the in-scope tables FIRST so an unknown sector is a clean 400 before any data read. The
  // pre-staged helper throws a bare Error on an unknown sector; re-map it to the core 400 vocabulary.
  let tables: DomainTableRef[];
  if (opts?.sector) {
    try {
      tables = tablesForSector(opts.sector);
    } catch {
      throw new QueryValidationError(`unknown sector: ${opts.sector}`);
    }
  } else {
    tables = allDomainTables();
  }

  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const sectorsPresent = new Set<string>();
  let total = 0;

  for (const t of tables) {
    // t.table is a REGISTRY-frozen identifier (never raw input); user_id is the only parameter.
    const res = await pool.query(
      `select * from "${t.table}" where user_id = $1 and deleted_at is null`,
      [ctx.userId],
    );
    data[t.key] = res.rows;
    counts[t.key] = res.rows.length;
    total += res.rows.length;
    if (res.rows.length > 0) sectorsPresent.add(t.sector);
  }

  // The connection inventory — the same non-secret base fields the admin list exposes.
  const conns = await pool.query(
    `select id, provider, sector, status, last_synced_at
       from connectors where user_id = $1 order by created_at desc`,
    [ctx.userId],
  );
  const connections = conns.rows.map((r) => ({
    connectionId: r.id as string,
    provider: r.provider as string,
    sector: r.sector as string,
    status: r.status as string,
    last_synced_at: isoOrNull(r.last_synced_at),
  }));

  const bundle: ExportBundle = {
    manifest: {
      gateway: "pci-gateway",
      exported_at: new Date().toISOString(),
      user_id: ctx.userId,
      connections,
      sectors: [...sectorsPresent].sort(),
      counts,
    },
    data,
  };

  // 'export' is an operator admin tool added to AuditTool by the mother at merge; the audit_log.tool
  // column is plain text, so the literal is written verbatim. Cast keeps this unit typechecking in
  // isolation and stays correct whether or not the union has been extended yet.
  audit({
    userId: ctx.userId,
    agentId: ctx.agentId,
    tool: "export" as unknown as AuditEntry["tool"],
    sector: opts?.sector ?? null,
    decision: "allow",
    // A sector-scoped export carries the scope it was given; a whole-gate export was given no
    // arguments, so it writes none. `audit_log.sector` (set above) is the dedicated column for the
    // scope — duplicating it into `args` as an explicit null wrote an argument slot whose only value
    // was the absence of a value, which the ledger then rendered as `{ sector: null }` (#108).
    args: opts?.sector ? { sector: opts.sector } : undefined,
    resultCount: total,
    outcome: "ok",
  });

  return bundle;
}
