// Self-tests for the conformance harness — proving it actually CATCHES violations (no vacuous green).
//
// We call the pure engine `runContractChecks` directly (NOT describeConformance, which would register
// failing Vitest tests) against deliberately-broken fake connectors / fixtures, and assert the SPECIFIC
// check fails for each of H1–H5, S3, S7, S8, S10, S11, S12 — while a minimal VALID fake passes them
// all. Plus the S1 secret-free mechanical check (secretLeakFree) on an embedded sentinel.

import { describe, it, expect } from "vitest";
import {
  runContractChecks,
  secretLeakFree,
  CONTRACT_CHECK_IDS,
  type ConformanceFixtures,
} from "./conformance.js";
import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
  ActionContext,
} from "./contract.js";

// ── A configurable fake connector (defaults are fully VALID against finance.transaction). ──

interface FakeOpts {
  sector?: string;
  objectType?: string;
  policy?: SyncPolicy;
  actions?: ActionSpec[];
  listActions?: Connector["listActions"];
  normalize?: (rec: RawRecord) => unknown;
  strongKeys?: (rec: RawRecord) => Record<string, string>;
  execute?: (id: string, params: Record<string, unknown>, ctx: ActionContext) => Promise<ActionResult>;
}

class FakeConnector implements Connector {
  readonly provider = "fake";
  readonly sector: string;
  readonly objectType: string;
  readonly policy: SyncPolicy;
  readonly actions: ActionSpec[];
  readonly listActions?: Connector["listActions"];
  private readonly normalizeImpl: (rec: RawRecord) => unknown;
  private readonly strongKeysImpl: (rec: RawRecord) => Record<string, string>;
  private readonly executeImpl: (id: string, params: Record<string, unknown>, ctx: ActionContext) => Promise<ActionResult>;

  constructor(o: FakeOpts = {}) {
    this.sector = o.sector ?? "finance";
    this.objectType = o.objectType ?? "transaction";
    this.policy = o.policy ?? { mode: "poll", defaultIntervalSec: 3600, supportsIncremental: true };
    this.actions = o.actions ?? [];
    if (o.listActions) this.listActions = o.listActions;
    this.normalizeImpl =
      o.normalize ?? ((rec) => ({ source_object_id: rec.externalId, amount: "1.00", currency: "USD" }));
    this.strongKeysImpl = o.strongKeys ?? (() => ({ txn_id: "k" }));
    this.executeImpl =
      o.execute ??
      (async () => {
        throw new Error("fake has no actions (read-only)");
      });
  }

  // eslint-disable-next-line require-yield
  async *sync(_ctx: SyncContext): AsyncIterable<RawRecord> {
    return;
  }
  normalize(rec: RawRecord): unknown {
    return this.normalizeImpl(rec);
  }
  strongKeys(rec: RawRecord): Record<string, string> {
    return this.strongKeysImpl(rec);
  }
  async execute(id: string, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
    return this.executeImpl(id, params, ctx);
  }
}

// ── Valid fixtures (a transaction + its deletion, paired by the same id). ──
const LIVE_TXN: RawRecord = { object: "transaction", externalId: "txn-1", raw: { transaction_id: "txn-1" } };
const DEL_TXN: RawRecord = { object: "transaction", deleted: true, externalId: "txn-1", raw: { transaction_id: "txn-1" } };
const VALID: ConformanceFixtures = {
  sectors: ["finance"],
  live: [LIVE_TXN],
  deletions: [DEL_TXN],
  deletionPairs: [{ sourceObjectId: "txn-1", externalId: "txn-1" }],
};

function isOk(results: Awaited<ReturnType<typeof runContractChecks>>, id: string): boolean {
  return results.find((r) => r.id === id)?.ok === true;
}

describe("conformance harness — a minimal VALID fake passes", () => {
  it("passes every contract-layer check (no failures, no skips)", async () => {
    const results = await runContractChecks(new FakeConnector(), VALID);
    expect(results.length).toBe(CONTRACT_CHECK_IDS.length);
    const failures = results.filter((r) => !r.ok);
    expect(failures, JSON.stringify(failures)).toEqual([]);
    expect(results.some((r) => r.skipped)).toBe(false);
  });
});

describe("conformance harness — a broken fake FAILS the specific check", () => {
  it("H1: a record whose object resolves to no REGISTRY table", async () => {
    const fx: ConformanceFixtures = { ...VALID, live: [{ object: "nonexistent_object", externalId: "x", raw: {} }] };
    const r = await runContractChecks(new FakeConnector(), fx);
    expect(isOk(r, "H1")).toBe(false);
  });

  it("H2: normalize emits a column outside the REGISTRY allow-list", async () => {
    const c = new FakeConnector({ normalize: (rec) => ({ source_object_id: rec.externalId, not_a_column: "x" }) });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "H2")).toBe(false);
  });

  it("H3: normalize returns an empty-string source_object_id (H4 stays green — the column is present)", async () => {
    const c = new FakeConnector({ normalize: () => ({ source_object_id: "" }) });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "H3")).toBe(false);
    expect(isOk(r, "H4")).toBe(true);
  });

  it("H4: normalize omits source_object_id entirely (buildUpsert rejects the row)", async () => {
    const c = new FakeConnector({ normalize: () => ({ amount: "1.00" }) });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "H4")).toBe(false);
  });

  it("H5: a deletion record with an empty externalId", async () => {
    const fx: ConformanceFixtures = {
      ...VALID,
      deletions: [{ object: "transaction", deleted: true, externalId: "", raw: null }],
    };
    const r = await runContractChecks(new FakeConnector(), fx);
    expect(isOk(r, "H5")).toBe(false);
  });

  it("S3: strongKeys is non-deterministic", async () => {
    let n = 0;
    const c = new FakeConnector({ strongKeys: () => ({ txn_id: String(n++) }) });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S3")).toBe(false);
  });

  it("S3: strongKeys returns a non-string value", async () => {
    const c = new FakeConnector({ strongKeys: () => ({ txn_id: 7 as unknown as string }) });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S3")).toBe(false);
  });

  it("S7: a deletion externalId that diverges from the live source_object_id (tombstone would miss)", async () => {
    const fx: ConformanceFixtures = { ...VALID, deletionPairs: [{ sourceObjectId: "txn-1", externalId: "DIFFERENT" }] };
    const r = await runContractChecks(new FakeConnector(), fx);
    expect(isOk(r, "S7")).toBe(false);
  });

  it("S8: a live record with an empty externalId", async () => {
    const fx: ConformanceFixtures = {
      ...VALID,
      live: [{ object: "transaction", externalId: "", raw: { transaction_id: "txn-1" } }],
    };
    const r = await runContractChecks(new FakeConnector(), fx);
    expect(isOk(r, "S8")).toBe(false);
  });

  it("S10: normalize returns a non-plain-object (an array)", async () => {
    const c = new FakeConnector({ normalize: () => ["not", "an", "object"] });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S10")).toBe(false);
  });

  it("S11: normalize emits the uuid PK 'id' (which H2 would permit — the REGISTRY lists id)", async () => {
    const c = new FakeConnector({ normalize: (rec) => ({ source_object_id: rec.externalId, id: "leaked-pk" }) });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S11")).toBe(false);
    expect(isOk(r, "H2")).toBe(true); // proves S11 catches what H2 cannot
  });

  it("S12: an invalid policy.mode", async () => {
    const c = new FakeConnector({ policy: { mode: "bogus" as unknown as SyncPolicy["mode"], supportsIncremental: false } });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S12")).toBe(false);
  });

  it("S12: a poll policy missing a positive defaultIntervalSec", async () => {
    const c = new FakeConnector({ policy: { mode: "poll", supportsIncremental: true } });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S12")).toBe(false);
  });

  it("S4: a read-only execute() that does NOT throw", async () => {
    const c = new FakeConnector({ execute: async () => ({ ok: true }) });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S4")).toBe(false);
  });

  it("S6: a static (sector, objectType) that is not a REGISTRY pair", async () => {
    const c = new FakeConnector({ sector: "finance", objectType: "not_an_object" });
    const r = await runContractChecks(c, VALID);
    expect(isOk(r, "S6")).toBe(false);
  });
});

describe("conformance harness — the emitsNoRecords (HA-style) exemption", () => {
  it("skips the emit-driven checks but still asserts H-types/S6/S12/S4", async () => {
    const pushFake = new FakeConnector({
      sector: "home",
      objectType: "home_entity",
      policy: { mode: "push", supportsIncremental: false },
      listActions: async () => [],
      execute: async () => ({ ok: false, detail: "no connection" }), // action connector: rejects unknown id
    });
    const r = await runContractChecks(pushFake, { sectors: ["home"], live: [], deletions: [] }, { emitsNoRecords: true });
    // The always-checks hold.
    for (const id of ["H-types", "S6", "S12", "S4"]) expect(isOk(r, id), id).toBe(true);
    // The emit-driven checks are skipped (exempt), not failed.
    for (const id of ["H1", "H2", "H3", "H4", "H5", "S3", "S7", "S8", "S10", "S11"]) {
      const c = r.find((x) => x.id === id);
      expect(c?.skipped, id).toBe(true);
      expect(c?.ok, id).toBe(true);
    }
  });

  it("an action connector with a non-rejecting execute fails S4", async () => {
    const badAction = new FakeConnector({
      sector: "home",
      objectType: "home_entity",
      policy: { mode: "push", supportsIncremental: false },
      listActions: async () => [],
      execute: async () => ({ ok: true }), // accepts an unknown action id → S4 fail
    });
    const r = await runContractChecks(badAction, { sectors: ["home"], live: [], deletions: [] }, { emitsNoRecords: true });
    expect(isOk(r, "S4")).toBe(false);
  });
});

describe("conformance harness — S1 secret-free mechanical check", () => {
  const SENTINEL = "S3NT1NEL-app-password-do-not-log";

  it("passes when the error text never contains the embedded sentinel", () => {
    expect(secretLeakFree("gmail: sync failed (status 401)", SENTINEL)).toBe(true);
  });

  it("FAILS when an error echoes the embedded sentinel (proving the check is real)", () => {
    expect(secretLeakFree(`FAKE-IMAP auth refused [pass=${SENTINEL}]`, SENTINEL)).toBe(false);
  });
});
