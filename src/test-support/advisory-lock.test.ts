// lockTestResource — db-gated serialization proof (two concurrent holders of the same key run
// strictly one-at-a-time) + the DB-free fast path (immediate async no-op releaser).

import { describe, it, expect, afterAll } from "vitest";
import { lockTestResource } from "./advisory-lock.js";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("lockTestResource (DB)", () => {
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.end();
  });

  it("two concurrent locks on the same key serialize; release is idempotent under double-call", async () => {
    const release1 = await lockTestResource("advisory-lock-test-x");
    let secondAcquired = false;
    const second = lockTestResource("advisory-lock-test-x").then((rel) => {
      secondAcquired = true;
      return rel;
    });
    try {
      // Give the second acquisition a real window to (incorrectly) sneak through.
      await new Promise((r) => setTimeout(r, 300));
      expect(secondAcquired).toBe(false);
    } finally {
      await release1(); // also unblocks `second` on the failure path so afterAll's pool.end() can't hang
    }
    const release2 = await second;
    expect(secondAcquired).toBe(true);
    await release2();
    await release2(); // double-call: no throw, no double client.release()
    await release1(); // and the first releaser is idempotent too
  }, 30_000);

  it("distinct keys do NOT contend", async () => {
    const releaseA = await lockTestResource("advisory-lock-test-a");
    const releaseB = await lockTestResource("advisory-lock-test-b"); // resolves without releaseA
    await releaseB();
    await releaseA();
  });
});

describe("lockTestResource (no DB)", () => {
  it("returns an async no-op releaser immediately when DATABASE_URL is unset", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const release = await lockTestResource("anything");
      await release();
      await release();
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
