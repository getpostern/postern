// resolveBearer expiry (mcp-auth-bridge child B) — DB-free over the MOCKED pool (the auth.test.ts
// pattern). Pins: the select now carries expires_at; a past-deadline row denies with 'expired'
// (dead AT the expiry instant, checked between the revoked check and sector expansion — revoked
// wins); a live row populates ctx.expiresAt (the per-call deadline seam bearer.ts consumes); a
// never-expiring row resolves with expiresAt null. The DB round-trip lives in
// src/rest/admin.expiry.db.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { querySpy } = vi.hoisted(() => ({ querySpy: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query: querySpy } }));

import { resolveBearer, AccessDenied } from "./index.js";

function grantRow(over: Record<string, unknown> = {}) {
  return {
    user_id: "u-1",
    agent_id: "claude",
    sectors: ["finance"],
    revoked_at: null,
    expires_at: null,
    ...over,
  };
}

beforeEach(() => {
  querySpy.mockReset();
  querySpy.mockResolvedValue({ rowCount: 0, rows: [] });
});

describe("resolveBearer expiry", () => {
  it("selects expires_at from agent_grants (the expiry is part of the one resolve query)", async () => {
    querySpy.mockResolvedValueOnce({ rows: [grantRow()] });
    await resolveBearer("k");
    const [sql] = querySpy.mock.calls[0];
    expect(sql).toContain("expires_at");
  });

  it("a key past its expires_at throws AccessDenied whose message contains 'expired'", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [grantRow({ expires_at: new Date(Date.now() - 1000) })],
    });
    const err = await resolveBearer("k").then(
      () => {
        throw new Error("expected AccessDenied");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccessDenied);
    expect((err as Error).message).toContain("expired");
  });

  it("dead AT the instant: an expires_at even 1ms in the past denies (<=, not <)", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [grantRow({ expires_at: new Date(Date.now() - 1) })],
    });
    await expect(resolveBearer("k")).rejects.toBeInstanceOf(AccessDenied);
  });

  it("revoked WINS over expired (the revoked check runs first — deny vocabulary stays honest)", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [grantRow({ revoked_at: new Date(), expires_at: new Date(Date.now() - 1000) })],
    });
    const err = await resolveBearer("k").then(
      () => {
        throw new Error("expected AccessDenied");
      },
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("revoked");
    expect((err as Error).message).not.toContain("expired");
  });

  it("a future expires_at resolves and populates ctx.expiresAt (the mid-session deadline seam)", async () => {
    const deadline = new Date(Date.now() + 90 * 86_400_000);
    querySpy.mockResolvedValueOnce({ rows: [grantRow({ expires_at: deadline })] });
    const ctx = await resolveBearer("k");
    expect(ctx.expiresAt).toBeInstanceOf(Date);
    expect(ctx.expiresAt?.getTime()).toBe(deadline.getTime());
    expect([...ctx.grantedSectors]).toEqual(["finance"]);
  });

  it("a never-expiring row (expires_at null) resolves with ctx.expiresAt null", async () => {
    querySpy.mockResolvedValueOnce({ rows: [grantRow()] });
    const ctx = await resolveBearer("k");
    expect(ctx.expiresAt).toBeNull();
  });
});
