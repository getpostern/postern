// @pci/sdk — the CONFORMANCE harness.
//
// A fixture-driven, Vitest-integrating factory that mechanically asserts the connector contract
// (contract.ts / README.md) against any connector. Two layers:
//
//   1. Contract layer (ALWAYS, fixture-driven, no transport, no DB): runs H1–H5, H-types, S3, S4,
//      S6, S7, S8, S10, S11, S12 over the supplied live/deletion RawRecords + the connector instance.
//      This sidesteps the per-connector mock diversity (fetch vs IMAP client-class vs WS socket).
//   2. Integration layer (OPTIONAL, per-connector, describe.skipIf(!DATABASE_URL)): when
//      opts.integration is provided, drives the REAL syncConnection via the connector's OWN mock + a
//      DB to assert H6, H7, H8 (+ S1/S2) end-to-end (reuses each connector's *.db.test setup pattern).
//
// REUSE, DON'T FORK: the harness imports tableForObject / buildUpsert from the runner and REGISTRY
// from schema.ts, so it checks the SAME logic the runner runs (drift-proof). The harness never logs.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { tableForObject, buildUpsert } from "../sync/runner.js";
import type { SyncResult } from "../sync/runner.js";
import { REGISTRY } from "../core/schema.js";
import type { Connector, RawRecord, ActionContext } from "./contract.js";

// ── Fixtures + options (the spec surface) ──────────────────────────────────────────

/** Representative records a connector would emit, for the fixture-driven (transport-agnostic) checks. */
export interface ConformanceFixtures {
  /** The sector(s) this connector is exercised under (google serves two). */
  sectors: string[];
  /** Live RawRecords — at least one per `object` the connector emits, per sector. */
  live: RawRecord[];
  /** Deletion RawRecords (deleted:true). Empty for accepted-none connectors (simplefin/whoop/HA). */
  deletions?: RawRecord[];
  /** Paired (source_object_id from live, externalId from deletion) for the same logical object — S7. */
  deletionPairs?: { sourceObjectId: string; externalId: string }[];
}

export interface ConformanceOpts {
  /** HA-style: sync() legitimately emits no RawRecords (push connector owning its own writes). Skips the emit-driven checks. */
  emitsNoRecords?: boolean;
  /** Connector implements fetchRecordLive AND legitimately stores (HA, a bounded source) — relaxes the "stores nothing" check. */
  fetchRecordLiveStores?: boolean;
  /** Optional integration layer: drive the real syncConnection via this connector's own mock + a DB (gated on DATABASE_URL). */
  integration?: { setup: () => Promise<void>; teardown: () => Promise<void>; ctx: () => unknown };
}

/**
 * What `opts.integration.ctx()` must return (the harness casts the `unknown` to this). The per-connector
 * test file owns the mock + DB wiring; the harness owns the assertions. `ctx()` is called fresh inside
 * each integration `it`, AFTER setup() has created the connection rows.
 */
export interface ConformanceIntegrationCtx {
  /** The connection under test (rows already inserted by setup()). */
  connectionId: string;
  userId: string;
  /** A REGISTRY-backed domain table the connector writes; inspected for H6 (scoping columns). */
  table: string;
  /** A source_object_id guaranteed LIVE in `table` after a productive sync — the H6 row probe. */
  probeSourceObjectId: string;
  /** Install the productive source mock + run ONE real syncConnection (H6/H7). */
  runProductiveSync: () => Promise<SyncResult>;
  /** Optional (fetchRecordLive connectors): install the body mock + invoke fetchRecordLive (H8/S2). */
  runFetchLive?: () => Promise<unknown>;
  /** Optional S1: install a source mock that FAILS with `secret` embedded + run a sync; harness asserts the error is secret-free. */
  runLeakySync?: () => Promise<SyncResult>;
  /** The sentinel secret value S1 asserts never leaks. Required iff runLeakySync is set. */
  secret?: string;
}

// ── Check results (the pure engine; describeConformance wraps these in Vitest its) ──

export interface ConformanceCheck {
  id: string;
  name: string;
  ok: boolean;
  /** Why it failed (or, for a skipped check, why it was exempted). */
  detail?: string;
  /** True ⇒ the check is exempt for this connector (e.g. an emit-driven check on an emitsNoRecords connector). */
  skipped?: boolean;
}

/** The contract-layer check ids, in registration order. (S1/S2/S9 + H6/H7/H8 are integration-only; S5 is an it.todo.) */
export const CONTRACT_CHECK_IDS = [
  "H-types", "S6", "S12", "S4",
  "H1", "H2", "H3", "H4", "H5",
  "S3", "S7", "S8", "S10", "S11",
] as const;

const NAMES: Record<string, string> = {
  "H-types": "required Connector members are present",
  S6: "static (sector, objectType) is a valid REGISTRY pair",
  S12: "policy.mode ∈ {push,poll,on_demand}; poll ⇒ positive defaultIntervalSec",
  S4: "read-only execute() throws / action connector rejects an unknown id",
  H1: "every emitted record resolves to a REGISTRY table via tableForObject",
  H2: "normalize() emits ONLY columns in the REGISTRY allow-list",
  H3: "normalize() returns a non-empty string source_object_id",
  H4: "buildUpsert accepts the injected row (conflict target connection_id, source_object_id)",
  H5: "deletion records carry deleted:true + a non-empty string externalId",
  S3: "strongKeys is deterministic + stable and a Record<string,string>",
  S7: "deletion externalId ↔ live source_object_id are the same id scheme",
  S8: "live RawRecord.externalId is a non-empty string",
  S10: "normalize returns a plain object (not null/array)",
  S11: "normalize does NOT emit the uuid PK 'id'",
};

// Deterministic placeholders for the contract-layer row build (no DB row is written).
const PROBE_CONNECTION_ID = "00000000-0000-0000-0000-0000000000c0";
const PROBE_USER_ID = "00000000-0000-0000-0000-0000000000c1";

/**
 * Build the row the runner would insert (inject connection_id/user_id/raw/ingested_at/deleted_at) —
 * for the H4/H6 checks. Byte-identical to the runner's `insertRow` construction (runner.ts).
 */
export function buildRunnerRow(
  connectionId: string,
  userId: string,
  normalized: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> {
  return {
    connection_id: connectionId,
    user_id: userId,
    ...normalized,
    raw,
    ingested_at: new Date(),
    deleted_at: null,
  };
}

/** True when a thrown/returned error text does NOT contain the secret (the S1 mechanical check). */
export function secretLeakFree(text: string, secret: string): boolean {
  if (secret === "") return true; // an empty sentinel can't be "found" — nothing to assert
  return !text.includes(secret);
}

/** Resolve the (sector, table, fields) for an object across the connector's declared sectors. */
function resolveForObject(
  sectors: string[],
  objectType: string,
): { sector: string; table: string; fields: string[] } | undefined {
  for (const sector of sectors) {
    try {
      const { table, fields } = tableForObject(sector, objectType);
      return { sector, table, fields };
    } catch {
      // try the next declared sector
    }
  }
  return undefined;
}

/** Stable serialization for the strongKeys determinism compare (key-sorted so insertion order is irrelevant). */
function stableStringify(obj: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

/**
 * Run every CONTRACT-LAYER check (pure: no DB, no transport, no Vitest) and return a result per id.
 * describeConformance wraps these in `it`s; the harness's OWN self-tests call this directly to prove a
 * broken fake FAILS the specific check (non-vacuous). Async only because S4 awaits execute().
 */
export async function runContractChecks(
  connector: Connector,
  fixtures: ConformanceFixtures,
  opts: ConformanceOpts = {},
): Promise<ConformanceCheck[]> {
  const results: ConformanceCheck[] = [];
  const emit = !opts.emitsNoRecords;
  const push = (id: string, ok: boolean, detail?: string) =>
    results.push({ id, name: NAMES[id] ?? id, ok, detail });
  const skip = (id: string, detail: string) =>
    results.push({ id, name: NAMES[id] ?? id, ok: true, detail, skipped: true });

  // ── H-types: the required members are present (compile-time; a light runtime presence guard too). ──
  {
    const missing: string[] = [];
    if (typeof connector.provider !== "string" || connector.provider === "") missing.push("provider");
    if (typeof connector.sector !== "string" || connector.sector === "") missing.push("sector");
    if (typeof connector.objectType !== "string" || connector.objectType === "") missing.push("objectType");
    if (connector.policy == null || typeof connector.policy !== "object") missing.push("policy");
    if (!Array.isArray(connector.actions)) missing.push("actions");
    for (const m of ["sync", "normalize", "strongKeys", "execute"] as const) {
      if (typeof connector[m] !== "function") missing.push(m);
    }
    push("H-types", missing.length === 0, missing.length ? `missing/invalid members: ${missing.join(", ")}` : undefined);
  }

  // ── S6: the STATIC (sector, objectType) is a valid REGISTRY pair. ──
  {
    try {
      tableForObject(connector.sector, connector.objectType);
      push("S6", true);
    } catch (err) {
      push("S6", false, err instanceof Error ? err.message : String(err));
    }
  }

  // ── S12: policy.mode ∈ {push,poll,on_demand}; poll ⇒ a positive defaultIntervalSec. ──
  {
    const mode = connector.policy?.mode;
    const okMode = mode === "push" || mode === "poll" || mode === "on_demand";
    let detail: string | undefined;
    if (!okMode) detail = `policy.mode '${String(mode)}' is not one of push|poll|on_demand`;
    else if (mode === "poll") {
      const i = connector.policy.defaultIntervalSec;
      if (typeof i !== "number" || !(i > 0)) detail = "poll policy requires a positive defaultIntervalSec";
    }
    push("S12", detail == null, detail);
  }

  // ── S4: read-only execute() throws; an action connector rejects an unknown action id. ──
  {
    const isActionConnector =
      connector.actions.length > 0 || typeof connector.listActions === "function";
    const actionCtx: ActionContext = {
      userId: PROBE_USER_ID,
      connectionId: "conformance-no-connection",
      secretRef: null,
    };
    let threw = false;
    let result: { ok?: unknown } | undefined;
    try {
      result = (await connector.execute("__conformance_unknown_action__", {}, actionCtx)) as { ok?: unknown };
    } catch {
      threw = true;
    }
    if (isActionConnector) {
      const rejected = threw || (result != null && result.ok === false);
      push("S4", rejected, rejected ? undefined : "action connector accepted an unknown action id");
    } else {
      push("S4", threw, threw ? undefined : "read-only execute() did not throw");
    }
  }

  // ── Emit-driven checks: skipped wholesale for a push connector that owns its own writes (HA). ──
  if (!emit) {
    const why = "exempt: connector emits no RawRecords (push connector owns its own writes)";
    for (const id of ["H1", "H2", "H3", "H4", "H5", "S3", "S7", "S8", "S10", "S11"]) skip(id, why);
    return results;
  }

  // ── Per-live-record checks (one accumulated result per id; first failure wins the detail). ──
  const fail: Record<string, string> = {};
  const liveSourceIds: string[] = [];
  const first = (id: string, detail: string) => {
    if (fail[id] == null) fail[id] = detail;
  };

  for (const rec of fixtures.live) {
    const objectType = rec.object ?? connector.objectType;

    // S8: a live externalId is a non-empty string.
    if (typeof rec.externalId !== "string" || rec.externalId === "") {
      first("S8", `live record for object '${objectType}' has an empty externalId`);
    }

    // H1: the record resolves to a REGISTRY table.
    const resolved = resolveForObject(fixtures.sectors, objectType);
    if (!resolved) {
      first("H1", `object '${objectType}' resolves under none of [${fixtures.sectors.join(", ")}]`);
      continue; // can't run the downstream column checks without a table
    }

    // normalize() — wrapped so a throw becomes a clean H2/H3 failure (real connectors never throw here).
    let norm: unknown;
    try {
      norm = connector.normalize(rec);
    } catch (err) {
      const msg = `normalize threw for object '${objectType}': ${err instanceof Error ? err.message : String(err)}`;
      first("H2", msg);
      first("H3", msg);
      continue;
    }

    // S10: normalize returns a plain object.
    if (norm === null || typeof norm !== "object" || Array.isArray(norm)) {
      first("S10", `normalize returned a non-plain-object for '${objectType}'`);
      continue; // the remaining checks assume an object
    }
    const normObj = norm as Record<string, unknown>;

    // H3: a non-empty string source_object_id.
    const soid = normObj.source_object_id;
    if (typeof soid !== "string" || soid === "") {
      first("H3", `source_object_id is not a non-empty string for '${objectType}'`);
    } else {
      liveSourceIds.push(soid);
    }

    // H2: only REGISTRY-allowed columns.
    const allowed = new Set(resolved.fields);
    for (const col of Object.keys(normObj)) {
      if (!allowed.has(col)) first("H2", `normalize emitted unknown column '${col}' for table ${resolved.table}`);
    }

    // S11: never the uuid PK 'id' (H2 allows it — the REGISTRY lists id — so S11 is the real guard).
    if (Object.hasOwn(normObj, "id")) first("S11", `normalize emitted the uuid PK 'id' for '${objectType}'`);

    // H4: buildUpsert accepts the injected row, conflict target (connection_id, source_object_id).
    try {
      const row = buildRunnerRow(PROBE_CONNECTION_ID, PROBE_USER_ID, normObj, rec.raw);
      const { sql } = buildUpsert(resolved.table, row);
      if (!sql.includes('on conflict ("connection_id", "source_object_id")')) {
        first("H4", `upsert conflict target is not (connection_id, source_object_id) for ${resolved.table}`);
      }
    } catch (err) {
      first("H4", `buildUpsert rejected the row for ${resolved.table}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // S3: strongKeys is deterministic + stable and a Record<string,string>.
    let k1: Record<string, string>;
    let k2: Record<string, string>;
    try {
      k1 = connector.strongKeys(rec);
      k2 = connector.strongKeys(rec);
    } catch (err) {
      first("S3", `strongKeys threw for '${objectType}': ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (stableStringify(k1) !== stableStringify(k2)) {
      first("S3", `strongKeys is non-deterministic for '${objectType}'`);
    }
    for (const [k, v] of Object.entries(k1)) {
      if (typeof v !== "string") first("S3", `strongKeys['${k}'] is not a string for '${objectType}'`);
    }
  }

  for (const id of ["H1", "H2", "H3", "H4", "S3", "S8", "S10", "S11"]) {
    push(id, fail[id] == null, fail[id]);
  }

  // ── H5: every deletion record carries deleted:true + a non-empty string externalId. ──
  {
    let detail: string | undefined;
    for (const del of fixtures.deletions ?? []) {
      if (del.deleted !== true) detail ??= "deletion record is missing deleted:true";
      if (typeof del.externalId !== "string" || del.externalId === "") detail ??= "deletion record has an empty externalId";
    }
    push("H5", detail == null, detail);
  }

  // ── S7: a deletion's externalId uses the same id scheme as the live source_object_id. ──
  {
    let detail: string | undefined;
    const dels = new Set((fixtures.deletions ?? []).map((d) => d.externalId));
    for (const pair of fixtures.deletionPairs ?? []) {
      if (pair.sourceObjectId !== pair.externalId) {
        detail ??= `deletion externalId '${pair.externalId}' ≠ live source_object_id '${pair.sourceObjectId}' (tombstone would miss)`;
      } else if (!liveSourceIds.includes(pair.sourceObjectId)) {
        detail ??= `no live record yields source_object_id '${pair.sourceObjectId}'`;
      } else if (!dels.has(pair.externalId)) {
        detail ??= `no deletion record carries externalId '${pair.externalId}'`;
      }
    }
    push("S7", detail == null, detail);
  }

  return results;
}

/** The known set of REGISTRY-backed table names — the integration layer only ever interpolates one of these. */
const REGISTRY_TABLES = new Set(Object.values(REGISTRY).map((s) => s.table));

/**
 * Register a Vitest describe() block asserting the contract against `connector`. Call at top level of a
 * *.conformance.test.ts. The contract layer always runs (pure); the integration layer runs only when
 * opts.integration is supplied AND DATABASE_URL is set.
 */
export function describeConformance(
  connector: Connector,
  fixtures: ConformanceFixtures,
  opts: ConformanceOpts = {},
): void {
  describe(`conformance: ${connector.provider}`, () => {
    let results: ConformanceCheck[] = [];
    beforeAll(async () => {
      results = await runContractChecks(connector, fixtures, opts);
    });

    for (const id of CONTRACT_CHECK_IDS) {
      it(`[${id}] ${NAMES[id] ?? id}`, () => {
        const r = results.find((x) => x.id === id);
        if (!r) throw new Error(`conformance harness produced no result for ${id}`);
        if (r.skipped) return; // exempt for this connector (e.g. HA emitsNoRecords)
        expect(r.ok, r.detail ?? `${id} failed`).toBe(true);
      });
    }

    // S5 (action param validation) is a documented deferral for action connectors this wave (ADR 0003).
    if (connector.actions.length > 0 || typeof connector.listActions === "function") {
      it.todo("[S5] action params validate against the ActionSpec (wired with the read|act split)");
    }
  });

  if (opts.integration) {
    const integration = opts.integration;
    const hasFetchLive = typeof connector.fetchRecordLive === "function";

    describe.skipIf(!process.env.DATABASE_URL)(`conformance integration: ${connector.provider}`, () => {
      let syncResult: SyncResult;

      beforeAll(async () => {
        await integration.setup();
        const ic = integration.ctx() as ConformanceIntegrationCtx;
        syncResult = await ic.runProductiveSync();
      });
      afterAll(async () => {
        await integration.teardown();
      });

      it("[H6] runner injects connection_id/user_id (not the payload), raw=rec.raw, deleted_at=null", async () => {
        const ic = integration.ctx() as ConformanceIntegrationCtx;
        expect(syncResult.ok, syncResult.error).toBe(true);
        if (!REGISTRY_TABLES.has(ic.table)) throw new Error(`integration: '${ic.table}' is not a REGISTRY table`);
        const { pool } = await import("../db.js");
        const q = await pool.query(
          `select connection_id, user_id, deleted_at, raw is not null as has_raw
             from "${ic.table}" where connection_id = $1 and source_object_id = $2`,
          [ic.connectionId, ic.probeSourceObjectId],
        );
        expect(q.rows.length).toBe(1);
        expect(q.rows[0].connection_id).toBe(ic.connectionId);
        expect(q.rows[0].user_id).toBe(ic.userId);
        expect(q.rows[0].deleted_at).toBeNull();
        expect(q.rows[0].has_raw).toBe(true);
      });

      it("[H7] the cursor advances from a non-null rec.cursor", async () => {
        const ic = integration.ctx() as ConformanceIntegrationCtx;
        expect(syncResult.ok, syncResult.error).toBe(true);
        const { pool } = await import("../db.js");
        const c = await pool.query(`select cursor from connectors where id = $1`, [ic.connectionId]);
        expect(c.rows[0].cursor).not.toBeNull();
      });

      if (hasFetchLive) {
        it("[H8/S2] fetch_live persists nothing (row count unchanged)", async () => {
          const ic = integration.ctx() as ConformanceIntegrationCtx;
          if (!ic.runFetchLive) return; // caller did not wire the drill
          if (!REGISTRY_TABLES.has(ic.table)) throw new Error(`integration: '${ic.table}' is not a REGISTRY table`);
          const { pool } = await import("../db.js");
          const before = await pool.query(
            `select count(*)::int as n from "${ic.table}" where connection_id = $1`,
            [ic.connectionId],
          );
          await ic.runFetchLive();
          const after = await pool.query(
            `select count(*)::int as n from "${ic.table}" where connection_id = $1`,
            [ic.connectionId],
          );
          expect(after.rows[0].n).toBe(before.rows[0].n);
        });
      }

      it("[S1] a sync failure never echoes the secret", async () => {
        const ic = integration.ctx() as ConformanceIntegrationCtx;
        if (!ic.runLeakySync || ic.secret == null) return; // caller did not wire the leak probe
        const res = await ic.runLeakySync();
        expect(res.ok).toBe(false);
        expect(secretLeakFree(res.error ?? "", ic.secret), "the error message leaked the secret").toBe(true);
      });
    });
  }
}
