// The consent-return reader + its announcement (#96 §1.5) — pure, so the wording is tested.

import { describe, expect, it } from "vitest";
import { oauthReturnToast, readOauthReturn, withoutOauthReturn } from "./oauthReturn";

describe("readOauthReturn", () => {
  it("a return with both params reads as a return; either one missing reads as none", () => {
    expect(readOauthReturn(new URLSearchParams("credential_id=cred-x&provider=google"))).toEqual({
      credentialId: "cred-x",
      provider: "google",
    });
    // A HALF-set of params is not a return. Announcing off one of them would either name a provider
    // with no credential to look up, or a credential with no name to say.
    expect(readOauthReturn(new URLSearchParams("credential_id=cred-x"))).toBeNull();
    expect(readOauthReturn(new URLSearchParams("provider=google"))).toBeNull();
    expect(readOauthReturn(new URLSearchParams(""))).toBeNull();
    // present-but-empty is absent
    expect(readOauthReturn(new URLSearchParams("credential_id=&provider=google"))).toBeNull();
  });
});

describe("withoutOauthReturn", () => {
  it("stripping the return params leaves every other query param intact", () => {
    const stripped = withoutOauthReturn(
      new URLSearchParams("tab=banks&credential_id=cred-x&provider=google&sort=name"),
    );
    expect(stripped.toString()).toBe("tab=banks&sort=name");
    expect(stripped.get("credential_id")).toBeNull();
    expect(stripped.get("provider")).toBeNull();
  });

  it("does not mutate the params it was handed", () => {
    const original = new URLSearchParams("credential_id=cred-x&provider=google");
    withoutOauthReturn(original);
    expect(original.get("credential_id")).toBe("cred-x");
  });
});

describe("oauthReturnToast", () => {
  it("a consent that granted no sectors is announced as a problem, not a success", () => {
    // A consent whose granted scopes map to no sector creates ZERO connector rows and still 302s
    // successfully (sectorsForScopes). Saying "connected" over that is the same lie as toasting
    // success over a failed first sync.
    const t = oauthReturnToast("google", []);
    expect(t.tone).toBe("error");
    expect(t.message).toBe(
      "Google signed in, but granted no sectors. Check the scopes on your app, then sign in again.",
    );
    expect(t.message).not.toMatch(/connected/);
  });

  it("a consent names the sectors it actually activated", () => {
    const t = oauthReturnToast("google", ["Calendar", "Contacts"]);
    expect(t.tone).toBe("ok");
    expect(t.message).toBe("Google connected — Calendar and Contacts.");
  });

  it('two sectors join with "and"; three join with commas then "and"', () => {
    expect(oauthReturnToast("microsoft", ["Mail"]).message).toBe("Microsoft connected — Mail.");
    expect(oauthReturnToast("microsoft", ["Mail", "Calendar"]).message).toBe(
      "Microsoft connected — Mail and Calendar.",
    );
    expect(oauthReturnToast("microsoft", ["Mail", "Calendar", "Contacts"]).message).toBe(
      "Microsoft connected — Mail, Calendar and Contacts.",
    );
    // no Oxford comma, and never a bare join
    expect(oauthReturnToast("microsoft", ["Mail", "Calendar", "Contacts"]).message).not.toContain(
      "Calendar, and Contacts",
    );
    expect(oauthReturnToast("microsoft", ["Mail", "Calendar"]).message).not.toContain(
      "Mail, Calendar",
    );
  });

  it("names the provider through the ONE humanisation rule, never a local table", () => {
    // `apple` → iCloud is exactly the rename a second name table has already broken once.
    expect(oauthReturnToast("whoop", ["Health"]).message).toBe("WHOOP connected — Health.");
    expect(oauthReturnToast("apple", ["Mail"]).message).toBe("iCloud connected — Mail.");
  });
});
