// Catalog invariants — the taxonomy honesty #55 turns on (Gmail ≠ Google, Apple ≠ Apple Health), and
// the provider keys that must match the backend `readonly provider` exactly or a live connect 404s.

import { describe, expect, it } from "vitest";
import { PROVIDERS, ADD_SOURCE_GROUPS, providerBySlug } from "./catalog";

/** The exact backend provider keys (`src/connectors/*.ts`). A drift here is a dead connect flow. */
const BACKEND_KEYS = new Set([
  "apple",
  "gmail",
  "simplefin",
  "home_assistant",
  "microsoft",
  "google",
  "whoop",
  "plaid",
  "apple_health",
]);

describe("catalog", () => {
  it("has all nine sources, each with a backend-recognised provider key", () => {
    expect(PROVIDERS).toHaveLength(9);
    for (const p of PROVIDERS) expect(BACKEND_KEYS.has(p.providerKey)).toBe(true);
  });

  it("uses unique slugs, resolvable back to the def", () => {
    const slugs = PROVIDERS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of PROVIDERS) expect(providerBySlug(p.slug)).toBe(p);
  });

  it("keeps the honest provider taxonomy (#55): Gmail and Google are distinct, Apple and Apple Health are distinct", () => {
    const gmail = providerBySlug("gmail")!;
    const google = providerBySlug("google")!;
    const apple = providerBySlug("icloud")!;
    const appleHealth = providerBySlug("apple-health")!;

    expect(gmail.providerKey).toBe("gmail");
    expect(google.providerKey).toBe("google");
    expect(apple.providerKey).toBe("apple");
    expect(appleHealth.providerKey).toBe("apple_health");

    // Google fans out to calendar + contacts ONLY — Gmail is a separate IMAP connection (build-notes
    // §2.2). The Add-a-source card artboard drew three dots incl. Mail; that is drift, corrected here.
    expect(google.sectors).toEqual(["calendar", "contacts"]);
    expect(google.sectors).not.toContain("mail");
    expect(gmail.sectors).toEqual(["mail"]);
  });

  it("flags confidential vs public OAuth clients correctly (drives the secret field)", () => {
    expect(providerBySlug("microsoft")!.confidential).toBe(false); // public/PKCE — no secret
    expect(providerBySlug("google")!.confidential).toBe(true);
    expect(providerBySlug("whoop")!.confidential).toBe(true);
  });

  // Our own packaging says an mDNS `.local` name will not resolve from inside the container
  // (docker-compose.yml: "LAN IP, NOT mDNS .local"; .env.example: HA_URL=http://192.168.1.50:8123),
  // and Home Assistant is the read-AND-act sector — the self-hoster's headline reason to try
  // Postern. The card taught the address that does not work (#96 §3).
  it("the Home Assistant instance-URL example is a LAN IP, never an mDNS name", () => {
    const field = providerBySlug("home-assistant")!.fields.find((f) => f.wire === "instanceUrl")!;
    // The negative alone passes for an empty string, so pin the exact value too.
    expect(field.placeholder).toBe("http://192.168.1.50:8123");
    expect(field.placeholder).not.toMatch(/\.local/);
  });

  it("the Home Assistant instance-URL field explains why mDNS won't resolve", () => {
    const field = providerBySlug("home-assistant")!.fields.find((f) => f.wire === "instanceUrl")!;
    expect(field.hint).toBe(
      "Use your Home Assistant machine's LAN IP. A .local (mDNS) address won't resolve from inside Postern's container.",
    );
  });

  /**
   * #106 — the Apple Health screen may not promise a shortcut Postern does not publish.
   *
   * Step 1 read "add the Postern Health shortcut — scan the code or open the link". There is no such
   * shortcut, no endpoint that serves one, and no link: the screen drew three empty squares captioned
   * "not served" where the code would be. A step that tells someone to scan a code that does not exist
   * is not a small copy problem — it is the first instruction on the screen.
   *
   * MUTATION: put "scan the code or open the link" back → RED.
   */
  it("the Apple Health steps promise nothing Postern does not serve — no code to scan, no link to open", () => {
    const ah = providerBySlug("apple-health")!;
    const steps = ah.steps.map((s) => `${s.before} ${s.warn ?? ""}`).join(" ");
    expect(steps).not.toMatch(/scan the code|open the link|Postern Health shortcut/i);
    // What survives is what a person can actually do, and it points at the two things on the screen.
    expect(steps).toMatch(/POST/);
    expect(steps).toMatch(/ingest endpoint/i);
  });

  /**
   * The device screen's ONE primary button reads from the catalog, so the label cannot rot unseen.
   *
   * `cta` was "Add the Postern Health shortcut", used only by a disabled button that #106 removed —
   * which would have left a stale string in the catalog with no render site to falsify it. The create
   * button now uses `def.cta`, so every catalog entry's `cta` is a label something actually draws.
   */
  it("Apple Health's cta is the button the screen actually draws", () => {
    expect(providerBySlug("apple-health")!.cta).toBe("Create your ingest endpoint");
    for (const p of PROVIDERS) expect(p.cta.trim().length).toBeGreaterThan(0);
  });

  /**
   * #106 — a footnote about a credential or a data path may not claim more than is true.
   *
   * "Apple Health is the one irreplaceable store, so Postern backs it up" promised a BACKUP. Postern
   * keeps the metrics your device chooses to send, from the day you start sending them; that is a
   * faithful cache of a push, not a backup of your Health store. The honest fact underneath it — that
   * nothing can read Apple Health from off the phone — is the reason the connector is push-only, and it
   * survives.
   *
   * MUTATION: restore "so Postern backs it up" → RED.
   */
  it("no footnote claims Postern backs a source up, and none abbreviates a provider's name", () => {
    for (const p of PROVIDERS) {
      expect(p.footnote).not.toMatch(/backs? (it|them) up|backup/i);
      // "HA" is this repo's shorthand for Home Assistant; the reader has never met it (#106).
      expect(p.footnote).not.toMatch(/\bHA\b/);
    }
    expect(providerBySlug("apple-health")!.footnote).toMatch(/read Apple Health from off your phone/);
    expect(providerBySlug("home-assistant")!.footnote).toMatch(/your Home Assistant user/);
  });

  it("lays the Add-a-source grid out in four groups, covering every source once", () => {
    const headers = ADD_SOURCE_GROUPS.map((g) => g.header);
    expect(headers).toEqual(["Paste a token", "Sign in with the provider", "Hosted link", "On your device"]);
    const gridSlugs = ADD_SOURCE_GROUPS.flatMap((g) => g.providers.map((p) => p.slug)).sort();
    expect(gridSlugs).toEqual(PROVIDERS.map((p) => p.slug).sort());
  });
});

/**
 * #121 — the cards carry the traps a stranger actually hit, live, on the G1 fresh-install
 * walkthrough (2026-07-29/30; docs/product/onboarding-guide.md §3 is the proven fix list). Each
 * assertion below pins a string that ENCODES a trap — the exact option name, the exact URL, the
 * exact consequence — not the surrounding prose. MUTATION for every cell: delete or soften the
 * named fact in catalog.ts → red.
 */
describe("the connect cards state the live-caught traps (#121)", () => {
  /** All of a card's step copy, warns included — the full always-visible text of the left column. */
  function stepText(slug: string): string {
    const p = providerBySlug(slug)!;
    return p.steps.map((s) => `${s.before} ${s.warn ?? ""}`).join(" ");
  }

  /** EVERY rendered string of a card def — the surface the ADR-0002 guard must cover. Enumerated
   *  from the ProviderDef fields the connect screens draw, so a string planted in ANY lane
   *  (cardSub, cta, a field placeholder, a warn…) is inside the net, not beside it. */
  function allCardText(slug: string): string {
    const p = providerBySlug(slug)!;
    return [
      p.name,
      p.cardSub,
      p.cardSectorRun,
      p.mastheadSub,
      p.stepsHeader,
      p.formHeader,
      p.cta,
      p.createsLine,
      p.footnote,
      ...p.steps.flatMap((s) => [s.before, s.warn ?? ""]),
      ...p.fields.flatMap((f) => [f.label, f.placeholder, f.hint ?? ""]),
    ].join(" ");
  }

  it("Google: both APIs by name, the legacy-Contacts decoy warned off, in the SAME project", () => {
    const steps = stepText("google");
    expect(steps).toContain('"Google Calendar API"');
    expect(steps).toContain('"People API"');
    // The decoy that caused the live 403 twice: searching "contacts" finds the dead API first.
    expect(steps).toMatch(/legacy Contacts API/);
    expect(steps).toMatch(/enabling it does nothing/i);
    expect(steps).toMatch(/same project/i);
    // …and the 403-after-consent is pre-explained where the person is standing.
    expect(steps).toMatch(/403/);
  });

  it("Google: the consent screen + Test users step exists — External, add your own address", () => {
    const steps = stepText("google");
    expect(steps).toMatch(/consent screen/i);
    expect(steps).toMatch(/External/);
    expect(steps).toMatch(/Test users/);
    expect(steps).toMatch(/add your own address/i);
  });

  it("Google: both consent screens are forewarned — Continue is the small link; the checkboxes start empty", () => {
    const steps = stepText("google");
    expect(steps).toMatch(/hasn't verified this app/);
    expect(steps).toMatch(/Continue is the small link/);
    expect(steps).toMatch(/checkboxes start EMPTY/);
  });

  it("Google: the 7-day Testing expiry is stated, with the In-production way out", () => {
    const google = providerBySlug("google")!;
    const all = `${stepText("google")} ${google.footnote}`;
    expect(all).toMatch(/7 days/);
    expect(all).toMatch(/In production/);
  });

  it("Google: never suggests a Gmail scope or enabling the Gmail API — on ANY rendered string of the card (ADR 0002)", () => {
    // The adversarial probe: "Gmail API" planted in cardSub or cta stayed green under a guard that
    // read only steps+footnote+createsLine. The guard now walks every lane the screens draw.
    //
    // MUTATION: plant "Gmail API" in ANY GOOGLE field — cardSub, cta, a placeholder, a warn → red.
    expect(allCardText("google")).not.toMatch(/Gmail API/);
    // The honest separation line survives on the creates footer.
    expect(providerBySlug("google")!.createsLine).toMatch(/Gmail is a separate IMAP connection/);
  });

  it("Microsoft: both exact option names — account types, and the platform under BOTH of Entra's labels", () => {
    const steps = stepText("microsoft");
    expect(steps).toContain('"Any Entra ID Tenant + Personal Microsoft accounts"');
    expect(steps).toContain('"Public client/native (mobile & desktop)"');
    expect(steps).toContain('"Mobile and desktop applications"');
  });

  it("Microsoft: the SPA wrong-pick is named WITH its consequence, and API permissions are skipped explicitly", () => {
    const steps = stepText("microsoft");
    expect(steps).toMatch(/Single-page application|SPA/);
    expect(steps).toMatch(/24 hours/);
    expect(steps).toMatch(/Skip API permissions/i);
    expect(steps).toMatch(/no API-enabling step/i);
    // No-secret stays loud on the card (public client, PKCE).
    expect(providerBySlug("microsoft")!.footnote).toMatch(/no secret is stored/);
  });

  it("Gmail: 2SV is a stated PRECONDITION, and the app-passwords path is the direct URL", () => {
    const steps = stepText("gmail");
    expect(steps).toMatch(/2-Step Verification/);
    expect(steps).toMatch(/does not exist until it is on/);
    expect(steps).toContain("myaccount.google.com/apppasswords");
    // The path proven invisible pre-2SV is gone.
    expect(steps).not.toMatch(/Security → App passwords/);
  });

  it("Apple Health: Health Auto Export leads, with the exact settings that run in production", () => {
    const steps = stepText("apple-health");
    expect(steps).toMatch(/Health Auto Export/);
    // The v2/JSON/aggregate/day settings (onboarding-guide §2 Apple Health — the prod config).
    expect(steps).toMatch(/JSON/);
    expect(steps).toMatch(/v2/);
    expect(steps).toMatch(/file length day/i);
    expect(steps).toMatch(/Aggregate Data on/i);
    // The hand-built Shortcut stays as the alternative, never the lead.
    const firstTwo = providerBySlug("apple-health")!
      .steps.slice(0, 2)
      .map((s) => `${s.before} ${s.warn ?? ""}`)
      .join(" ");
    expect(firstTwo).not.toMatch(/[Ss]hortcut/);
  });
});
