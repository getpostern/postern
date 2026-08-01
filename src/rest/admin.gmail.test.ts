// Gmail paste-path fixes in postCredential — DB-free (vault + DB pool mocked) so the two
// onboarding bug fixes are asserted in CI without Postgres:
//   (1) the 16-char app password, pasted verbatim in four space-separated groups, is sealed with
//       ALL whitespace stripped (a spaced paste breaks IMAP auth);
//   (2) a Gmail credential without a username (the full Gmail address, the IMAP login) is rejected
//       BEFORE any vault/DB write.
// Both are scoped to provider === 'gmail' — every other provider's behavior must be byte-identical,
// which the "homeassistant" control assertions below prove.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture exactly what gets sealed, without touching the real AEAD vault.
const sealMock = vi.fn(async (_ctx: unknown, _plaintext: unknown) => "sec_test_ref");
vi.mock("../secrets/index.js", () => ({ seal: sealMock }));

// Stub the DB pool: a successful insert returns the one credential row postCredential echoes.
const queryMock = vi.fn(async () => ({
  rows: [{ id: "cred-1", provider: "gmail", status: "active" }],
}));
vi.mock("../db.js", () => ({ pool: { query: queryMock } }));

// SimpleFIN's claim helper is imported by admin.ts; stub it so the module loads (gmail never calls it).
vi.mock("../connectors/simplefin.js", () => ({ claimSetupToken: vi.fn() }));

import type { ServerResponse } from "node:http";
import type { RouteContext } from "./router.js";

/** A minimal capturing fake ServerResponse. */
function fakeRes() {
  let status = 0;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(s: number) {
      status = s;
      this.headersSent = true;
      return this;
    },
    setHeader() {},
    end(payload?: string) {
      if (payload) body += payload;
      this.headersSent = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}

function ctxFor() {
  const r = fakeRes();
  const ctx: RouteContext = {
    req: { headers: { host: "127.0.0.1:8787" } } as unknown as RouteContext["req"],
    res: r.res,
    params: {},
    query: new URLSearchParams(),
  };
  return { ctx, r };
}

/** The 2nd arg of seal() is the plaintext that gets sealed. */
function lastSealedPlaintext(): unknown {
  return sealMock.mock.calls.at(-1)?.[1];
}

beforeEach(() => {
  sealMock.mockClear();
  queryMock.mockClear();
});

describe("postCredential — Gmail paste-path fixes", () => {
  it("strips ALL whitespace from the app password before sealing", async () => {
    const { postCredential } = await import("./admin.js");
    const { ctx, r } = ctxFor();

    // Verbatim Google display: four space-separated 4-char groups (plus stray edge whitespace).
    await postCredential(ctx, {
      provider: "gmail",
      secret: " abcd efgh ijkl mnop ",
      username: "operator@example.com",
    });

    expect(r.status).toBe(201);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(lastSealedPlaintext()).toBe("abcdefghijklmnop");
    // The verbatim spaced form is NEVER what gets sealed.
    expect(lastSealedPlaintext()).not.toContain(" ");
  });

  it("strips interior tabs/newlines too (any whitespace, not just spaces)", async () => {
    const { postCredential } = await import("./admin.js");
    const { ctx } = ctxFor();

    await postCredential(ctx, {
      provider: "gmail",
      secret: "abcd\tefgh\nijkl mnop",
      username: "operator@example.com",
    });

    expect(lastSealedPlaintext()).toBe("abcdefghijklmnop");
  });

  it("rejects a Gmail credential with NO username before any seal/DB write", async () => {
    const { postCredential } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    const { ctx } = ctxFor();

    await expect(
      postCredential(ctx, { provider: "gmail", secret: "abcd efgh ijkl mnop" }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Fail-closed: nothing is sealed and nothing is written.
    expect(sealMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects a Gmail credential whose username is whitespace-only", async () => {
    const { postCredential } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    const { ctx } = ctxFor();

    await expect(
      postCredential(ctx, { provider: "gmail", secret: "abcd efgh ijkl mnop", username: "   " }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(sealMock).not.toHaveBeenCalled();
  });

  it("leaves other providers byte-identical: Home Assistant token sealed VERBATIM, username optional", async () => {
    const { postCredential } = await import("./admin.js");
    const { ctx, r } = ctxFor();

    // A token that happens to contain whitespace is sealed UNCHANGED for non-gmail providers, and a
    // missing username is accepted (no gmail-only rejection leaks across providers).
    const HA_TOKEN = "ha tok en\twith spaces";
    await postCredential(ctx, { provider: "homeassistant", secret: HA_TOKEN });

    expect(r.status).toBe(201);
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(lastSealedPlaintext()).toBe(HA_TOKEN);
  });
});
