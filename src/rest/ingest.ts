// Push-ingest endpoint — POST /api/ingest/:connectionId. The ONE way an external source pushes
// records INTO the gateway (a phone exporting Apple Health today; a Plaid notification later). The
// route stays generic: it authenticates the per-connection webhook secret, then delegates payload →
// records to the connector's decodePush and runs the result through the SAME runner path as a pull
// sync (ingestRecords) — no duplicate normalize/upsert/tombstone logic.
//
// SECURITY (fail-closed, in order):
//   1. Auth is checked FIRST, BEFORE the body is read/parsed — a bad-secret request with a huge or
//      garbage body still 401s without ever buffering or parsing it.
//   2. Every auth failure (no row / not active / no secret set / wrong secret / malformed id) throws
//      an IDENTICAL 401 with no distinguishing detail — no existence oracle.
//   3. The secret compare is CONSTANT-TIME over the sha256 hashes (timingSafeEqual on two 32-byte
//      buffers), never a string ==.
//   4. connection_id/user_id/table are taken from the connectors ROW (via ingestRecords), NEVER from
//      the pushed body — a pusher cannot choose its owner, table, or target.
// The route is registered WITHOUT the Host-allowlist (it is intentionally external; the per-connection
// secret is its gate, mirroring how the bearer mirror routes are bare). Secrets/bodies are NEVER
// logged or echoed.
//
// DESIGNED-FOR (deferred): a future provider whose webhook is a NOTIFICATION (Plaid
// SYNC_UPDATES_AVAILABLE) needs (a) signature verification rather than a shared secret and (b)
// "decode → trigger syncConnection" rather than "decode → ingestRecords". The endpoint will branch on
// a connector-declared verifyWebhook(headers, rawBody) + a pushMode 'records'|'ping'; V0 ships the
// 'records'/header-secret mode only. (The auth-before-parse ordering keeps the raw-body-first
// signature path open.)

import { createHash, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { getConnector, ingestRecords } from "../sync/index.js";
import { readJson, sendJson, UnauthorizedError, ValidationError, MAX_INGEST_BODY_BYTES, type RouteContext } from "./router.js";
import type { AuditHook } from "./index.js";
import type { RawRecord } from "../connectors/types.js";

/** A valid v4-shaped uuid (the connectors.id form). A non-uuid path id is treated as "unknown" (401). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ingest audit line. `tool` is "ingest" — a value the writer accepts at runtime (the audit_log
 * `tool` column is free text); the rest-edge AuditHook port enumerates only the read tools (and the
 * injected audit-writer is typed to those), so this entry is cast at the injection boundary. It
 * carries NO secret and NO body — only the decision + how many records landed.
 */
interface IngestAuditEntry {
  userId: string | null;
  agentId: string | null;
  tool: "ingest";
  sector?: string | null;
  decision: "allow" | "deny";
  denyReason?: string | null;
  resultCount?: number | null;
}

/** Fire the injected audit hook off the response path. Never awaited; a throwing sink can't escape. */
function fireAudit(audit: AuditHook | undefined, entry: IngestAuditEntry): void {
  if (!audit) return;
  try {
    // Intentionally not awaited: detective, async, zero hot-path cost. The cast is the single
    // injection-boundary widening — the audit-writer writes any tool string; the port type does not
    // enumerate "ingest" (and is not ours to extend without breaking the writer's direct assignment).
    void Promise.resolve()
      .then(() => audit(entry as unknown as Parameters<AuditHook>[0]))
      .catch(() => {});
  } catch {
    // A synchronous throw from the hook must never affect the response.
  }
}

/**
 * Candidate webhook secrets presented on the request — from `X-PCI-Webhook-Secret` AND/OR
 * `Authorization: Bearer`. BOTH are returned (deduped to the non-empty ones): the constant-time
 * compare runs against EACH, so a junk X-header can't mask a valid Bearer (or vice-versa). Empty
 * array = nothing presented.
 */
function presentedSecrets(ctx: RouteContext): string[] {
  const out: string[] = [];
  const x = ctx.req.headers["x-pci-webhook-secret"];
  if (typeof x === "string" && x.length > 0) out.push(x);
  const auth = ctx.req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Constant-time secret check: sha256(presented) vs the stored sha256 hex, compared with
 * timingSafeEqual over two 32-byte buffers (never a string ==). A non-32-byte stored hash (should
 * never happen — we only ever store sha256 hex) fails closed rather than throwing.
 */
function secretMatches(storedHashHex: string, presented: string): boolean {
  const presentedHash = createHash("sha256").update(presented).digest(); // 32-byte Buffer
  const storedHash = Buffer.from(storedHashHex, "hex");
  if (storedHash.length !== presentedHash.length) return false;
  return timingSafeEqual(storedHash, presentedHash);
}

/**
 * POST /api/ingest/:connectionId — authenticated push of records into the gateway.
 *
 * Auth FIRST (before any body read): load the connection's identity + secret hash and verify the
 * presented secret in constant time. Any failure → an identical 401 (no oracle). Only on success:
 * read+parse the body (1MB cap), connector.decodePush → RawRecords, ingestRecords. Audit off-path.
 */
export async function ingestPush(ctx: RouteContext, audit?: AuditHook): Promise<void> {
  const connectionId = ctx.params.connectionId;

  // ── 1. AUTH FIRST — before reading the body. A malformed id skips the DB (no bad-uuid 500) and
  //    falls straight into the identical 401 below. ──
  const row = UUID_RE.test(connectionId)
    ? (
        await pool.query(
          `select user_id, provider, sector, status, webhook_secret_hash from connectors where id = $1`,
          [connectionId],
        )
      ).rows[0]
    : undefined;

  const presented = presentedSecrets(ctx);
  const storedHash = (row?.webhook_secret_hash ?? null) as string | null;

  // Identical 401 for: no row, not active, no secret set, none presented, or no presented secret
  // matching (each candidate header is checked in constant time).
  const authorized =
    !!row &&
    row.status === "active" &&
    storedHash !== null &&
    presented.some((p) => secretMatches(storedHash, p));
  if (!authorized) {
    fireAudit(audit, { userId: null, agentId: null, tool: "ingest", decision: "deny", denyReason: "unauthorized" });
    throw new UnauthorizedError("unauthorized");
  }

  const userId = row.user_id as string;
  const provider = row.provider as string;
  const sector = row.sector as string;

  // ── 2. Only AFTER auth: read + parse the body (1MB cap), decode → records, ingest. ──
  const body = await readJson(ctx.req, MAX_INGEST_BODY_BYTES); // larger cap — device exports (Apple Health) are multi-MB; PayloadTooLargeError / ValidationError -> 400

  // ── Debug capture (#29): OFF by default. When PCI_INGEST_DEBUG_DIR is set, dump each AUTHENTICATED
  //    body to a file there so a device's real payload shape can be diffed offline (deliberately before
  //    decodePush — the un-decodable payload is the one worth capturing). The body may carry personal
  //    data: the dir must be operator-controlled, never a log stream. Best-effort — never blocks ingest.
  const debugDir = process.env.PCI_INGEST_DEBUG_DIR;
  if (debugDir) {
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(debugDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await writeFile(`${debugDir}/ingest-${connectionId}-${stamp}.json`, JSON.stringify(body));
    } catch {
      /* capture is best-effort */
    }
  }

  const connector = getConnector(provider);
  if (!connector || typeof connector.decodePush !== "function") {
    // A connection whose provider does not accept pushed records -> 400 (not a 500), secret-free.
    throw new ValidationError("provider does not accept pushed records");
  }
  // Scrub a decode throw: a malformed payload must become a safe 400, never a 500 that could leak the
  // connector's thrown message (it may echo payload detail). The error carries no secret and no body.
  let records: RawRecord[];
  try {
    records = connector.decodePush(body);
  } catch {
    throw new ValidationError("malformed push payload");
  }

  const result = await ingestRecords(connectionId, records); // never throws

  // ── 3. Audit off-path: NO secret, NO body — just the authorized decision + how many records landed. ──
  fireAudit(audit, {
    userId,
    agentId: null,
    tool: "ingest",
    sector,
    decision: "allow",
    resultCount: result.upserted + result.deleted,
  });

  // Summary only — never the SyncResult.error (could carry internal detail), never the body.
  sendJson(ctx.res, 200, { ok: result.ok, upserted: result.upserted, deleted: result.deleted });
}
