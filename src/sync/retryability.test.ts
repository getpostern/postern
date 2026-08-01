// Sync error classification (#99, ADR 0034) — DB-free. Every assertion compares the classifier's
// VALUE for a VERBATIM message the fleet actually throws (each string below was copied from its
// connector throw site on 2026-07-25), because the failure mode this file exists to prevent is a
// regex that looks right and cannot match the real shape.
//
// The two inversions that matter, and which the tests below are shaped to catch:
//   * a 4xx credential death read as transient  → a real "reconnect me" hides behind "Syncing…";
//   * an unknown error read as transient        → a connector bug becomes a permanent silent stall.

import { describe, it, expect, vi } from "vitest";
import { RetryableError } from "./errors.js";
import { classifySyncError, isTransientHttpStatus, PROVIDER_RETRYABILITY } from "./retryability.js";
// The REAL class, not a look-alike literal: the whole point of the SecretAuthError test below is that
// the real declaration carries no `override name`. A hand-built `{ name: "SecretAuthError" }` fixture
// is exactly the "fixture carrying a shape the code never produces" defect (defect-catalog entry 12).
import { SecretAuthError } from "../secrets/index.js";
// The REAL named-cause strings (#121), imported from their throw sites — NOT hand-copied: if the
// connector text drifts, the terminal-vocabulary assertions below must go red rather than keep
// matching a string nothing throws anymore. (The message CONTENT is pinned literally in the
// connectors' own test files; this file asserts classification of whatever they really say.)
import { API_DISABLED_MESSAGE } from "../connectors/google.js";
import { AUTH_REFUSED_MESSAGE } from "../connectors/gmail.js";

// ── the coverage test's seam ──────────────────────────────────────────────────
// Capture what registerConnectors() actually registers, by wrapping the registry the SAME module
// specifier bootstrap.ts imports. A connector added to src/bootstrap.ts without a table entry then
// fails here rather than silently inheriting "terminal".
const registered = vi.hoisted(() => {
  // secrets/index.js is pulled in transitively by bootstrap; give it a key so import-time is inert.
  process.env.PCI_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");
  return [] as string[];
});
vi.mock("./registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./registry.js")>();
  return {
    ...actual,
    registerConnector: (c: { provider: string }) => {
      registered.push(c.provider);
      actual.registerConnector(c as never);
    },
  };
});
vi.mock("../audit/index.js", () => ({ audit: vi.fn() }));

describe("isTransientHttpStatus", () => {
  it("408, 425 and 429 are transient", () => {
    expect(isTransientHttpStatus(408)).toBe(true);
    expect(isTransientHttpStatus(425)).toBe(true);
    expect(isTransientHttpStatus(429)).toBe(true);
    // …and their neighbours are not, so the set is exactly those three plus 5xx.
    expect(isTransientHttpStatus(409)).toBe(false);
    expect(isTransientHttpStatus(428)).toBe(false);
    expect(isTransientHttpStatus(430)).toBe(false);
  });

  it("every 5xx is transient; 2xx/3xx/4xx are not", () => {
    for (const s of [500, 502, 503, 504, 599]) expect(isTransientHttpStatus(s)).toBe(true);
    for (const s of [200, 302, 400, 401, 403, 404, 422, 499]) expect(isTransientHttpStatus(s)).toBe(false);
  });
});

describe("classifySyncError — universal status vocabulary", () => {
  it("a 503 from any status-bearing connector message is transient", () => {
    // Verbatim shapes: simplefin.ts:214, whoop.ts:265, google.ts:417, plaid.ts:249.
    expect(classifySyncError("simplefin", new Error("simplefin: account fetch returned 503"))).toBe("transient");
    expect(classifySyncError("whoop", new Error("whoop: /v1/cycle returned 502"))).toBe("transient");
    expect(classifySyncError("google", new Error("google: calendar fetch returned 500"))).toBe("transient");
    expect(classifySyncError("plaid", new Error("plaid transactions_sync failed: 504"))).toBe("transient");
    // microsoft's plain-Error status throws ride the same universal rule (microsoft.ts:419).
    expect(classifySyncError("microsoft", new Error("microsoft: delta fetch returned 500"))).toBe("transient");
  });

  it("a 4xx that is not 408/425/429 is terminal", () => {
    // THE INVERSION THAT MUST NOT HAPPEN: a dead Plaid item read as "retry me" would hide the
    // Console's Reconnect behind a permanent "Syncing…".
    expect(classifySyncError("plaid", new Error("plaid transactions_sync failed: 400 ITEM_LOGIN_REQUIRED"))).toBe(
      "terminal",
    );
    expect(classifySyncError("google", new Error("google: people fetch returned 403"))).toBe("terminal");
    expect(classifySyncError("simplefin", new Error("simplefin: account fetch returned 401"))).toBe("terminal");
    expect(classifySyncError("whoop", new Error("whoop: /v1/recovery returned 404"))).toBe("terminal");
  });

  it("408, 425 and 429 in a real message are transient", () => {
    expect(classifySyncError("whoop", new Error("whoop: /v1/cycle returned 408"))).toBe("transient");
    expect(classifySyncError("google", new Error("google: calendar fetch returned 425"))).toBe("transient");
    expect(classifySyncError("plaid", new Error("plaid transactions_sync failed: 429"))).toBe("transient");
  });

  it("a number that is not a plausible HTTP status is not treated as one", () => {
    // "returned 999" must fall through to the unknown-is-terminal default, not be parsed as 9xx.
    expect(classifySyncError("whoop", new Error("whoop: /v1/cycle returned 999"))).toBe("terminal");
  });
});

describe("classifySyncError — provider-declared vocabulary", () => {
  it("a provider-declared network message is transient", () => {
    // Verbatim: plaid.ts:450, whoop.ts:263, google.ts:211, google.ts:214.
    expect(classifySyncError("plaid", new Error("plaid item_get failed: network error"))).toBe("transient");
    expect(classifySyncError("plaid", new Error("plaid transactions_sync failed: network error"))).toBe("transient");
    expect(classifySyncError("whoop", new Error("whoop: fetch /v1/recovery failed"))).toBe("transient");
    expect(classifySyncError("google", new Error("google: request failed"))).toBe("transient");
    expect(classifySyncError("google", new Error("google: rate limited (429) after retries"))).toBe("transient");
  });

  it("a provider's pattern does not leak to another provider", () => {
    // The table is keyed by provider on purpose; "google: request failed" from plaid means nothing.
    expect(classifySyncError("plaid", new Error("google: request failed"))).toBe("terminal");
    expect(classifySyncError("", new Error("google: request failed"))).toBe("terminal");
  });

  it("an ambiguous connector message stays terminal", () => {
    // Each of these strings is emitted by BOTH a network path and a credential-death path, so
    // calling any of them transient would make a bad app password read as "Syncing…" forever.
    expect(classifySyncError("simplefin", new Error("simplefin: account fetch failed"))).toBe("terminal");
    expect(classifySyncError("gmail", new Error("gmail: sync failed"))).toBe("terminal");
    expect(classifySyncError("apple", new Error("apple: DAV connect failed"))).toBe("terminal");
    expect(classifySyncError("apple", new Error("apple: sync-collection failed"))).toBe("terminal");
  });

  it("the #121 named-cause messages are terminal — a disabled API / rejected app password needs a human", () => {
    // The REAL strings, imported from google.ts API_DISABLED_MESSAGE / gmail.ts
    // AUTH_REFUSED_MESSAGE (fix-round F3: hand-copied literals here would keep matching a string
    // the connectors no longer throw). Both are DECLARED in the provider `terminal` vocabulary
    // rather than inherited from the unknown default, so a future transient rule matching the
    // longer message (the plain-403 test above shares the `returned 403` carrier) can never flip a
    // credential death into a permanent quiet "Syncing…". Today they would land terminal via step
    // 10 anyway; this asserts they NEVER stop doing so.
    expect(classifySyncError("google", new Error(API_DISABLED_MESSAGE.calendar))).toBe("terminal");
    expect(classifySyncError("google", new Error(API_DISABLED_MESSAGE.people))).toBe("terminal");
    expect(classifySyncError("gmail", new Error(AUTH_REFUSED_MESSAGE))).toBe("terminal");

    // The classifier's unknown-default is ALSO terminal, so the value assertions above cannot
    // distinguish "declared" from "fell through". This can: the DECLARED terminal vocabulary must
    // itself match the REAL messages — deleting the declaration, or drifting the connector text
    // out from under the regex, goes red here even though the verdicts above would not move.
    const google = PROVIDER_RETRYABILITY.find((p) => p.provider === "google")!;
    const gmail = PROVIDER_RETRYABILITY.find((p) => p.provider === "gmail")!;
    expect(google.terminal?.some((re) => re.test(API_DISABLED_MESSAGE.calendar))).toBe(true);
    expect(google.terminal?.some((re) => re.test(API_DISABLED_MESSAGE.people))).toBe(true);
    expect(gmail.terminal?.some((re) => re.test(AUTH_REFUSED_MESSAGE))).toBe(true);
  });
});

describe("classifySyncError — precedence", () => {
  it("a RetryableError is transient whatever its message says", () => {
    // Rule 1 must sit ABOVE the universal-terminal vocabulary: the connector's own declaration wins.
    expect(classifySyncError("microsoft", new RetryableError("microsoft: delta fetch returned 403"))).toBe(
      "transient",
    );
    expect(classifySyncError("microsoft", new RetryableError("microsoft: unauthorized"))).toBe("transient");
    // …and the SAME message as a plain Error is terminal — which is what makes the rule load-bearing.
    expect(classifySyncError("microsoft", new Error("microsoft: delta fetch returned 403"))).toBe("terminal");
  });

  it("a dead credential is terminal even when it arrives dressed as a 5xx", () => {
    // TokenEndpointError's `code` must be consulted BEFORE its `status` (src/oauth/exchange.ts:40-55).
    const err = {
      name: "TokenEndpointError",
      status: 503,
      code: "invalid_grant",
      message: "token endpoint returned 503: invalid_grant",
    };
    expect(classifySyncError("google", err)).toBe("terminal");
    for (const code of ["invalid_client", "unauthorized_client", "invalid_scope", "access_denied", "no_access_token"]) {
      expect(classifySyncError("google", { ...err, code })).toBe("terminal");
    }
  });

  it("a TokenEndpointError with a NON-fatal code follows its status", () => {
    const base = { name: "TokenEndpointError", code: "temporarily_unavailable" };
    expect(classifySyncError("google", { ...base, status: 503, message: "token endpoint returned 503" })).toBe(
      "transient",
    );
    expect(classifySyncError("google", { ...base, status: 400, message: "token endpoint returned 400" })).toBe(
      "terminal",
    );
  });

  it("a REAL SecretAuthError is terminal even when its message carries a 5xx", () => {
    // THE shape that matters. A `SecretAuthError` whose message happens to carry a 5xx must never read
    // TRANSIENT — that would land the connection in the quiet status='syncing' and the Console would
    // never offer Reconnect, which is the exact inversion #99 exists to prevent.
    //
    // MOTHER, AT MERGE 2026-07-25: this assertion used to read `expect(real.name).toBe("Error")`,
    // pinning the pre-fix state as the justification for the duck-type. It was true when this unit was
    // written and FALSE once `vault-key-packaging` landed `override name = "SecretAuthError"`
    // (src/secrets/index.ts:42-44) in the same wave — two units green apart, red together. A test may
    // pin why a guard exists; it must not pin the bug that motivated it, or the guard's own fix breaks it.
    const real = new SecretAuthError("simplefin: account fetch returned 503");
    expect(classifySyncError("simplefin", real)).toBe("terminal");

    // …and the plain, status-free vault failure, also on the real class.
    expect(classifySyncError("simplefin", new SecretAuthError("secret failed authentication (tag/AAD verification)"))).toBe(
      "terminal",
    );

    // Both shapes, forever — this is the point of reading BOTH the `name` property and the constructor
    // name. (a) the flattened literal, which is what an error looks like after it crosses a boundary
    // that drops its prototype; and (b) an instance whose `name` property has been stripped, which is
    // what the real class looked like before `override name` landed and what it would look like again
    // if that line were ever removed. Neither may fall through to the status rules.
    expect(
      classifySyncError("simplefin", { name: "SecretAuthError", message: "simplefin: account fetch returned 503" }),
    ).toBe("terminal");
    const stripped = new SecretAuthError("simplefin: account fetch returned 503");
    Object.defineProperty(stripped, "name", { value: "Error" });
    expect(stripped.name).toBe("Error");
    expect(classifySyncError("simplefin", stripped)).toBe("terminal");
  });

  it("a ConfigError is terminal even when its message carries a 5xx", () => {
    expect(classifySyncError("google", { name: "ConfigError", message: "provider google is not configured" })).toBe(
      "terminal",
    );
    expect(classifySyncError("google", { name: "ConfigError", message: "google: request returned 500" })).toBe(
      "terminal",
    );
  });
});

describe("classifySyncError — transport codes", () => {
  it("a Node network code on err.cause is transient", () => {
    // undici puts the real code on `cause`; reading only err.code would miss every fetch failure.
    expect(classifySyncError("google", Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(
      "transient",
    );
    expect(
      classifySyncError("plaid", Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } })),
    ).toBe("transient");
  });

  it("a Node network code on err.code is transient", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(classifySyncError("whoop", Object.assign(new Error("socket problem"), { code }))).toBe("transient");
    }
    // A code that is NOT in the transport set does not smuggle anything through.
    expect(classifySyncError("whoop", Object.assign(new Error("socket problem"), { code: "EACCES" }))).toBe("terminal");
  });

  it("AbortError / TimeoutError are transient", () => {
    expect(classifySyncError("gmail", { name: "AbortError", message: "The operation was aborted" })).toBe("transient");
    expect(classifySyncError("gmail", { name: "TimeoutError", message: "timed out" })).toBe("transient");
  });
});

describe("classifySyncError — the default", () => {
  it("an unknown error is terminal, not transient", () => {
    // A genuine connector/runner bug must stay LOUD. Flipping this default would turn every one of
    // them into a permanent silent "Syncing…".
    expect(
      classifySyncError(
        "simplefin",
        new Error("normalized record has unknown column 'foo' for table finance_transactions"),
      ),
    ).toBe("terminal");
    expect(classifySyncError("plaid", new Error("boom in sync"))).toBe("terminal");
  });

  it("the universal terminal vocabulary OUTRANKS a transient carrier in the same message", () => {
    // This is what PINS rule 6. The previous version of this test used status-free messages, every one
    // of which reaches "terminal" through the step-10 default — deleting UNIVERSAL_TERMINAL outright
    // left it green, i.e. it was a test that could not fail (defect-catalog entry 12).
    //
    // Each case below pairs a credential-death token with a carrier that would classify TRANSIENT on
    // its own — a 5xx/429 status shape (step 9) or a transport code on `cause` (step 7). Remove the
    // universal-terminal rule and every one of these flips to "transient", which is precisely the
    // inversion that hides a real "reconnect me" behind a permanent quiet "Syncing…".
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      // plaid throws `plaid ${op} failed: ${status}${code}` (plaid.ts:249) — the code rides WITH the status.
      ["plaid", new Error("plaid transactions_sync failed: 500 ITEM_LOGIN_REQUIRED"), "ITEM_LOGIN_REQUIRED + 500"],
      ["plaid", new Error("plaid item_get failed: 503 INVALID_ACCESS_TOKEN"), "INVALID_ACCESS_TOKEN + 503"],
      ["google", new Error("google: calendar fetch returned 503 - unauthorized"), "unauthorized + 503"],
      ["whoop", new Error("whoop: /v1/cycle returned 429: forbidden"), "forbidden + 429"],
      ["microsoft", new Error("microsoft: token refresh returned 502: invalid_grant"), "invalid_grant + 502"],
      [
        "home_assistant",
        Object.assign(new Error("home assistant: grant revoked by the user"), { cause: { code: "ECONNRESET" } }),
        "revoked + ECONNRESET",
      ],
      [
        "simplefin",
        Object.assign(new Error("simplefin: credential not found"), { code: "ETIMEDOUT" }),
        "credential not found + ETIMEDOUT",
      ],
    ];
    for (const [provider, err, why] of cases) {
      expect(classifySyncError(provider, err), why).toBe("terminal");
    }

    // Control: strip the terminal token and the SAME carriers read transient. Without this pair the
    // assertions above could pass simply because nothing ever classifies transient.
    expect(classifySyncError("plaid", new Error("plaid transactions_sync failed: 500"))).toBe("transient");
    expect(classifySyncError("google", new Error("google: calendar fetch returned 503"))).toBe("transient");
    expect(
      classifySyncError("home_assistant", Object.assign(new Error("home assistant: stream dropped"), { cause: { code: "ECONNRESET" } })),
    ).toBe("transient");
  });

  it("never throws, whatever it is handed", () => {
    for (const weird of [undefined, null, "boom", 42, {}, [], Symbol("s"), new Error()]) {
      expect(["transient", "terminal"]).toContain(classifySyncError("", weird));
    }
  });
});

describe("PROVIDER_RETRYABILITY — the declaration contract", () => {
  it("every registered provider declares its retryability", async () => {
    const { registerConnectors } = await import("../bootstrap.js");
    registered.length = 0;
    registerConnectors();

    const registeredSet = [...new Set(registered)].sort();
    const declaredSet = PROVIDER_RETRYABILITY.map((p) => p.provider).sort();

    // Set EQUALITY in both directions: no provider without an entry, no entry without a provider.
    expect(declaredSet).toEqual(registeredSet);
    // A control on the seam itself — if the registry mock ever stopped capturing, the equality above
    // would compare two empty arrays and pass forever.
    expect(registeredSet).toContain("simplefin");
    expect(registeredSet.length).toBeGreaterThanOrEqual(9);
  });

  it("no entry may be silent: every note is a non-empty declaration", () => {
    for (const entry of PROVIDER_RETRYABILITY) {
      expect(typeof entry.note).toBe("string");
      expect(entry.note.trim().length).toBeGreaterThan(0);
    }
  });

  it("the table has exactly one entry per provider", () => {
    const providers = PROVIDER_RETRYABILITY.map((p) => p.provider);
    expect(providers.length).toBe(new Set(providers).size);
  });
});
