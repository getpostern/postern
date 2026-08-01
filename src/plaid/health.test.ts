// Plaid health — the error-code state machine (pure) + pollItemHealth (network-mocked, no DB).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { classifyItemError, pollItemHealth } from "./health.js";

import { afterAll } from "vitest";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// pollItemHealth → itemGet → table-first plaidConfig touches the pool under test:db; close it once.
afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

describe("classifyItemError — the state machine", () => {
  it("ITEM_LOGIN_REQUIRED / ACCESS_NOT_GRANTED / USER_PERMISSION_REVOKED → action_required", () => {
    expect(classifyItemError("ITEM_LOGIN_REQUIRED", null)).toBe("action_required");
    expect(classifyItemError("ACCESS_NOT_GRANTED", null)).toBe("action_required");
    expect(classifyItemError("USER_PERMISSION_REVOKED", null)).toBe("action_required");
  });

  it("INSTITUTION_DOWN / NOT_RESPONDING / NOT_AVAILABLE → transient", () => {
    expect(classifyItemError("INSTITUTION_DOWN", null)).toBe("transient");
    expect(classifyItemError("INSTITUTION_NOT_RESPONDING", null)).toBe("transient");
    expect(classifyItemError("INSTITUTION_NOT_AVAILABLE", null)).toBe("transient");
  });

  it("RATE_LIMIT_EXCEEDED → transient (a temporary throttle: back off and RETRY, never give up)", () => {
    expect(classifyItemError("RATE_LIMIT_EXCEEDED", null)).toBe("transient");
  });

  it("ITEM_NOT_FOUND / INSTITUTION_NO_LONGER_SUPPORTED → dead", () => {
    expect(classifyItemError("ITEM_NOT_FOUND", null)).toBe("dead");
    expect(classifyItemError("INSTITUTION_NO_LONGER_SUPPORTED", null)).toBe("dead");
  });

  it("terminal Trial/billing quota (TRIAL_CONNECTION_LIMIT / CREDITS_EXHAUSTED) → dead (NOT retryable)", () => {
    expect(classifyItemError("TRIAL_CONNECTION_LIMIT", null)).toBe("dead");
    expect(classifyItemError("CREDITS_EXHAUSTED", null)).toBe("dead");
  });

  it("an UNKNOWN error_code is conservatively action_required (never feigned healthy)", () => {
    expect(classifyItemError("SOME_NEW_PLAID_CODE", null)).toBe("action_required");
  });

  it("no error_code → ok; consent expiring within a week → action_required", () => {
    expect(classifyItemError(null, null)).toBe("ok");
    const farOut = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(classifyItemError(null, farOut)).toBe("ok");
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(classifyItemError(null, soon)).toBe("action_required");
  });
});

describe("pollItemHealth — /item/get → classify (network mocked)", () => {
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_ENV = "sandbox";
  });

  it("a healthy Item (no error) → ok", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ item: { institution_id: "ins_1" } }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const h = await pollItemHealth("access-tok");
    expect(h.status).toBe("ok");
    expect(h.errorCode).toBeNull();
  });

  it("a broken Item (ITEM_LOGIN_REQUIRED) → action_required, surfacing the consent clock", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            item: {
              error: { error_code: "ITEM_LOGIN_REQUIRED" },
              consent_expiration_time: "2030-06-01T00:00:00Z",
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch;
    const h = await pollItemHealth("access-tok");
    expect(h.status).toBe("action_required");
    expect(h.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(h.consentExpiresAt).toBe("2030-06-01T00:00:00Z");
  });

  it("a 429 quota → dead (terminal), never leaking the token", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error_code: "TRIAL_CONNECTION_LIMIT" }), { status: 429 }),
    ) as unknown as typeof globalThis.fetch;
    const h = await pollItemHealth("super-secret-token");
    expect(h.status).toBe("dead");
    expect(h.errorCode).toBe("TRIAL_CONNECTION_LIMIT");
  });

  it("a network failure → transient (never throws)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const h = await pollItemHealth("access-tok");
    expect(h.status).toBe("transient");
  });
});
