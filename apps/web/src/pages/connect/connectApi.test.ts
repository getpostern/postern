// validateShape — the "ours" failure kind (build-notes §14.1d): WE reject a mis-shaped input BEFORE a
// round-trip, and the message says what right looks like. Every case below must never reach the wire.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { providerBySlug } from "./catalog";
import { runPaste, validateShape } from "./connectApi";

const def = (slug: string) => providerBySlug(slug)!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateShape (the ours-failure kind)", () => {
  it("SimpleFIN — a bare bridge address (no @ credentials) is caught with the design's VERBATIM copy (FHH-0)", () => {
    const err = validateShape(def("simplefin"), { secret: "https://bridge.simplefin.org" });
    expect(err?.field).toBe("secret");
    // The drawn treatment-sheet copy, word for word — never paraphrased or extended (law 10).
    expect(err?.message).toBe(
      "That’s the bridge address, not your access URL. Yours starts with https:// and carries a token after the //.",
    );
    // Guard against the pre-fix rewrite ("before the @" + an appended "request an access URL" clause).
    expect(err?.message).not.toMatch(/before the @/);
    expect(err?.message).not.toMatch(/request an access URL in the Bridge/);
  });

  it("SimpleFIN — a real access URL (user@host) and a bare setup token both pass", () => {
    expect(validateShape(def("simplefin"), { secret: "https://abc:def@bridge.simplefin.org/simplefin" })).toBeNull();
    expect(validateShape(def("simplefin"), { secret: "aHR0cHM6Ly9zZXR1cC10b2tlbg==" })).toBeNull();
  });

  it("iCloud — a non-email Apple ID is rejected; a valid pair passes", () => {
    expect(validateShape(def("icloud"), { username: "not-an-email", secret: "abcd-efgh-ijkl-mnop" })?.field).toBe(
      "username",
    );
    expect(validateShape(def("icloud"), { username: "me@icloud.com", secret: "abcd-efgh-ijkl-mnop" })).toBeNull();
  });

  /**
   * #95 item 5 — the two iCloud sentences agree, and both say what Postern can SEE.
   *
   * This message read "your normal Apple password won't work" two fields away from a footnote that had
   * already been corrected to "Postern never sees your Apple ID password". The credential IS an Apple
   * ID password — an app-specific one — so "normal" drew a distinction that does not exist, and it told
   * the person what would FAIL where the footnote told them what we cannot read.
   *
   * Pinned as the SENTENCE, not as non-emptiness, and pinned against `catalog.ts`'s footnote rather
   * than against a second literal: two copies of one framing are how the drift happened.
   *
   * MUTATION: put "your normal Apple password won't work" back → RED on both the exact-text assertion
   * and the shared-framing one.
   */
  it("the iCloud secret message says what Postern can see, in the same words as the screen's footnote", () => {
    const err = validateShape(def("icloud"), { username: "me@icloud.com", secret: "" });
    expect(err?.field).toBe("secret");
    expect(err?.message).toBe(
      "Paste the app-specific password you generated — four groups of four. Postern never sees your Apple ID password, only this one.",
    );
    // Never again the framing that names what fails.
    expect(err?.message).not.toMatch(/normal Apple password|won.t work/);
    // The footnote two fields away uses the same two nouns for the same two things.
    const footnote = def("icloud").footnote;
    expect(footnote).toMatch(/never sees your Apple ID password/);
    expect(err?.message).toMatch(/never sees your Apple ID password/);
    expect(footnote).toMatch(/app-password/);
    expect(err?.message).toMatch(/app-specific password/);
  });

  it("Gmail — an app password that isn't 16 chars is rejected (spaces ignored)", () => {
    expect(validateShape(def("gmail"), { username: "me@gmail.com", secret: "short" })?.field).toBe("secret");
    expect(validateShape(def("gmail"), { username: "me@gmail.com", secret: "abcd efgh ijkl mnop" })).toBeNull();
  });

  it("Home Assistant — a non-URL instance address is rejected", () => {
    expect(validateShape(def("home-assistant"), { instanceUrl: "homeassistant.local", secret: "t" })?.field).toBe(
      "instanceUrl",
    );
    expect(validateShape(def("home-assistant"), { instanceUrl: "http://192.168.1.50:8123", secret: "t" })).toBeNull();
    // DECIDED (#96 §3): we TEACH the LAN IP, we do NOT reject `.local`. A gateway run outside Docker
    // (`npm start` on the host) CAN resolve mDNS, so a hard reject would be wrong for that user —
    // and the shape validator's contract is "WE reject before spending a round-trip", not "this
    // probably won't resolve in your deployment".
    expect(validateShape(def("home-assistant"), { instanceUrl: "http://homeassistant.local:8123", secret: "t" })).toBeNull();
  });

  it("the instance-URL shape message's worked example is a LAN IP", () => {
    const err = validateShape(def("home-assistant"), { instanceUrl: "homeassistant.local", secret: "t" });
    expect(err?.message).toBe(
      "That isn’t a URL — your Home Assistant address starts with http:// or https://, e.g. http://192.168.1.50:8123.",
    );
    expect(err?.message).not.toMatch(/\.local/);
  });

  it("Google/Whoop — a confidential client with no secret is rejected; Microsoft (public) never needs one", () => {
    expect(validateShape(def("google"), { clientId: "x.apps.googleusercontent.com" })?.field).toBe("clientSecret");
    expect(validateShape(def("whoop"), { clientId: "x" })?.field).toBe("clientSecret");
    // Microsoft is public — a client id alone is a valid shape.
    expect(validateShape(def("microsoft"), { clientId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });

  it("empty required fields are caught before any network call", () => {
    expect(validateShape(def("microsoft"), {})?.field).toBe("clientId");
    expect(validateShape(def("simplefin"), {})?.field).toBe("secret");
  });
});

// The first sync was wrapped in a bare `try {} catch {}`, so the screen toasted "<Provider>
// connected." and navigated to /sources even when the source never answered. Worse: `syncNow` fails
// WITHOUT throwing — it resolves `{ ok: false, error }` — so the bare catch could not even see the
// common shape. (#96 §4.)
describe("runPaste — the first sync is REPORTED, never swallowed", () => {
  function mockCreate() {
    vi.spyOn(api, "addCredential").mockResolvedValue({
      credentialId: "cred1",
      provider: "home_assistant",
      status: "active",
    });
    vi.spyOn(api, "createConnector").mockResolvedValue({
      connectionId: "conn1",
      sector: "home",
      provider: "home_assistant",
      status: "active",
    });
  }
  const values = { instanceUrl: "http://192.168.1.50:8123", secret: "tok" };

  it("a first sync that throws is reported, not swallowed", async () => {
    mockCreate();
    vi.spyOn(api, "syncNow").mockRejectedValue(new Error("connect ECONNREFUSED 192.168.1.50:8123"));
    const res = await runPaste(def("home-assistant"), values);
    expect(res.firstSync).toEqual({
      kind: "failed",
      message: "connect ECONNREFUSED 192.168.1.50:8123",
    });
  });

  it("a first sync that resolves with ok:false is reported, not read as success", async () => {
    mockCreate();
    vi.spyOn(api, "syncNow").mockResolvedValue({
      connectionId: "conn1",
      provider: "home_assistant",
      mode: "poll",
      ran: true,
      ok: false,
      error: "401 unauthorized from Home Assistant",
    });
    const res = await runPaste(def("home-assistant"), values);
    expect(res.firstSync).toEqual({
      kind: "failed",
      message: "401 unauthorized from Home Assistant",
    });
  });

  it("a first sync that succeeds reports ok, and the connection is returned either way", async () => {
    mockCreate();
    const sync = vi.spyOn(api, "syncNow").mockResolvedValue({
      connectionId: "conn1",
      provider: "home_assistant",
      mode: "poll",
      ran: true,
      ok: true,
      upserted: 1847,
    });
    const ok = await runPaste(def("home-assistant"), values);
    expect(ok.firstSync).toEqual({ kind: "ok" });
    expect(ok.connectionIds).toEqual(["conn1"]);

    sync.mockResolvedValue({
      connectionId: "conn1",
      provider: "home_assistant",
      mode: "poll",
      ran: false,
      ok: false,
      error: "nope",
    });
    const failed = await runPaste(def("home-assistant"), values);
    // The connection EXISTS — the screen needs its id to offer "Manage this connection →".
    expect(failed.connectionIds).toEqual(["conn1"]);
  });

  it("the Apple fan-out reports not_attempted rather than a fake success", async () => {
    // The fan-out is server-side and no sync is issued, so `ok` would be a claim about a read that
    // never ran.
    vi.spyOn(api, "appleOnboard").mockResolvedValue({
      credentialId: "cred-apple",
      provider: "apple",
      connectors: [
        { connectionId: "a-mail", sector: "mail", status: "active" },
        { connectionId: "a-cal", sector: "calendar", status: "active" },
      ],
    });
    const res = await runPaste(def("icloud"), { username: "me@icloud.com", secret: "x" });
    expect(res.firstSync).toEqual({ kind: "not_attempted" });
    expect(res.connectionIds).toEqual(["a-mail", "a-cal"]);
  });

  it("a failed first sync never deletes the connection it just created", async () => {
    // A rollback here would fabricate a state the gateway is not in: the credential exists upstream
    // and the connector row exists in the store.
    mockCreate();
    vi.spyOn(api, "syncNow").mockRejectedValue(new Error("timeout"));
    const disconnect = vi.spyOn(api, "disconnectConnection");
    await runPaste(def("home-assistant"), values);
    expect(disconnect).not.toHaveBeenCalled();
  });
});

// `redirectUriFor` is DELETED (ADR 0035 §D4) and nothing replaces it client-side: the gateway
// reports the redirect_uri it will send, and the Console renders that. Its old test asserted only
// that a template literal ended in `/callback` — which the format string guaranteed — so it could
// never have caught the bug that motivated this unit. What replaces it is the guard below, which
// keeps the second source from growing back.
describe("one source for the OAuth redirect URI", () => {
  it("nothing in the connect group derives an OAuth redirect URI from the Console's own origin", () => {
    const connectApiSrc = readFileSync(new URL("./connectApi.ts", import.meta.url), "utf8");
    const partsSrc = readFileSync(new URL("./parts.tsx", import.meta.url), "utf8");

    // Landmark FIRST: a moved, renamed or emptied file must fail loudly here rather than pass
    // against an empty read (a `not.toContain` on "" is always green).
    expect(connectApiSrc.length).toBeGreaterThan(100);
    expect(partsSrc.length).toBeGreaterThan(100);
    expect(connectApiSrc).toContain("useRedirectUri");
    expect(partsSrc).toContain("StepsColumn");

    // The Console's own origin must never be an input to this string. Both files, because the
    // derivation lived in one and was rendered by the other.
    expect(connectApiSrc).not.toContain("GATEWAY_URL");
    expect(partsSrc).not.toContain("GATEWAY_URL");
    // And no hand-built callback literal either — a `${base}/api/oauth/${p}/callback` template is
    // exactly the shape that was deleted, and the format string is what made its old test vacuous.
    expect(connectApiSrc).not.toContain("/callback");
    expect(partsSrc).not.toContain("/callback");
  });
});
