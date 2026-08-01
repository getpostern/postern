// reconnectKindOf (#89 item 1) — the pure derivation behind the served `reconnect_kind`, DB-free.
//
// Every fixture below is a REAL shape from this repo, not a pose, because the whole reason the field is
// derived server-side is that the obvious client-side rules are wrong on exactly these shapes:
//
//   - Apple Health is onboarded through POST /api/credentials with a sentinel secret, so its row is
//     stamped custody 'static_token'. A custody-only rule tells the operator to paste a fresh token for
//     a source that has no token. (apps/web/src/pages/connect/connectApi.ts, admin.ts postCredential)
//   - Home Assistant is ALSO custody 'static_token' AND push — but push/'stream', and its reconnect
//     really is a re-pasted long-lived token. So "push means device" is wrong too.
//   - Plaid stores custody 'byo_app' (src/connectors/plaid.ts), the same value a BYO OAuth app stores.
//     Order the OAuth branch first and every bank reconnects through the wrong flow.
//   - Every OAuth callback stamps 'first_party' (src/rest/oauth-routes.ts) even though the beta's OAuth
//     is BYO-app (ADR 0014) — a value the design's four-form table has no row for at all.

import { describe, it, expect } from "vitest";
import { reconnectKindOf } from "./lifecycle.js";

describe("reconnectKindOf — the shapes that break the tempting rules", () => {
  it("Apple Health: custody says static_token, the TRANSPORT says device — device wins", () => {
    // The custody-only answer here would be 'repaste_token': a re-paste prompt for a Shortcut.
    expect(
      reconnectKindOf({
        custody: "static_token",
        provider: "apple_health",
        externalItemId: null,
        mode: "push",
        pushKind: "webhook",
      }),
    ).toBe("device_push");
  });

  it("Home Assistant: also static_token, also push — but push/stream, so it re-pastes a token", () => {
    expect(
      reconnectKindOf({
        custody: "static_token",
        provider: "home_assistant",
        externalItemId: null,
        mode: "push",
        pushKind: "stream",
      }),
    ).toBe("repaste_token");
  });

  it("a correctly-stamped on_device credential resolves even with NO registered connector", () => {
    expect(
      reconnectKindOf({
        custody: "on_device",
        provider: "apple_health",
        externalItemId: null,
        mode: null,
        pushKind: null,
      }),
    ).toBe("device_push");
  });

  it("Plaid: custody byo_app + an Item id -> update-link, NOT reauth_oauth (branch ORDER)", () => {
    expect(
      reconnectKindOf({
        custody: "byo_app",
        provider: "plaid",
        externalItemId: "item-abc",
        mode: "poll",
        pushKind: null,
      }),
    ).toBe("plaid_update_link");
  });

  it("Plaid before the Item exists (pre-exchange) is still update-link", () => {
    expect(
      reconnectKindOf({
        custody: "byo_app",
        provider: "plaid",
        externalItemId: null,
        mode: "poll",
        pushKind: null,
      }),
    ).toBe("plaid_update_link");
  });

  it("first_party and byo_app COLLAPSE to reauth_oauth — the open custody question cannot break it", () => {
    // This is the reason a discriminant is served instead of raw custody: whichever value the callback
    // stamped, the operator reconnects by re-running consent, so the answer is right either way.
    const google = reconnectKindOf({
      custody: "first_party",
      provider: "google",
      externalItemId: null,
      mode: "poll",
      pushKind: null,
    });
    const microsoft = reconnectKindOf({
      custody: "byo_app",
      provider: "microsoft",
      externalItemId: null,
      mode: "poll",
      pushKind: null,
    });
    expect(google).toBe("reauth_oauth");
    expect(microsoft).toBe("reauth_oauth");
  });

  it("SimpleFIN / Gmail-IMAP / iCloud pasted secrets -> repaste_token", () => {
    for (const provider of ["simplefin", "gmail", "apple"]) {
      expect(
        reconnectKindOf({
          custody: "static_token",
          provider,
          externalItemId: null,
          mode: "poll",
          pushKind: null,
        }),
      ).toBe("repaste_token");
    }
  });

  it("an unrecognised (or absent) custody says `none` rather than guessing a flow", () => {
    expect(
      reconnectKindOf({
        custody: "some_future_custody",
        provider: "whatever",
        externalItemId: null,
        mode: "poll",
        pushKind: null,
      }),
    ).toBe("none");
    expect(
      reconnectKindOf({
        custody: null,
        provider: "whatever",
        externalItemId: null,
        mode: "poll",
        pushKind: null,
      }),
    ).toBe("none");
  });

  it("a push connector with an UNRESOLVED push kind is not silently called a device", () => {
    // pushKindOf returns null for a push connector that declares neither start() nor decodePush().
    // Guessing 'device_push' there would put a re-mint-the-webhook button on a stream connection.
    expect(
      reconnectKindOf({
        custody: "static_token",
        provider: "mystery",
        externalItemId: null,
        mode: "push",
        pushKind: null,
      }),
    ).toBe("repaste_token");
  });
});
