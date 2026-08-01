// Push-ingest round-trip + auth, gated on DATABASE_URL so CI stays green without Postgres. A FAKE
// push connector (decodePush turns a sample body into live + deletion RawRecords over the real
// health.sample REGISTRY sector) drives the whole edge end-to-end over HTTP, proving:
//   - Auth (fail-closed, no oracle): valid secret -> 200; missing / wrong / paused-connector /
//     unknown-connection -> the SAME 401 with no distinguishing body; auth runs BEFORE readJson (a
//     bad-secret request with garbage JSON still 401s, never a 400 parse error).
//   - Round-trip: decodePush -> ingestRecords upserts rows with connection_id/user_id from the
//     connectors ROW, never the payload (a body that tries to set them / redirect the table is
//     ignored); a deleted:true record tombstones; last_synced_at advances; re-posting is idempotent.
//   - Deterministic externalId synthesis (Apple-Health pattern): records without a native id upsert
//     idempotently on (connection_id, source_object_id).
//   - decodePush absent: a connection whose provider can't accept pushed records -> 400 (not 500).
//   - Mint: returns { ingestUrl, secret } once; only sha256 persists; the raw secret never re-appears.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { createRestApp, type AuditHook } from "./index.js";
import type { Connector, RawRecord } from "../connectors/types.js";

const HAS_DB = !!process.env.DATABASE_URL;
// The admin mint route acts as the operator (LOCAL_USER_ID), so the connections it mints for must be
// the local user's. fake_push / fake_nodecode are providers unique to this test, so they never
// collide with other suites' LOCAL_USER credentials (unique on (user_id, provider)).
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

// ── Fake push connector: decodePush over the real health.sample sector (health_samples table). ──
type PushIn = { externalId?: string; metric?: string; window?: string; value?: number; deleted?: boolean; cursor?: string };

class FakePushConnector implements Connector {
  readonly provider = "fake_push";
  readonly sector = "health";
  readonly objectType = "health_sample";
  readonly policy = { mode: "push" as const, supportsIncremental: false };
  readonly actions = [];
  async *sync(): AsyncIterable<RawRecord> {
    /* ingest never calls sync(); present (yields nothing) to satisfy the Connector contract */
  }
  decodePush(rawBody: unknown): RawRecord[] {
    const b = (rawBody ?? {}) as { records?: PushIn[] };
    return (b.records ?? []).map((r) => ({
      // Deterministic externalId synthesis when the source carries no native id (Apple-Health pattern):
      // overlapping re-exports of the same <metric>:<window> upsert idempotently.
      externalId: r.externalId ?? `${r.metric}:${r.window}`,
      object: "health_sample",
      deleted: r.deleted,
      cursor: r.cursor,
      raw: r,
    }));
  }
  normalize(raw: RawRecord): Record<string, unknown> {
    const r = raw.raw as PushIn;
    return {
      source_object_id: raw.externalId,
      metric_type: r.metric ?? "heart_rate",
      value: r.value ?? null,
      unit: "count/min",
      window_start: r.window ? new Date(r.window) : new Date(),
      source: "fake",
    };
  }
  strongKeys(): Record<string, string> {
    return {};
  }
  async execute() {
    return { ok: false };
  }
}

// ── A pull connector with NO decodePush — the "provider does not accept pushed records" path. ──
class FakeNoDecodeConnector implements Connector {
  readonly provider = "fake_nodecode";
  readonly sector = "finance";
  readonly objectType = "transaction";
  readonly policy = { mode: "poll" as const, supportsIncremental: false };
  readonly actions = [];
  async *sync(): AsyncIterable<RawRecord> {}
  normalize(): Record<string, unknown> {
    return {};
  }
  strongKeys(): Record<string, string> {
    return {};
  }
  async execute() {
    return { ok: false };
  }
}

// ── A push connector WHOSE decodePush THROWS — proves the route scrubs a decode throw to a safe 400
//    (never a 500, never the thrown message verbatim). The throw embeds a sentinel to assert scrubbing. ──
class FakeThrowDecodeConnector implements Connector {
  readonly provider = "fake_throwdecode";
  readonly sector = "health";
  readonly objectType = "health_sample";
  readonly policy = { mode: "push" as const, supportsIncremental: false };
  readonly actions = [];
  async *sync(): AsyncIterable<RawRecord> {}
  decodePush(): RawRecord[] {
    throw new Error("decode boom: SENSITIVE-PAYLOAD-DETAIL");
  }
  normalize(): Record<string, unknown> {
    return {};
  }
  strongKeys(): Record<string, string> {
    return {};
  }
  async execute() {
    return { ok: false };
  }
}

describe.skipIf(!HAS_DB)("push-ingest round-trip + auth (DB)", () => {
  let server: Server;
  let port: number;
  let connId: string;
  let connId2: string;
  let connId3: string;
  let credId: string;
  let credId2: string;
  let credId3: string;
  let secret: string;
  let secret2: string;
  let secret3: string;
  let mintBody: { ingestUrl: string; secret: string };
  const audited: unknown[] = [];
  const captureAudit: AuditHook = (e) => {
    audited.push(e);
  };

  /** HTTP request with full control over the secret header / bearer / Host / body. */
  function req(opts: {
    method?: string;
    path: string;
    host?: string;
    secret?: string;
    bearer?: string;
    body?: string;
  }): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: opts.host ?? "127.0.0.1" };
      if (opts.secret !== undefined) headers["x-pci-webhook-secret"] = opts.secret;
      if (opts.bearer !== undefined) headers["authorization"] = `Bearer ${opts.bearer}`;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const r = httpRequest(
        { host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path, headers, setHost: false },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      r.on("error", reject);
      if (opts.body !== undefined) r.write(opts.body);
      r.end();
    });
  }

  const post = (body: unknown, secretArg = secret) =>
    req({ method: "POST", path: `/api/ingest/${connId}`, secret: secretArg, body: JSON.stringify(body) });

  async function liveRows(): Promise<{ source_object_id: string; connection_id: string; user_id: string }[]> {
    const { pool } = await import("../db.js");
    return (
      await pool.query(
        `select source_object_id, connection_id, user_id from health_samples
           where connection_id = $1 and deleted_at is null order by source_object_id`,
        [connId],
      )
    ).rows;
  }

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { registerConnector } = await import("../sync/index.js");
    registerConnector(new FakePushConnector());
    registerConnector(new FakeNoDecodeConnector());
    registerConnector(new FakeThrowDecodeConnector());

    // Drop any leftovers from a prior aborted run (the seed LOCAL_USER always exists).
    await pool.query(
      `delete from provider_credentials where user_id = $1 and provider in ('fake_push','fake_nodecode','fake_throwdecode')`,
      [LOCAL_USER],
    );

    const c1 = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'fake_push', 'static_token', 'active') returning id`,
      [LOCAL_USER],
    );
    credId = c1.rows[0].id as string;
    const conn1 = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'health', 'fake_push', 'active') returning id`,
      [LOCAL_USER, credId],
    );
    connId = conn1.rows[0].id as string;

    const c2 = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'fake_nodecode', 'static_token', 'active') returning id`,
      [LOCAL_USER],
    );
    credId2 = c2.rows[0].id as string;
    const conn2 = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'fake_nodecode', 'active') returning id`,
      [LOCAL_USER, credId2],
    );
    connId2 = conn2.rows[0].id as string;

    const c3 = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'fake_throwdecode', 'static_token', 'active') returning id`,
      [LOCAL_USER],
    );
    credId3 = c3.rows[0].id as string;
    const conn3 = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'health', 'fake_throwdecode', 'active') returning id`,
      [LOCAL_USER, credId3],
    );
    connId3 = conn3.rows[0].id as string;

    server = createServer(createRestApp({ audit: captureAudit }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    // Mint the secret over the real (localOnly) admin route.
    const m1 = await req({ method: "POST", path: `/api/connectors/${connId}/webhook`, body: "{}" });
    expect(m1.status).toBe(201);
    mintBody = JSON.parse(m1.body);
    secret = mintBody.secret;
    const m2 = await req({ method: "POST", path: `/api/connectors/${connId2}/webhook`, body: "{}" });
    secret2 = JSON.parse(m2.body).secret;
    const m3 = await req({ method: "POST", path: `/api/connectors/${connId3}/webhook`, body: "{}" });
    secret3 = JSON.parse(m3.body).secret;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // FK cascade: credential -> connectors -> health_samples. (LOCAL_USER is the seed — never deleted.)
    await pool.query(`delete from provider_credentials where id = any($1)`, [[credId, credId2, credId3]]);
    await pool.end();
  });

  // ── Mint ──────────────────────────────────────────────────────────────────────
  it("mint returns { ingestUrl, secret } once; only sha256 persisted; raw secret never in the column", async () => {
    const { pool } = await import("../db.js");
    expect(mintBody.ingestUrl).toBe(`/api/ingest/${connId}`);
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(20);

    const row = await pool.query(
      `select webhook_secret_hash, webhook_secret_set_at from connectors where id = $1`,
      [connId],
    );
    expect(row.rows[0].webhook_secret_hash).toBe(sha256Hex(secret));
    expect(row.rows[0].webhook_secret_hash).not.toBe(secret); // the raw secret is NEVER stored
    expect(row.rows[0].webhook_secret_set_at).not.toBeNull();
  });

  it("rotation: a re-mint replaces the hash with a fresh secret's hash", async () => {
    const { pool } = await import("../db.js");
    const before = (await pool.query(`select webhook_secret_hash from connectors where id = $1`, [connId])).rows[0]
      .webhook_secret_hash;
    const m = await req({ method: "POST", path: `/api/connectors/${connId}/webhook`, body: "{}" });
    const rotated = JSON.parse(m.body).secret as string;
    expect(rotated).not.toBe(secret);
    const after = (await pool.query(`select webhook_secret_hash from connectors where id = $1`, [connId])).rows[0]
      .webhook_secret_hash;
    expect(after).toBe(sha256Hex(rotated));
    expect(after).not.toBe(before);
    secret = rotated; // subsequent tests use the current secret
  });

  // ── Auth (fail-closed, identical 401, no oracle) ────────────────────────────────
  const UNAUTH = { error: "unauthorized" };

  it("valid secret -> 200", async () => {
    const res = await post({ records: [] });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it("valid secret via Authorization: Bearer also accepted -> 200", async () => {
    const res = await req({ method: "POST", path: `/api/ingest/${connId}`, bearer: secret, body: JSON.stringify({ records: [] }) });
    expect(res.status).toBe(200);
  });

  it("either-header: a junk X-PCI-Webhook-Secret does NOT mask a valid Bearer -> 200", async () => {
    const res = await req({
      method: "POST",
      path: `/api/ingest/${connId}`,
      secret: "garbage-x-header-value",
      bearer: secret,
      body: JSON.stringify({ records: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("missing secret -> identical 401", async () => {
    const res = await req({ method: "POST", path: `/api/ingest/${connId}`, body: JSON.stringify({ records: [] }) });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual(UNAUTH);
  });

  it("wrong secret -> identical 401", async () => {
    const res = await post({ records: [] }, "definitely-not-the-secret");
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual(UNAUTH);
  });

  it("unknown connection -> identical 401", async () => {
    const res = await req({ method: "POST", path: `/api/ingest/${randomUUID()}`, secret, body: JSON.stringify({ records: [] }) });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual(UNAUTH);
  });

  it("paused connector -> identical 401 (even with the right secret)", async () => {
    const { pool } = await import("../db.js");
    await pool.query(`update connectors set status = 'paused' where id = $1`, [connId]);
    const res = await post({ records: [] });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual(UNAUTH);
    await pool.query(`update connectors set status = 'active' where id = $1`, [connId]);
  });

  it("auth is checked BEFORE readJson: a wrong-secret request with garbage JSON still 401s (not a 400 parse error)", async () => {
    const res = await req({
      method: "POST",
      path: `/api/ingest/${connId}`,
      secret: "wrong",
      body: "this is not valid json {{{",
    });
    expect(res.status).toBe(401); // 400 would mean readJson ran before auth
    expect(JSON.parse(res.body)).toEqual(UNAUTH);
  });

  // ── Round-trip ──────────────────────────────────────────────────────────────────
  it("decodePush -> ingestRecords upserts with connection_id/user_id from the ROW (NOT the payload), idempotently", async () => {
    // A malicious body tries to set connection_id/user_id and redirect the table — all must be ignored.
    const body = {
      connection_id: "11111111-1111-1111-1111-111111111111",
      user_id: "22222222-2222-2222-2222-222222222222",
      object: "finance_transaction",
      records: [
        { externalId: "rt1", metric: "heart_rate", value: 60, window: "2026-01-01T00:00:00Z" },
        { externalId: "rt2", metric: "heart_rate", value: 61, window: "2026-01-01T00:01:00Z" },
      ],
    };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, upserted: 2 });

    const rows = await liveRows();
    const rt = rows.filter((r) => r.source_object_id === "rt1" || r.source_object_id === "rt2");
    expect(rt.length).toBe(2);
    for (const r of rt) {
      expect(r.connection_id).toBe(connId); // from the connectors row, not the payload
      expect(r.user_id).toBe(LOCAL_USER);
    }

    // Re-post the same batch -> idempotent on (connection_id, source_object_id): still exactly 2 rt rows.
    const res2 = await post(body);
    expect(res2.status).toBe(200);
    const rt2 = (await liveRows()).filter((r) => r.source_object_id === "rt1" || r.source_object_id === "rt2");
    expect(rt2.length).toBe(2);
  });

  it("a deleted:true record tombstones (deleted_at set); siblings stay live", async () => {
    const { pool } = await import("../db.js");
    await post({ records: [{ externalId: "del1", metric: "step_count", value: 10 }, { externalId: "del2", metric: "step_count", value: 20 }] });

    const res = await post({ records: [{ externalId: "del1", deleted: true }] });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ deleted: 1 });

    const del1 = await pool.query(
      `select deleted_at from health_samples where connection_id = $1 and source_object_id = 'del1'`,
      [connId],
    );
    expect(del1.rows[0].deleted_at).not.toBeNull();
    const del2 = await pool.query(
      `select deleted_at from health_samples where connection_id = $1 and source_object_id = 'del2'`,
      [connId],
    );
    expect(del2.rows[0].deleted_at).toBeNull();
  });

  it("last_synced_at advances on a push", async () => {
    const { pool } = await import("../db.js");
    await pool.query(`update connectors set last_synced_at = '2000-01-01T00:00:00Z' where id = $1`, [connId]);
    await post({ records: [] });
    const row = await pool.query(`select last_synced_at from connectors where id = $1`, [connId]);
    expect(new Date(row.rows[0].last_synced_at).getTime()).toBeGreaterThan(new Date("2001-01-01T00:00:00Z").getTime());
  });

  it("deterministic synthesized externalId (no native id) upserts idempotently across re-exports", async () => {
    const batch = { records: [{ metric: "spo2", window: "2026-02-02T00:00:00Z", value: 98 }] };
    await post(batch);
    await post(batch); // overlapping re-export
    const { pool } = await import("../db.js");
    const n = await pool.query(
      `select count(*)::int as n from health_samples where connection_id = $1 and source_object_id = 'spo2:2026-02-02T00:00:00Z'`,
      [connId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  // ── decodePush absent ───────────────────────────────────────────────────────────
  it("a provider without decodePush -> 400 (not 500), secret-free", async () => {
    const res = await req({
      method: "POST",
      path: `/api/ingest/${connId2}`,
      secret: secret2,
      body: JSON.stringify({ records: [{ externalId: "x" }] }),
    });
    expect(res.status).toBe(400);
    expect(res.body).not.toContain(secret2);
  });

  // ── Audit (off-path, no secret/body) ─────────────────────────────────────────────
  it("ingest is audited (tool 'ingest') with NO secret/body in the entry", async () => {
    audited.length = 0;
    await post({ records: [{ externalId: "audit1", metric: "heart_rate", value: 70 }] });
    // The audit hook fires off the response path (a microtask) — give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    const ingestEntries = audited.filter((e) => (e as { tool?: string }).tool === "ingest");
    expect(ingestEntries.length).toBeGreaterThan(0);
    expect((ingestEntries[ingestEntries.length - 1] as { decision: string }).decision).toBe("allow");
    expect(JSON.stringify(audited)).not.toContain(secret);
  });

  // ── Hardening: error-lockout fix (wave 8b) ───────────────────────────────────────
  it("a bad batch returns ok:false but does NOT lock out the connection (status stays active; a later good batch succeeds)", async () => {
    const { pool } = await import("../db.js");
    // An empty externalId → normalized source_object_id "" → ingestRecords' per-record validation throws
    // (a "bad batch"). Pre-fix this flipped status='error', 401-ing every later push.
    const bad = await post({ records: [{ externalId: "" }] });
    expect(bad.status).toBe(200);
    expect(JSON.parse(bad.body)).toMatchObject({ ok: false });

    // The connection must NOT have been disabled (no lockout).
    const st = await pool.query(`select status from connectors where id = $1`, [connId]);
    expect(st.rows[0].status).toBe("active");

    // A subsequent good batch from the SAME connection still works.
    const good = await post({
      records: [{ externalId: "nolock1", metric: "heart_rate", value: 61, window: "2026-04-04T00:00:00Z" }],
    });
    expect(good.status).toBe(200);
    expect(JSON.parse(good.body)).toMatchObject({ ok: true });
  });

  // ── Hardening: reserved 'union:' namespace rejection (#37) ──────────────────────
  it("a batch with a reserved 'union:' soid -> 200 ok:false, no row lands, no lockout, later good push succeeds", async () => {
    const { pool } = await import("../db.js");
    // The fake connector normalizes source_object_id = externalId, so this batch tries to PLANT a
    // row in the finance-dedup engine's reserved namespace — applyRecords must reject it fail-closed.
    const bad = await post({
      records: [{ externalId: "union:forged", metric: "heart_rate", value: 62, window: "2026-05-05T00:00:00Z" }],
    });
    expect(bad.status).toBe(200);
    expect(JSON.parse(bad.body)).toMatchObject({ ok: false });

    // The forged synthetic never landed.
    const forged = await pool.query(
      `select count(*)::int as n from health_samples where connection_id = $1 and source_object_id like 'union:%'`,
      [connId],
    );
    expect(forged.rows[0].n).toBe(0);

    // No lockout (wave-8b semantics): status stays active…
    const st = await pool.query(`select status from connectors where id = $1`, [connId]);
    expect(st.rows[0].status).toBe("active");

    // …and a subsequent good batch from the SAME connection still works.
    const good = await post({
      records: [{ externalId: "afterunion1", metric: "heart_rate", value: 63, window: "2026-05-05T00:01:00Z" }],
    });
    expect(good.status).toBe(200);
    expect(JSON.parse(good.body)).toMatchObject({ ok: true });
  });

  // ── Hardening: decodePush scrub (wave 8b) ────────────────────────────────────────
  it("a decodePush throw is scrubbed to a safe 400 (not a 500; no thrown detail; secret-free)", async () => {
    const res = await req({
      method: "POST",
      path: `/api/ingest/${connId3}`,
      secret: secret3,
      body: JSON.stringify({ anything: true }),
    });
    expect(res.status).toBe(400);
    expect(res.body).not.toContain("SENSITIVE-PAYLOAD-DETAIL"); // the connector's thrown message is scrubbed
    expect(res.body).not.toContain(secret3);
  });
});
