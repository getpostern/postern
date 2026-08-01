// erase — the operator's data-destruction verb (wave 10, ADR 0012).
//
// HARD-DELETE (a real DELETE), NOT a tombstone. The tombstone (ADR 0004, last-writer-RESURRECTS) is
// the fidelity mechanism for a source-removed object; a soft "erase" would be silently undone by the
// next sync while the connector is live and would leave `raw` on disk. Operator erase is custody /
// destruction — the bytes actually leave (modulo VACUUM/backup-WAL, a runbook concern). Erase touches
// ONLY domain-row data: it KEEPS the connector/credential rows (so the operator can re-sync, or revoke
// separately — the three lifecycle verbs are orthogonal) and KEEPS the audit log (decision 4 — audit
// records the act, never the row values).
//
// Always user_id-scoped (ctx.userId) — an operator can only destroy their OWN rows; a foreign/unknown
// connectionId is a NotFoundError (404), never a cross-user delete. Only REGISTRY table names ever
// reach SQL (derived from the frozen allDomainTables()/tablesForSector() — never a hard-coded or
// caller-supplied identifier); all values are parameterized.
//
// Not atomic across tables by design: the per-table DELETEs run as independent statements (the
// codebase's no-explicit-transaction style). A DELETE is idempotent, so a mid-run failure is fully
// recovered by simply re-running the erase — re-deleting already-gone rows is a no-op.

import { pool } from "../db.js";
import { allDomainTables, tablesForSector, type DomainTableRef } from "./schema.js";
import { reconcileFinance } from "./finance-dedup.js";
// Reuse context.ts's NotFoundError so the REST edge's errorToStatus (which checks `instanceof
// NotFoundError` against THAT class) maps a foreign/unknown connectionId to 404.
import { NotFoundError } from "./context.js";
// Reuse query.ts's QueryValidationError so a bad scope / missing-required-field / unknown-sector maps
// to a typed 400 at the edge.
import { QueryValidationError } from "./query.js";
import { removePlaidItem } from "../connectors/plaid.js";
import type { AuthContext } from "../auth/index.js";

export type EraseScope = "connection" | "sector" | "all";

/**
 * Stop (Plaid /item/remove) every Plaid Item matched by `where` BEFORE its rows are wiped — billing
 * safety (wave 13): an erase that leaves the Item live keeps the paid Production subscription running.
 * Best-effort: removePlaidItem swallows per-Item failures and the whole step is try/caught, so a
 * billing-stop hiccup NEVER blocks the destructive erase. `where`/values select connectors⋈credentials.
 *
 * Plaid is SPECIAL among providers here: /item/remove INVALIDATES the access_token upstream, so a
 * post-erase re-sync of an erased Plaid connection CANNOT just resume — it needs a brand-new (NOT
 * update-mode) Link, because the Item itself is gone. (Every other provider's credential survives an
 * erase and re-syncs as-is.) So right after the removals we stamp the kept credentials item_status='dead'
 * — erase keeps credential rows, and 'dead' is exactly the Console/describe_context cue "this needs a
 * fresh Link", never a stale 'ok'. Best-effort, inside the same try — never block the erase on it.
 */
async function stopPlaidItems(where: string, values: unknown[], userId: string): Promise<void> {
  try {
    const res = await pool.query(
      `select pc.secret_ref from connectors c join provider_credentials pc on pc.id = c.credential_id
        where c.provider = 'plaid' and ${where}`,
      values,
    );
    for (const r of res.rows) await removePlaidItem((r.secret_ref ?? null) as string | null, userId);
    // The removed Items' access tokens are now dead upstream → mark the (kept) credentials so a future
    // re-sync prompts a FRESH Link rather than silently failing against an invalidated token.
    await pool.query(
      `update provider_credentials pc
          set item_status = 'dead'
         from connectors c
        where c.credential_id = pc.id and c.provider = 'plaid' and ${where}`,
      values,
    );
  } catch {
    // best-effort billing stop + status stamp — never block the erase over it.
  }
}

export interface EraseResult {
  scope: EraseScope;
  /** Per-table deleted row count — keyed by the backing table name; ZERO-count tables are omitted. */
  deleted: Record<string, number>;
  /** Sum of all per-table counts (the authoritative "how many rows left"). */
  total: number;
}

/** A v4-shaped uuid (the connectors.id form). A non-uuid id is "unknown" (404), never a bad-uuid 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hard-delete cached domain rows for a scope, always scoped to ctx.userId:
 *   - `connection`: requires `connectionId` (must belong to ctx.userId, else NotFoundError). DELETEs
 *     from EVERY domain table where connection_id = $1 and user_id = $2 — live AND tombstoned rows.
 *   - `sector`: requires `sector` (validated against the REGISTRY). DELETEs from each of the sector's
 *     tables where user_id = $1.
 *   - `all`: DELETEs from every domain table where user_id = $1.
 *
 * Returns per-table counts (non-zero only) + the total. KEEPS the connector/credential rows and the
 * audit log. The route validates a confirmation token BEFORE calling this (the fat-finger guard).
 */
export async function eraseData(
  ctx: AuthContext,
  opts: { scope: EraseScope; connectionId?: string; sector?: string },
): Promise<EraseResult> {
  const deleted: Record<string, number> = {};
  let total = 0;
  // Whether this erase could have touched finance rows → re-reconcile the synthetic-union after (#34b).
  let touchedFinance = false;

  /** Run one DELETE and fold its rowCount into the result. Table is a frozen REGISTRY identifier. */
  const wipe = async (table: string, where: string, values: unknown[]): Promise<void> => {
    const res = await pool.query(`delete from "${table}" where ${where}`, values);
    const n = res.rowCount ?? 0;
    if (n > 0) deleted[table] = n;
    total += n;
  };

  switch (opts.scope) {
    case "connection": {
      const connectionId = opts.connectionId;
      if (!connectionId) {
        throw new QueryValidationError("connectionId is required for scope 'connection'");
      }
      // Validate the uuid shape up front so a malformed id is a typed 404, not a bad-uuid pg 500.
      if (!UUID_RE.test(connectionId)) {
        throw new NotFoundError(`unknown connectionId '${connectionId}'`);
      }
      // Ownership check: the connection must be THIS user's, else 404 (no cross-user reach / no oracle).
      const owns = await pool.query(`select sector from connectors where id = $1 and user_id = $2`, [
        connectionId,
        ctx.userId,
      ]);
      if (!owns.rows[0]) {
        throw new NotFoundError(`unknown connectionId '${connectionId}'`);
      }
      if ((owns.rows[0].sector as string) === "finance") touchedFinance = true;
      // Plaid billing safety: stop this Item upstream BEFORE dropping its rows (no-op for non-Plaid).
      await stopPlaidItems("c.id = $1 and c.user_id = $2", [connectionId, ctx.userId], ctx.userId);
      // The connection's rows live only in its sector's table(s); the rest return 0 (omitted).
      for (const t of allDomainTables()) {
        await wipe(t.table, "connection_id = $1 and user_id = $2", [connectionId, ctx.userId]);
      }
      break;
    }

    case "sector": {
      const sector = opts.sector;
      if (!sector) {
        throw new QueryValidationError("sector is required for scope 'sector'");
      }
      let tables: DomainTableRef[];
      try {
        tables = tablesForSector(sector); // prefix-match; throws on an unknown sector
      } catch {
        throw new QueryValidationError(`unknown sector: ${sector}`);
      }
      // Plaid billing safety: when erasing the finance sector, stop every Plaid Item upstream first.
      if (sector.split(".")[0] === "finance") {
        touchedFinance = true;
        await stopPlaidItems("c.user_id = $1", [ctx.userId], ctx.userId);
      }
      for (const t of tables) {
        await wipe(t.table, "user_id = $1", [ctx.userId]);
      }
      break;
    }

    case "all": {
      touchedFinance = true;
      // Plaid billing safety: stop every Plaid Item upstream BEFORE wiping all of the user's data.
      await stopPlaidItems("c.user_id = $1", [ctx.userId], ctx.userId);
      for (const t of allDomainTables()) {
        await wipe(t.table, "user_id = $1", [ctx.userId]);
      }
      break;
    }

    default: {
      // Defensive — the route validates scope via zod, but eraseData stays total on its own.
      throw new QueryValidationError(`unknown erase scope: ${String(opts.scope)}`);
    }
  }

  // Cross-provider finance dedup (#34b): a finance-scoped erase changed the live set, so re-reconcile —
  // the synthetic-union recomputes / drops over the remaining rows and never orphans a synthetic or a
  // shadow pointer (a deleted synthetic auto-nulls its shadows via the shadowed_by_id FK). Best-effort.
  if (touchedFinance) {
    try {
      await reconcileFinance(ctx.userId);
    } catch {
      // best-effort — erase already removed the rows; the dedup state converges on the next sync.
    }
  }

  return { scope: opts.scope, deleted, total };
}
