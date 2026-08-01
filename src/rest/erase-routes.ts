// erase route — POST /api/erase. The operator's data-destruction verb over the loopback admin
// contract (wave 10, ADR 0012). Registered `localOnly` by the mother at merge: reachability already
// implies operator trust (the edge binds 127.0.0.1 + the Host-allowlist DNS-rebinding guard). The
// confirmation token is a fat-finger guard, NOT auth.
//
// Flow: parse + validate the body shape → require the scope's id → check the confirmation token
// (BEFORE any DELETE; a mismatch is a 400 with ZERO rows deleted) → eraseData (user-scoped to the
// local operator) → 200 {scope, deleted, total}. Foreign/unknown connectionId surfaces as 404 from
// eraseData. One async audit entry (tool 'erase') is fired off the response path — never awaited,
// carries no secrets (args = {scope, connectionId?, sector?} only).

import { z } from "zod";
import { eraseData } from "../core/erase.js";
import { resolveLocal } from "../auth/index.js";
import { sendJson, ValidationError, type RouteContext } from "./router.js";
import type { AuditHook } from "./index.js";

/** Validated erase request body. `confirm` is always required (the fat-finger guard). */
const eraseBody = z.object({
  scope: z.enum(["connection", "sector", "all"]),
  connectionId: z.string().min(1).optional(),
  sector: z.string().min(1).optional(),
  confirm: z.string().min(1),
});

/**
 * The erase audit line. `tool` is "erase" — a value the writer accepts at runtime (the audit_log
 * `tool` column is free text); the rest-edge AuditHook port enumerates only the read tools (and the
 * injected audit-writer is typed to those), so this entry is cast at the injection boundary. It
 * carries NO secret — only the scope/target + how many rows left + the outcome.
 */
interface EraseAuditEntry {
  userId: string | null;
  agentId: string | null;
  tool: "erase";
  decision: "allow" | "deny";
  args?: unknown;
  resultCount?: number | null;
  outcome?: "ok" | "error" | null;
}

/** Fire the injected audit hook off the response path. Never awaited; a throwing sink can't escape. */
function fireAudit(audit: AuditHook | undefined, entry: EraseAuditEntry): void {
  if (!audit) return;
  try {
    // Intentionally not awaited: detective, async, zero hot-path cost. The cast is the single
    // injection-boundary widening — the audit-writer writes any tool string; the port type does not
    // enumerate "erase" (and is not ours to extend without breaking the writer's direct assignment).
    void Promise.resolve()
      .then(() => audit(entry as unknown as Parameters<AuditHook>[0]))
      .catch(() => {});
  } catch {
    // A synchronous throw from the hook must never affect the response.
  }
}

/**
 * POST /api/erase — body `{ scope, connectionId?, sector?, confirm }`. The handler reads the parsed
 * body (the mother wires it via withBody) and the injected audit hook. Validation/confirm failures
 * throw ValidationError (→ 400) BEFORE any erase runs; a foreign connectionId throws NotFoundError
 * (→ 404) from eraseData.
 */
export async function eraseRoute(ctx: RouteContext, body: unknown, audit?: AuditHook): Promise<void> {
  const parsed = eraseBody.safeParse(body);
  if (!parsed.success) throw new ValidationError("invalid request body");
  const { scope, connectionId, sector, confirm } = parsed.data;

  // Require the scope's id, then verify the confirmation token matches a server-resolvable value.
  // BOTH run before any DELETE, so a mismatch is a 400 with zero rows touched.
  let expectedConfirm: string;
  if (scope === "connection") {
    if (!connectionId) throw new ValidationError("connectionId is required for scope 'connection'");
    expectedConfirm = connectionId;
  } else if (scope === "sector") {
    if (!sector) throw new ValidationError("sector is required for scope 'sector'");
    expectedConfirm = sector;
  } else {
    expectedConfirm = "ERASE-ALL";
  }
  if (confirm !== expectedConfirm) {
    throw new ValidationError("confirmation token does not match the requested scope");
  }

  const operator = await resolveLocal();
  const auditArgs = { scope, ...(connectionId ? { connectionId } : {}), ...(sector ? { sector } : {}) };

  try {
    const result = await eraseData(operator, { scope, connectionId, sector });
    fireAudit(audit, {
      userId: operator.userId,
      agentId: operator.agentId,
      tool: "erase",
      decision: "allow",
      args: auditArgs,
      resultCount: result.total,
      outcome: "ok",
    });
    sendJson(ctx.res, 200, result);
  } catch (err) {
    // Audit the attempted-but-failed erase too (detective oversight), then rethrow so the dispatcher's
    // errorToStatus maps it (NotFoundError → 404, QueryValidationError → 400). The error is secret-free.
    fireAudit(audit, {
      userId: operator.userId,
      agentId: operator.agentId,
      tool: "erase",
      decision: "allow",
      args: auditArgs,
      outcome: "error",
    });
    throw err;
  }
}
