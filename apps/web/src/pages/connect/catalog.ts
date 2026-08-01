// The connect catalog — the nine connectable sources + the Add-a-source grid, ported from the Paper
// design (app 01KY3S7JMA16R0QZVSX084WWDD): `Add a source` 1WR-0 and the nine connect screens
// (25W-0 587-0 559-0 529-0 · 2C9-0 5B9-0 5EC-0 · 5HD-0 · 2F2-0). Every string here started as the
// design's own copy, read via get_jsx — nothing is invented.
//
// THE CARD COPY NOW DIVERGES FROM THE PLATE in two waves, deliberately, under #106 and build-notes
// §17.0 ("where a plate and the shipped code disagree about what the API SERVES, the code wins and
// the plate is corrected"). A plate correction is owed for each:
//   1. Apple Health step 1 drew "add the Postern Health shortcut — scan the code or open the link".
//      No shortcut is published, no endpoint serves one, and there is no link — the screen drew an
//      empty QR placeholder where the code would be. A first instruction that cannot be followed.
//   2. Apple Health's footnote claimed Postern "backs it up". Postern keeps the metrics a device
//      chooses to push, from the day pushing starts; that is a faithful cache, not a backup.
//   3. Apple Health's `cta` was "Add the Postern Health shortcut", the label of the disabled button
//      #106 §2b removed. It now names the button the screen actually draws.
//   4. (#121, the G1 fresh-install walkthrough, 2026-07-29/30) The Google, Gmail, Microsoft and
//      Apple Health steps now carry the traps a stranger hit LIVE, per docs/product/
//      onboarding-guide.md §3: Google's API-enablement + consent-screen/Test-users steps and the
//      two consent screens; Gmail's 2SV precondition + the direct app-passwords URL; Microsoft's
//      exact account-type and platform option names + "skip API permissions"; Apple Health leads
//      with Health Auto Export (the path that verifiably runs in production) rather than a
//      hand-built Shortcut. Steps gained an optional `warn` lane for these proven wrong turns.
// The plate's FORM is untouched by all of these — only claims about what is served and what the
// walkthrough proved a stranger needs.
//
// This is a STATIC product catalog (no fetch): the gateway exposes no "list providers" route, so the
// set of connectable sources is a product fact the Console owns. Each entry drives a LIVE typed REST
// call when the operator connects (see connectApi.ts).
//
// `providerKey` is the EXACT string the backend registers (`src/connectors/*.ts` → `readonly
// provider`): apple · gmail · simplefin · home_assistant · microsoft · google · whoop · plaid ·
// apple_health. `tile` is the ported ProviderTile id. `slug` is the URL segment (/connect/:slug) AND
// the field-guide slug on the public site — one string, two uses, no mapping to keep in step
// (#136; see `guideUrl` at the foot of this file).
//
// Provider taxonomy is honest (#55): Gmail (IMAP) and Google (OAuth calendar+contacts) are distinct
// cards; Apple/iCloud (mail+calendar+contacts) and Apple Health (device push) are distinct cards.
// Google fans out to calendar+contacts only — Gmail is a separate IMAP connection (build-notes §2.2).

import type { ProviderId } from "../../marks";
import type { Sector } from "../../marks";
import type { OAuthProvider } from "../../api/client";

/** The four credential shapes the connect template adapts its middle to (build-notes §2.1). */
export type Custody = "paste" | "oauth" | "plaid" | "device";

/** One field the paste/oauth configure card collects. `wire` names which submit argument it feeds. */
export interface ConnectField {
  /** Small-caps field label (e.g. "Apple ID"). */
  label: string;
  /** Placeholder shown when empty (the design's own ghost text). */
  placeholder: string;
  /** Monospace input (tokens/secrets) vs body input (ids/addresses). */
  mono?: boolean;
  /** Masked input — value never echoed to the DOM as plain text (secrets/passwords/tokens). */
  secret?: boolean;
  /** Which submit argument this field supplies. */
  wire: "username" | "secret" | "instanceUrl" | "clientId" | "clientSecret";
  /** An always-visible line under the input, for a constraint the placeholder cannot carry.
   *  Not an error: it is rendered whether or not the field is valid. */
  hint?: string;
}

/** One numbered "at the source" step. `redirect` splices the templated redirect URI inline (OAuth). */
export interface ConnectStep {
  before: string;
  /** When true, the gateway-served redirect URI is rendered — copyable — after `before` (the
   *  guide's rule: pasted, never hand-typed). The old inline `after` tail was removed with the
   *  Copyable: a block box ends the sentence, so trailing prose belongs in `before` or `warn`. */
  redirect?: boolean;
  /** An always-visible caution under the step, for a wrong turn PROVEN live (the G1 walkthrough,
   *  #121). The step-grain sibling of `ConnectField.hint`: not an error, rendered whether or not
   *  anything is wrong — it exists so the wrong turn is named BEFORE it is taken. */
  warn?: string;
}

export interface ProviderDef {
  slug: string;
  providerKey: string;
  tile: ProviderId;
  name: string;
  custody: Custody;
  /** Every sector the credential fans out to (the connect footer's chips + the card's sector run). */
  sectors: Sector[];
  /** The sector a single-connector paste/device credential is created against. Undefined for the
   *  Apple fan-out (server-side) and for OAuth (auto-created from scopes). */
  connectSector?: Sector;

  // ── Add-a-source card (1WR-0) ──
  /** The card's one-line descriptor under the name. */
  cardSub: string;
  /** The card's mono sector caption, beside the sector specimens ("Mail · Calendar · Contacts",
   *  "Finance · free default", …). Named for the run, not for the dots it used to sit next to (§17.2). */
  cardSectorRun: string;

  // ── Connect screen (masthead) ──
  /** The italic line under the provider name on the connect screen. */
  mastheadSub: string;

  // ── Connect screen (left column: steps at the source) ──
  stepsHeader: string;
  steps: ConnectStep[];
  footnote: string;

  // ── Connect screen (right card) ──
  /** The right-card small-caps header ("Paste it here" / "Configure the app" / "Your ingest endpoint"). */
  formHeader: string;
  fields: ConnectField[];
  /** The primary submit label. */
  cta: string;
  /** The "creates {sectors} — …" footer line after the sector chips. */
  createsLine: string;

  // ── OAuth-specific ──
  oauthProvider?: OAuthProvider;
  /** Confidential clients (google/whoop/plaid) require a client secret; public (microsoft) does not. */
  confidential?: boolean;
}

// ── Paste-token sources ──

const ICLOUD: ProviderDef = {
  slug: "icloud",
  providerKey: "apple",
  tile: "apple",
  name: "iCloud",
  custody: "paste",
  sectors: ["mail", "calendar", "contacts"],
  cardSub: "Apple ID + app-specific password",
  cardSectorRun: "Mail · Calendar · Contacts",
  mastheadSub: "Apple ID + app-specific password",
  stepsHeader: "Get your app-specific password",
  steps: [
    { before: "Sign in at appleid.apple.com with your Apple ID." },
    { before: "Under Sign-In & Security → App-Specific Passwords, generate a new one." },
    { before: 'Name it "Postern" and copy the xxxx-xxxx-xxxx-xxxx code.' },
  ],
  // "Apple ID password" is the plate's wording and is the correct one: the thing Postern never sees
  // is specifically the Apple ID password, and naming it that way is what separates it from the
  // app-specific password on the next line. The service is iCloud; the credential is an Apple ID
  // app-password (§18.4.1), so "Apple ID" stays everywhere the CREDENTIAL is named.
  footnote:
    "Postern never sees your Apple ID password — only this scoped, revocable app-password, sealed in the local vault.",
  formHeader: "Paste it here",
  fields: [
    { label: "Apple ID", placeholder: "you@icloud.com", wire: "username" },
    { label: "App-specific password", placeholder: "xxxx-xxxx-xxxx-xxxx", mono: true, secret: true, wire: "secret" },
  ],
  cta: "Connect iCloud",
  createsLine: "— from this one credential.",
};

const GMAIL: ProviderDef = {
  slug: "gmail",
  providerKey: "gmail",
  tile: "gmail",
  name: "Gmail",
  custody: "paste",
  sectors: ["mail"],
  connectSector: "mail",
  cardSub: "app-password over IMAP",
  cardSectorRun: "Mail",
  mastheadSub: "app-password over IMAP",
  stepsHeader: "Get an app password",
  steps: [
    {
      // The page the next step needs DOES NOT EXIST until 2SV is on — "no amount of searching the
      // Security page finds it", watched live on the G1 walkthrough (#121).
      before: "Turn on 2-Step Verification in your Google Account first — the app-passwords page does not exist until it is on.",
    },
    {
      // The old step said "Security → App passwords", a path that is invisible pre-2SV and hard to
      // find after. The working instruction is the DIRECT URL (onboarding-guide §2 Gmail).
      before: "Go directly to myaccount.google.com/apppasswords — searching the Security page won't find it.",
    },
    { before: 'Name it "Postern" and copy the 16-character code.' },
  ],
  footnote:
    "Postern never sees your Google password — only this scoped, revocable app-password, read-only over IMAP, sealed in the local vault.",
  formHeader: "Paste it here",
  fields: [
    { label: "Gmail address", placeholder: "you@gmail.com", wire: "username" },
    { label: "App password", placeholder: "xxxx xxxx xxxx xxxx", mono: true, secret: true, wire: "secret" },
  ],
  cta: "Connect Gmail",
  createsLine: "— envelopes only; bodies are fetched on demand, never stored.",
};

const SIMPLEFIN: ProviderDef = {
  slug: "simplefin",
  providerKey: "simplefin",
  tile: "simplefin",
  name: "SimpleFIN",
  custody: "paste",
  sectors: ["finance"],
  connectSector: "finance",
  cardSub: "access URL from the Bridge",
  cardSectorRun: "Finance · free default",
  mastheadSub: "access URL from the Bridge",
  stepsHeader: "Get your access URL",
  steps: [
    { before: "Create a free account at bridge.simplefin.org." },
    { before: "Connect your banks in the Bridge, then request an access URL." },
    { before: "Copy the setup token — or the full access URL." },
  ],
  footnote:
    "Postern never sees your bank logins — SimpleFIN's Bridge holds those. Postern gets a read-only access URL, sealed in the local vault.",
  formHeader: "Paste it here",
  fields: [
    { label: "Access URL", placeholder: "https://…@bridge.simplefin.org/…", secret: true, wire: "secret" },
  ],
  cta: "Connect SimpleFIN",
  createsLine: "— read-only. Your banks are linked at SimpleFIN Bridge, not here.",
};

const HOME_ASSISTANT: ProviderDef = {
  slug: "home-assistant",
  providerKey: "home_assistant",
  tile: "homeassistant",
  name: "Home Assistant",
  custody: "paste",
  sectors: ["home"],
  connectSector: "home",
  cardSub: "long-lived token + instance URL",
  cardSectorRun: "Home · can act",
  mastheadSub: "long-lived token + instance URL",
  stepsHeader: "Create a long-lived token",
  steps: [
    { before: "Open Home Assistant → your profile (bottom-left)." },
    { before: "Scroll to Long-Lived Access Tokens → Create Token." },
    { before: 'Name it "Postern" and copy the token — it’s shown once.' },
  ],
  // "HA" is this repo's shorthand, not the reader's — the person is looking at a screen headed Home
  // Assistant and has never met the abbreviation (#106).
  footnote:
    "The token carries only what your Home Assistant user can do. Postern reads AND acts on Home, and state changes stream in live. Sealed in the local vault.",
  formHeader: "Paste it here",
  fields: [
    // Our own packaging says an mDNS `.local` name will not resolve from inside the container
    // (docker-compose.yml, .env.example) — so the example a user copies has to be a LAN IP, and the
    // constraint has to be beside the input they are typing into (#96 §3). We TEACH it; we do not
    // reject `.local` in validateShape: a gateway run outside Docker CAN resolve mDNS.
    {
      label: "Instance URL",
      placeholder: "http://192.168.1.50:8123",
      wire: "instanceUrl",
      hint: "Use your Home Assistant machine's LAN IP. A .local (mDNS) address won't resolve from inside Postern's container.",
    },
    { label: "Long-lived token", placeholder: "paste the token", mono: true, secret: true, wire: "secret" },
  ],
  cta: "Connect Home Assistant",
  createsLine: "— the only sector that can act, not just read.",
};

// ── OAuth (BYO app) sources ──

const MICROSOFT: ProviderDef = {
  slug: "microsoft",
  providerKey: "microsoft",
  tile: "microsoft",
  name: "Microsoft",
  custody: "oauth",
  oauthProvider: "microsoft",
  confidential: false,
  sectors: ["mail", "calendar", "contacts"],
  cardSub: "public client · PKCE, no secret",
  cardSectorRun: "Mail · Calendar · Contacts",
  mastheadSub: "register your own app, then consent",
  stepsHeader: "Register your app",
  // The two questions the G1 walkthrough had to stop and ask (#121, onboarding-guide §2 Microsoft):
  // which account types, and which platform. Both exact option names are on the card now, and the
  // one silently-expensive wrong pick (SPA) is named with its consequence.
  steps: [
    {
      before:
        'Sign in at entra.microsoft.com → App registrations → New registration. Supported account types: "Any Entra ID Tenant + Personal Microsoft accounts".',
    },
    {
      before: 'Add the redirect URI under the platform "Public client/native (mobile & desktop)" — the platform page calls the same thing "Mobile and desktop applications":',
      redirect: true,
      warn: "Not Single-page application (SPA) — that platform caps sign-ins at 24 hours, so you'd re-consent daily.",
    },
    {
      before:
        "Register, then copy the Application (client) ID from Overview. Skip API permissions entirely — unlike Google there is no API-enabling step; the consent screen at sign-in is where you grant the scopes.",
    },
  ],
  footnote:
    "Microsoft is a public client — no secret is stored. Postern receives only a scoped, revocable token, and can refresh it silently.",
  formHeader: "Configure the app",
  fields: [
    { label: "Application (client) ID", placeholder: "00000000-0000-0000-0000-000000000000", wire: "clientId" },
    { label: "Client secret", placeholder: "not required — public client (PKCE)", mono: true, wire: "clientSecret" },
  ],
  cta: "Save & sign in with Microsoft",
  createsLine: "— from this one consent.",
};

const GOOGLE: ProviderDef = {
  slug: "google",
  providerKey: "google",
  tile: "google",
  name: "Google",
  custody: "oauth",
  oauthProvider: "google",
  confidential: true,
  // calendar + contacts ONLY. Gmail is a separate IMAP connection (build-notes §2.2). The
  // Add-a-source card artboard drew three dots incl. Mail; that is drift — the Google connect screen
  // (5B9-0) and the backend both fan out to calendar+contacts. Ported honest; drift reported.
  sectors: ["calendar", "contacts"],
  cardSub: "confidential · client id + secret",
  cardSectorRun: "Calendar · Contacts",
  mastheadSub: "register your own app, then consent",
  stepsHeader: "Register your app",
  // Every step and warn below is a dead-end hit LIVE on the G1 fresh-install walkthrough (#121,
  // onboarding-guide §2 Google): the missing API-enablement step (with the legacy-Contacts-API
  // decoy — the cause of the 403-after-consent, twice), the missing consent-screen/Test-users step
  // (Google refuses the app's own creator until listed), and the two consent screens that read as
  // failures. NEVER add a Gmail scope or suggest enabling the Gmail API here (ADR 0002 — it would
  // trigger Google's annual CASA assessment for every self-hosted deployment); Gmail stays a
  // separate IMAP connection.
  steps: [
    {
      before:
        'Sign in at console.cloud.google.com, pick (or create) a project, and under APIs & Services → Library enable "Google Calendar API" and "People API" — in the same project as everything below.',
      warn: 'Searching "contacts" surfaces the deprecated legacy Contacts API first; enabling it does nothing. Contacts come through the People API. A 403 right after a good consent means one of these APIs isn\'t enabled yet.',
    },
    {
      before:
        "Set up the OAuth consent screen before any client: audience External, then under Test users add your own address — while the app is in Testing, Google refuses every account not listed, including yours.",
    },
    {
      before: "Create an OAuth client, type Web application — add this redirect URI, pasted exactly:",
      redirect: true,
    },
    {
      before: "Copy the client ID and client secret into the card here, then sign in.",
      warn: 'Two Google screens follow: on "Google hasn\'t verified this app", Continue is the small link — the prominent button aborts. On the scopes screen the checkboxes start EMPTY: tick them, or consent "succeeds" granting nothing.',
    },
  ],
  footnote:
    "Google is a confidential client — the secret is sealed in the local vault and sent only to refresh. While the app's publishing status is Testing, Google expires access every 7 days; when weekly re-consents get old, set it to In production — a form, not a review, for a personal app.",
  formHeader: "Configure the app",
  fields: [
    { label: "Client ID", placeholder: "…apps.googleusercontent.com", wire: "clientId" },
    { label: "Client secret", placeholder: "GOCSPX-…", mono: true, secret: true, wire: "clientSecret" },
  ],
  cta: "Save & sign in with Google",
  createsLine: "— from this one consent. Gmail is a separate IMAP connection.",
};

const WHOOP: ProviderDef = {
  slug: "whoop",
  providerKey: "whoop",
  tile: "whoop",
  name: "Whoop",
  custody: "oauth",
  oauthProvider: "whoop",
  confidential: true,
  sectors: ["health"],
  cardSub: "confidential · offline scope",
  cardSectorRun: "Health",
  mastheadSub: "register your own app, then consent",
  stepsHeader: "Register your app",
  steps: [
    { before: "Sign in at developer.whoop.com and create a new app." },
    // The redirect renders as a copyable block, so the offline-scope clause rides the sentence
    // BEFORE it rather than dangling after the box.
    { before: "Request the offline scope, and add this redirect URI:", redirect: true },
    { before: "Copy the client ID and client secret." },
  ],
  footnote:
    "Whoop is a confidential client with offline access — the secret is sealed in the vault, sent only to refresh. Read-only recovery, strain & sleep.",
  formHeader: "Configure the app",
  fields: [
    { label: "Client ID", placeholder: "your Whoop client id", wire: "clientId" },
    { label: "Client secret", placeholder: "your Whoop secret", mono: true, secret: true, wire: "clientSecret" },
  ],
  cta: "Save & sign in with Whoop",
  createsLine: "— recovery, sleep and day-strain, alongside Apple Health.",
};

// ── Plaid (BYO app + hosted Link) ──

const PLAID: ProviderDef = {
  slug: "plaid",
  providerKey: "plaid",
  tile: "plaid",
  name: "Plaid",
  custody: "plaid",
  confidential: true,
  sectors: ["finance"],
  connectSector: "finance",
  cardSub: "connect banks in a hosted flow",
  cardSectorRun: "Finance · paid coverage",
  mastheadSub: "register your app, then link banks",
  stepsHeader: "Register your app",
  steps: [
    { before: "Sign in at dashboard.plaid.com → Team Settings → Keys." },
    { before: "Copy your client_id and the Production secret." },
    { before: "Request Production access if you haven’t — Plaid approves it." },
  ],
  footnote:
    "Plaid is the paid coverage-upgrade. The secret is sealed in the vault. Banks link through Plaid's hosted flow — Postern never sees your bank login. Console defaults to Production.",
  formHeader: "Configure the app",
  fields: [
    { label: "Client ID", placeholder: "your Plaid client_id", wire: "clientId" },
    { label: "Secret", placeholder: "your Production secret", mono: true, secret: true, wire: "clientSecret" },
  ],
  cta: "Save & add a bank",
  createsLine: "— read-only, and each bank you link becomes its own connection.",
};

// ── Apple Health (on-device push) ──

const APPLE_HEALTH: ProviderDef = {
  slug: "apple-health",
  providerKey: "apple_health",
  tile: "apple_health",
  name: "Apple Health",
  custody: "device",
  sectors: ["health"],
  connectSector: "health",
  cardSub: "your iPhone pushes here",
  cardSectorRun: "Health · on-device",
  mastheadSub: "your iPhone pushes here",
  stepsHeader: "Set up the push",
  // HAE-FIRST (#121, onboarding-guide §2 Apple Health): the shortcut-first framing led with the
  // path nobody has verified long-term, while the Health Auto Export app is what has run in
  // production since June — so the app leads, with the exact settings that work, and the hand-built
  // Shortcut stays as the alternative beside the payload template. Still NO Postern-published
  // shortcut to scan or open (#106: never claim more than the data supports).
  steps: [
    {
      before:
        "Create your ingest endpoint on the right — Postern mints the URL and secret your phone will POST to.",
    },
    {
      before:
        "On your iPhone, get the Health Auto Export app and add a REST API automation pointed at that endpoint, with the secret in the header.",
      warn: "The settings that work: format JSON · export version v2 · file length day · Aggregate Data on. Its REST automations may need the app's paid tier.",
    },
    {
      before:
        "Pick your metrics, set the schedule, then run it once — samples stream in from then on. Prefer to build it yourself? A Shortcut that POSTs the template below works too.",
    },
  ],
  // "so Postern backs it up" claimed more than is true: Postern keeps the metrics your device chooses
  // to send, from the day you start sending them — that is a faithful cache of a push, not a backup of
  // your Health store (#106).
  footnote:
    "Your Health data never goes to a third party — the shortcut posts straight to your own gateway. Nothing can read Apple Health from off your phone, so what you push here is what an agent can see.",
  formHeader: "Your ingest endpoint",
  fields: [],
  cta: "Create your ingest endpoint",
  createsLine: "— your device pushes on its own schedule; Postern cannot pull.",
};

/** Every source, in the Add-a-source grid order (paste · oauth · hosted · device). */
export const PROVIDERS: ProviderDef[] = [
  ICLOUD,
  GMAIL,
  SIMPLEFIN,
  HOME_ASSISTANT,
  MICROSOFT,
  GOOGLE,
  WHOOP,
  PLAID,
  APPLE_HEALTH,
];

/** The Add-a-source grid, grouped exactly as the design lays it out (1WR-0). */
export interface AddSourceGroup {
  header: string;
  gloss?: string;
  providers: ProviderDef[];
}

export const ADD_SOURCE_GROUPS: AddSourceGroup[] = [
  {
    header: "Paste a token",
    gloss: "link it at the source, then paste what it gives you",
    providers: [ICLOUD, GMAIL, SIMPLEFIN, HOME_ASSISTANT],
  },
  {
    header: "Sign in with the provider",
    gloss: "register your own app once, then click through consent",
    providers: [MICROSOFT, GOOGLE, WHOOP],
  },
  { header: "Hosted link", providers: [PLAID] },
  { header: "On your device", providers: [APPLE_HEALTH] },
];

/** Resolve a URL slug to its provider def, or undefined for an unknown slug. */
export function providerBySlug(slug: string | undefined): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.slug === slug);
}

// ── The field guides on the public site (#136) ──

/**
 * Where the field guides live — stated ONCE, and never derived from the box this Console happens to
 * run on.
 *
 * A gate's own origin, remote-access host, exposure state and env say nothing about where the guides
 * are published: Postern ships to strangers' machines, on loopback and behind Funnels, and every one
 * of those installs reads the same public site. Deriving this from anything local would give each
 * install a different (mostly broken) answer to a question that has one.
 */
const GUIDES_ORIGIN = "https://getpostern.com/guides";

/**
 * The field guide for a source — `https://getpostern.com/guides/<slug>`.
 *
 * The catalog `slug` IS the guide slug. The site publishes `/guides/<slug>` for google · gmail ·
 * microsoft · icloud · plaid · simplefin · whoop · home-assistant · apple-health (plus
 * remote-access, which is not a connectable source), so the mapping is the identity and there is no
 * second table to drift.
 *
 * ONE derivation, deliberately: nine hand-typed URLs is how one renamed page 404s from a shipped
 * Console — silently, because nothing in this repo can see the site's routes — and how the tenth
 * provider ships linkless. Add a source, and its guide link exists the same commit.
 *
 * `encodeURIComponent` so a slug can never grow the URL an extra path segment, a query string or a
 * fragment. The guide URL carries NO parameters, ever: nothing about this gate — not its host, not a
 * connection id, not which step failed — travels to the public site.
 */
export function guideUrl(def: ProviderDef): string {
  return guideUrlForSlug(def.slug);
}

/**
 * The same derivation for a guide that is NOT a connectable source.
 *
 * `remote-access` is published on the site and has no catalog entry — it is the Tailscale + Funnel
 * walkthrough behind the hosted-connect page's step 1 — so `guideUrl(def)` cannot reach it. The
 * general form lives HERE, beside `GUIDES_ORIGIN`, rather than beside its caller: the whole point of
 * the one derivation is that no second file writes a guides URL, and an origin typed once in
 * `pages/agents` goes stale on a site rename exactly as silently as nine typed in this group would.
 *
 * `guideUrl` now routes through it, so the two can never disagree about the origin or the encoding.
 */
export function guideUrlForSlug(slug: string): string {
  return `${GUIDES_ORIGIN}/${encodeURIComponent(slug)}`;
}

/** The remote-access field guide's slug, named where the site's slugs are already known. */
export const REMOTE_ACCESS_GUIDE_SLUG = "remote-access";
