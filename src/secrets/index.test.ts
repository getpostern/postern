import { describe, it, expect, afterAll } from "vitest";
import type { SecretContext } from "./index.js";

// DB round-trip is gated: skipped when DATABASE_URL is unset so CI stays green without Postgres.
const HAS_DB = !!process.env.DATABASE_URL;

// Seeded self-host user (db/schema.sql) satisfies the secrets.user_id FK.
const SEED_USER = "00000000-0000-0000-0000-000000000001";

describe.skipIf(!HAS_DB)("secret store DB round-trip", () => {
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.end();
  });

  const ctx: SecretContext = { userId: SEED_USER, provider: "simplefin", purpose: "access_url" };

  it("seal returns an opaque sec_ ref and open recovers the exact token", async () => {
    const { seal, open } = await import("./index.js");
    const token = "https://demo:demo@bridge.simplefin.org/simplefin/accounts";
    const ref = await seal(ctx, token);
    expect(ref).toMatch(/^sec_[0-9a-f-]{36}$/);
    const opened = await open(ref, ctx);
    expect(opened.toString("utf8")).toBe(token);
  });

  it("open with a mismatched context throws SecretAuthError", async () => {
    const { seal, open, SecretAuthError } = await import("./index.js");
    const ref = await seal(ctx, "tok");
    const wrong: SecretContext = { ...ctx, purpose: "refresh_token" };
    await expect(open(ref, wrong)).rejects.toBeInstanceOf(SecretAuthError);
  });

  it("open of a missing ref throws SecretNotFound", async () => {
    const { open, SecretNotFound } = await import("./index.js");
    await expect(open("sec_missing", ctx)).rejects.toBeInstanceOf(SecretNotFound);
  });
});

// A non-DB assertion that always runs: the error types are real Error subclasses.
describe("secret store error types", () => {
  it("exports SecretNotFound / SecretAuthError / MasterKeyError as Error subclasses", async () => {
    const { SecretNotFound, SecretAuthError, MasterKeyError } = await import("./index.js");
    expect(new SecretNotFound() instanceof Error).toBe(true);
    expect(new SecretAuthError() instanceof Error).toBe(true);
    expect(new MasterKeyError() instanceof Error).toBe(true);
  });

  it("a real SecretAuthError carries name 'SecretAuthError', not the inherited 'Error'", async () => {
    // Not cosmetic. `class X extends Error {}` inherits name === "Error", so any rule that classifies
    // a failure by err.name — the sync runner's terminal-vs-retryable split — silently never matches
    // and a permanently-broken credential gets retried forever. Asserted on a REAL instance (and on a
    // caught one, which is how production ever sees it), never on the class.
    const { SecretAuthError } = await import("./index.js");
    expect(new SecretAuthError("boom").name).toBe("SecretAuthError");
    try {
      throw new SecretAuthError("boom");
    } catch (e) {
      expect((e as Error).name).toBe("SecretAuthError");
    }
  });
});
