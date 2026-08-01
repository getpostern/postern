// The REGISTRY's PUBLISHED semantics — DB-free. `fieldDocs`/`notes` are authored static text that
// agents act on, so the things worth pinning are (a) that a doc never names a column that does not
// exist, (b) that the conventions which produce a WRONG NUMBER are actually stated, and (c) that the
// docs map never becomes a second, wider allow-list (that half is pinned in query.test.ts).

import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { REGISTRY, UNION_SOID_PREFIX, UUID_RE, objectKeysFor } from "./schema.js";

describe("fieldDocs — authored, static, and anchored to real columns", () => {
  it("every fieldDocs key names a real column in fields", () => {
    for (const [key, schema] of Object.entries(REGISTRY)) {
      const fields = Object.keys(schema.fields);
      for (const documented of Object.keys(schema.fieldDocs ?? {})) {
        expect(fields, `REGISTRY '${key}' documents '${documented}', which is not a column`).toContain(
          documented,
        );
      }
    }
  });

  it("every object carries notes and every finance object documents its sign convention", () => {
    for (const [key, schema] of Object.entries(REGISTRY)) {
      expect(typeof schema.notes, `REGISTRY '${key}' has no notes`).toBe("string");
      expect((schema.notes ?? "").length, `REGISTRY '${key}' has empty notes`).toBeGreaterThan(20);
    }
    // The one convention that turns a correct query into a wrong answer.
    const amount = REGISTRY["finance.transaction"].fieldDocs!.amount;
    expect(amount).toMatch(/negative/i);
    expect(amount).toMatch(/spend/i);
    expect(REGISTRY["finance.account"].fieldDocs!.current_balance).toMatch(/negative/i);
  });

  it("pending and dedup_status are documented as unrelated", () => {
    const docs = REGISTRY["finance.transaction"].fieldDocs!;
    expect(docs.pending).toContain("dedup_status");
    expect(docs.dedup_status).toContain("pending");
  });
});

describe('"uuid" is a declared field type', () => {
  it("id is declared uuid on every REGISTRY object", () => {
    for (const [key, schema] of Object.entries(REGISTRY)) {
      expect(schema.fields.id, `REGISTRY '${key}' declares id as ${schema.fields.id}`).toBe("uuid");
    }
  });

  it("the provider-text id columns stay text (only `id` is a row uuid)", () => {
    // source_object_id / account_source_id / recurrence_master_id are the PROVIDER's own ids —
    // arbitrary strings. Declaring them uuid would reject every legitimate filter on them.
    expect(REGISTRY["finance.transaction"].fields.source_object_id).toBe("text");
    expect(REGISTRY["finance.transaction"].fields.account_source_id).toBe("text");
    expect(REGISTRY.calendar.fields.recurrence_master_id).toBe("text");
  });

  it("UUID_RE accepts a real row uuid and rejects near-misses", () => {
    expect(UUID_RE.test(randomUUID())).toBe(true);
    expect(UUID_RE.test("00000000-0000-0000-0000-000000000000")).toBe(true);
    for (const bad of [
      "",
      "abc",
      "11111111-2222-4333-8444-55555555555", // one hex digit short
      "11111111-2222-4333-8444-555555555555 ", // trailing space
      " 11111111-2222-4333-8444-555555555555",
      "11111111-2222-4333-8444-55555555555g", // not hex
      "11111111222243338444555555555555", // no dashes
      "x11111111-2222-4333-8444-555555555555", // unanchored regexes accept this
    ]) {
      expect(UUID_RE.test(bad), `UUID_RE should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("the core-applied columns stay OUT of `fields` — which IS the ingest write allow-list (#65/#122)", () => {
  // `fields` has TWO jobs: the read vocabulary AND applyRecords' write allow-list (it reads
  // Object.keys(fields), and a normalized column outside it is a hard sync failure — the mechanism is
  // pinned in src/sync/runner.test.ts, "unknown normalized column" / "write-surface pin"). So this
  // list is not cosmetic: a name added here becomes a column a PROVIDER RECORD may write.
  //
  // connection_id is the live one. query() now SERVES it as per-row provenance (includeProvenance),
  // and the obvious way to serve it — declaring it a REGISTRY field — would also hand every connector
  // the power to say which connection its rows belong to (and, since the finance dedup engine keys on
  // (connection_id, source_object_id), to write ACROSS connections). Serving a column and accepting it
  // are different powers; this test is the seam between them.
  const CORE_APPLIED = ["connection_id", "user_id", "ingested_at", "deleted_at", "raw"];

  for (const [key, schema] of Object.entries(REGISTRY)) {
    it(`${key}: declares none of the core-applied columns`, () => {
      const fields = Object.keys(schema.fields);
      for (const col of CORE_APPLIED) {
        expect(fields, `REGISTRY '${key}' declares '${col}' — that is also the write allow-list`).not.toContain(col);
      }
      // The jsonb list is a PROJECTION list, not part of the allow-list, so `raw` belongs there.
      expect(schema.jsonb ?? []).toContain("raw");
    });
  }
});

describe("UNION_SOID_PREFIX — the merged marker a provider cannot forge", () => {
  it("is the exact-case reserved prefix the write path refuses", () => {
    expect(UNION_SOID_PREFIX).toBe("union:");
    expect("union:acct:chase:1234".startsWith(UNION_SOID_PREFIX)).toBe(true);
    // Near-misses must NOT read as merged: the write path admits these, so treating one as a synthetic
    // would let a provider row erase its own provenance by naming itself cleverly.
    for (const soid of ["unionx", "xunion:", "UNION:x", "Union:x", " union:x"]) {
      expect(soid.startsWith(UNION_SOID_PREFIX), `'${soid}' must not read as merged`).toBe(false);
    }
  });

  it("dedup_status is NOT usable as the marker: it is inside the write allow-list", () => {
    // The reason the prefix exists as a shared constant. If merged-ness were read off dedup_status, a
    // connector could emit dedup_status:'winner' on its own row — an allowed write — and that row would
    // then report "merged, no single source", hiding which provider it came from.
    for (const key of ["finance.account", "finance.transaction", "finance.holding"]) {
      expect(Object.keys(REGISTRY[key].fields)).toContain("dedup_status");
    }
  });
});

describe("objectKeysFor — the teaching-error vocabulary", () => {
  it("resolves an exact key, a bare multi-object sector, and an unknown name", () => {
    expect(objectKeysFor("mail")).toEqual(["mail"]);
    expect(objectKeysFor("finance")).toEqual([
      "finance.account",
      "finance.transaction",
      "finance.holding",
    ]);
    expect(objectKeysFor("health")).toEqual([
      "health.sample",
      "health.workout",
      "health.sleep_session",
    ]);
    expect(objectKeysFor("banana")).toEqual([]);
    expect(objectKeysFor("finance.transaction")).toEqual(["finance.transaction"]);
  });

  it("a prototype key is not a known sector", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(objectKeysFor(key)).toEqual([]);
    }
  });
});
