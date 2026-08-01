// The record drill mirrors the stored row — it never summarises. These pin the split: NORMALIZED is
// the scalars, PROVENANCE is the connection/tombstone/dedup, and the system + jsonb columns never
// leak into NORMALIZED (raw has its own verbatim block).

import { describe, expect, it } from "vitest";
import {
  dedupLabel,
  normalizedEntries,
  provenanceEntries,
  recordHeadline,
  recordSubtitle,
} from "./record";
import type { Row } from "../../api/types";

// A finance.transaction as getRecord() returns it (select * — full row incl. system/dedup/raw).
const txn: Row = {
  id: "row-uuid",
  user_id: "user-uuid",
  connection_id: "conn-uuid",
  source_object_id: "sfin_txn_8f3a2c",
  posted_at: "2026-02-14T00:00:00.000Z",
  amount: "-6.50",
  currency: "USD",
  merchant: "Blue Bottle Coffee",
  category: "FOOD_AND_DRINK",
  pending: false,
  dedup_status: "unique",
  shadowed_by_id: null,
  dedup_group_id: null,
  ingested_at: "2026-02-14T09:12:00.000Z",
  deleted_at: null,
  raw: { id: "sfin_txn_8f3a2c", amount: "-6.50" },
};

describe("normalizedEntries — scalars only, never the system/jsonb columns", () => {
  const keys = normalizedEntries(txn).map((e) => e.key);

  it("shows the normalized scalars", () => {
    expect(keys).toEqual(
      expect.arrayContaining(["amount", "currency", "merchant", "category", "pending", "posted_at"]),
    );
  });

  it("never leaks a system, provenance, or jsonb column into NORMALIZED", () => {
    for (const forbidden of [
      "id",
      "user_id",
      "connection_id",
      "source_object_id",
      "ingested_at",
      "deleted_at",
      "shadowed_by_id",
      "dedup_group_id",
      "raw",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("mirrors values without deriving — a timestamp is formatted, a bool reads plainly", () => {
    const map = Object.fromEntries(normalizedEntries(txn).map((e) => [e.key, e.value]));
    expect(map.posted_at).toBe("2026-02-14");
    expect(map.pending).toBe("false");
    expect(map.merchant).toBe("Blue Bottle Coffee");
  });
});

describe("provenanceEntries", () => {
  it("names the provider when the connector is resolved; live when not tombstoned", () => {
    const entries = provenanceEntries(txn, "SimpleFIN", false);
    const map = Object.fromEntries(entries.map((e) => [e.key, e.value]));
    expect(map.connection).toBe("SimpleFIN");
    expect(map.source_object_id).toBe("sfin_txn_8f3a2c");
    expect(map.deleted_at).toBe("— · live");
    expect(map.dedup).toBe("not shadowed");
  });

  it("falls back to the raw connection_id when the connector isn't loaded", () => {
    const entries = provenanceEntries(txn, null, false);
    const map = Object.fromEntries(entries.map((e) => [e.key, e.value]));
    expect(map.connection).toBe("conn-uuid");
  });

  it("a tombstoned row reads its deleted clock, truthfully", () => {
    const dead: Row = { ...txn, deleted_at: "2026-03-01T10:00:00.000Z" };
    const map = Object.fromEntries(provenanceEntries(dead, "SimpleFIN", false).map((e) => [e.key, e.value]));
    expect(map.deleted_at).toContain("tombstoned");
  });
});

describe("dedupLabel — finance-aware", () => {
  it("a shadowed provider row", () => {
    expect(dedupLabel({ ...txn, shadowed_by_id: "win-1" })).toBe("shadowed by a merge");
  });
  it("a merged winner", () => {
    expect(dedupLabel({ ...txn, shadowed_by_id: null, dedup_group_id: "grp-1" })).toBe("merged (winner)");
  });
  it("a pristine un-merged finance row", () => {
    expect(dedupLabel(txn)).toBe("not shadowed");
  });
  it("a non-finance row has no shadow columns at all", () => {
    expect(dedupLabel({ id: "x", subject: "hi" })).toBe("not deduped");
  });
});

describe("recordHeadline + recordSubtitle", () => {
  it("headline picks the object's identity field", () => {
    expect(recordHeadline("finance.transaction", txn)).toBe("Blue Bottle Coffee");
    expect(recordHeadline("home", { entity_id: "light.kitchen" })).toBe("light.kitchen");
  });

  it("a sleep session's headline distinguishes a nap", () => {
    expect(recordHeadline("health.sleep_session", { is_nap: true })).toBe("Nap");
    expect(recordHeadline("health.sleep_session", { is_nap: false })).toBe("Sleep session");
  });

  it("subtitle composes lead value · primaryTime · via provider, omitting absent parts", () => {
    expect(recordSubtitle("finance.transaction", txn, "SimpleFIN")).toBe(
      "−$6.50 · 2026-02-14 · via SimpleFIN",
    );
  });

  it("subtitle drops the provider clause when no connector resolved", () => {
    expect(recordSubtitle("finance.transaction", txn, null)).toBe("−$6.50 · 2026-02-14");
  });
});
