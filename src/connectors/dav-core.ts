// dav-core — the provider-agnostic DAV layer shared by the iCloud CalDAV (calendar) and CardDAV
// (contacts) connectors (spec docs/specs/icloud-connector.md, ADR 0030).
//
// tsdav is the TRANSPORT ONLY (discovery + PROPFIND/REPORT/multiget). We NEVER trust its object
// mappers as a data boundary: the connectors parse the returned iCalendar / vCard bodies themselves
// (ical.js / vcard4). This module exposes the frozen dav-core surface (discoverCollections,
// syncCollection, ctagEtagDiff, multiget, davHealthProbe) plus an INJECTABLE transport seam — a
// DavTransport interface + a settable factory, mirroring gmail.ts's ImapClientFactory — so the
// connectors and tests fake the network (no real iCloud in tests).
//
// SECURITY (S1): cred.appPassword is the app-specific password (ASP). It is a CREDENTIAL — it MUST
// never be logged. tsdav's `debug` is off unless DEBUG is set; we set nothing. Every error thrown
// here is a clean, secret-free `apple: …` message (no ASP, username, or upstream body echoed).
//
// PARTITION HOST: iCloud shards accounts across p##-{caldav,contacts}.icloud.com hosts. The default
// transport RE-DISCOVERS the partition host on every call (createDAVClient → createAccount runs the
// .well-known + principal + home-set walk) and NEVER persists a p##- host (recon risk #1).

import { createDAVClient, DAVNamespaceShort } from "tsdav";
import type { DAVResponse } from "tsdav";

// ── Frozen public types (spec §Public signatures) ──────────────────────────────────

export type DavKind = "caldav" | "carddav";

export interface DavCredential {
  readonly username: string;
  readonly appPassword: string;
}

export interface DavCollection {
  readonly url: string;
  readonly displayName: string;
  readonly ctag: string | null;
  readonly syncToken: string | null;
}

/** A DAV resource body: the raw iCalendar / vCard text (parsed by the CONNECTOR, never by tsdav). */
export interface DavObject {
  readonly href: string;
  readonly etag: string;
  readonly body: string;
}

/** One href+etag from a Depth:1 getetag listing (the CardDAV / CalDAV-fallback diff primitive). */
export interface DavEtag {
  readonly href: string;
  readonly etag: string;
}

export interface SyncCollectionResult {
  changed: DavObject[];
  deletions: string[];
  nextToken: string;
}

export interface CtagEtagDiffResult {
  changed: string[];
  removedHrefs: string[];
  ctag: string;
}

// ── The injectable transport seam ───────────────────────────────────────────────────
// Every network operation dav-core needs, expressed tsdav-agnostically so a test can fake it with a
// plain object. The factory is credential-bound (mirrors gmail's ImapClientFactory taking options).

export interface DavTransport {
  /** .well-known + principal + home-set discovery → the account's collections (partition host resolved live). */
  discover(kind: DavKind): Promise<DavCollection[]>;
  /** RFC 6578 sync-collection REPORT. 404-in-report hrefs → deletions; returns the next sync-token. */
  syncCollection(collectionUrl: string, syncToken: string | null): Promise<SyncCollectionResult>;
  /** Cheap Depth:0 getctag probe (the change gate). null when the collection advertises none. */
  fetchCtag(collectionUrl: string): Promise<string | null>;
  /** Depth:1 getetag listing (member resources only — the collection self-href is excluded). */
  listEtags(collectionUrl: string): Promise<DavEtag[]>;
  /** calendar/address-book multiget of specific hrefs → their raw bodies. */
  multiget(kind: DavKind, collectionUrl: string, hrefs: string[]): Promise<DavObject[]>;
  /** PROPFIND Depth:0 auth probe. 401 ⇒ ASP revoked/wrong (ADR 0020 re-link). */
  healthProbe(kind: DavKind): Promise<{ ok: boolean; status: number }>;
}

export type DavTransportFactory = (cred: DavCredential) => DavTransport;

// ── The credential-bound default factory (settable for tests + connector injection) ─

let currentFactory: DavTransportFactory = defaultDavTransportFactory;

/** Override the process-wide default transport factory (tests). Pass null to restore the real one. */
export function setDavTransportFactory(factory: DavTransportFactory | null): void {
  currentFactory = factory ?? defaultDavTransportFactory;
}

/** The default factory the frozen free-functions (and un-injected connectors) use. */
export function getDavTransportFactory(): DavTransportFactory {
  return currentFactory;
}

// ── Pure diff helper (shared by the frozen ctagEtagDiff + the contacts connector) ───

/**
 * CardDAV (and CalDAV-fallback) change detection WITHOUT a sync-token (unreliable on iCloud): a
 * Depth:1 getetag listing diffed against the prior etag map. `changed` = hrefs new or whose etag
 * moved; `removedHrefs` = hrefs in `priorEtags` that VANISHED from the listing (deletions). Pass a
 * pre-fetched `knownCtag` to skip the redundant Depth:0 probe (the connector already gated on it).
 */
export async function runCtagEtagDiff(
  transport: DavTransport,
  collectionUrl: string,
  priorEtags: Record<string, string>,
  knownCtag?: string,
): Promise<CtagEtagDiffResult> {
  const ctag = knownCtag ?? (await transport.fetchCtag(collectionUrl)) ?? "";
  const listing = await transport.listEtags(collectionUrl);
  const seen = new Set<string>();
  const changed: string[] = [];
  for (const { href, etag } of listing) {
    seen.add(href);
    if (priorEtags[href] !== etag) changed.push(href);
  }
  const removedHrefs = Object.keys(priorEtags).filter((h) => !seen.has(h));
  return { changed, removedHrefs, ctag };
}

// ── The FROZEN dav-core surface (spec §Public signatures) ────────────────────────────

/** Re-discovers the per-account partition host every call — never persist p##- hosts (recon risk #1). */
export function discoverCollections(kind: DavKind, cred: DavCredential): Promise<DavCollection[]> {
  return getDavTransportFactory()(cred).discover(kind);
}

/** CalDAV: RFC 6578 sync-collection. Changed objects + next sync-token; removed = 404-in-report → deletions[]. */
export function syncCollection(
  collectionUrl: string,
  syncToken: string | null,
  cred: DavCredential,
): Promise<SyncCollectionResult> {
  return getDavTransportFactory()(cred).syncCollection(collectionUrl, syncToken);
}

/** CardDAV (+ CalDAV fallback): ctag-gated Depth:1 getetag listing diffed vs a prior etag map. */
export function ctagEtagDiff(
  collectionUrl: string,
  priorEtags: Record<string, string>,
  cred: DavCredential,
): Promise<CtagEtagDiffResult> {
  return runCtagEtagDiff(getDavTransportFactory()(cred), collectionUrl, priorEtags);
}

/** Fetch the collection's current getctag (the cheap change gate). */
export function fetchCtag(collectionUrl: string, cred: DavCredential): Promise<string | null> {
  return getDavTransportFactory()(cred).fetchCtag(collectionUrl);
}

export function multiget(
  kind: DavKind,
  collectionUrl: string,
  hrefs: string[],
  cred: DavCredential,
): Promise<DavObject[]> {
  return getDavTransportFactory()(cred).multiget(kind, collectionUrl, hrefs);
}

/** Cheap auth probe (PROPFIND Depth:0) — 401 ⇒ ASP revoked/wrong (ADR 0020 re-link health). */
export function davHealthProbe(
  kind: DavKind,
  cred: DavCredential,
): Promise<{ ok: boolean; status: number }> {
  return getDavTransportFactory()(cred).healthProbe(kind);
}

// ── SSRF / credential-exfil guard (security review block) ─────────────────────────────
//
// The ASP is sent as HTTP Basic (Authorization header, set by tsdav) on every DAV request. tsdav's
// discovery walk (.well-known → principal → home-set → partition host p##-{caldav,contacts}.icloud.com)
// and every collection URL it returns are SERVER-INFLUENCED, and fetch follows 30x redirects by
// default — so without a host allow-list the ASP could be redirected/discovered onto an attacker host.
// Two layers close it: (1) `assertIcloudHost` gates every collection URL a consumer touches + every URL
// discovery returns, and (2) `makeGuardedFetch` (injected into tsdav) host-checks EVERY request URL —
// including tsdav's internal discovery hops we never see — and follows redirects MANUALLY, refusing any
// 30x whose target leaves *.icloud.com with the credential never re-sent. No TLS bypass: https is
// REQUIRED (a downgrade to http:// would leak the ASP in cleartext) and rejectUnauthorized is untouched.

const ICLOUD_HOST_RE = /(^|\.)icloud\.com$/i;
const MAX_REDIRECTS = 5;

/**
 * Throw a secret-free error unless `url` is an https URL whose hostname is `icloud.com` or a subdomain
 * of it. Called before the ASP is attached to any request (and on every redirect Location). The error
 * never echoes the URL, the ASP, or the Apple ID.
 */
export function assertIcloudHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("apple: refusing to send credential to a malformed url");
  }
  if (parsed.protocol !== "https:" || !ICLOUD_HOST_RE.test(parsed.hostname)) {
    throw new Error("apple: refusing to send credential to a non-icloud host");
  }
}

/**
 * Wrap a base fetch so the ASP is NEVER sent to a non-*.icloud.com host. Each request URL is
 * host-checked (assertIcloudHost) BEFORE the network call; redirects are followed MANUALLY
 * (redirect:"manual") and each hop's Location is host-checked before the credential is re-sent, so a
 * 30x to a non-icloud host is refused with the ASP never leaving. Injected into tsdav via its `fetch`
 * override, so it covers tsdav's own discovery/partition-host hops. `base` defaults to the runtime
 * global fetch (read at call time so a late polyfill still applies).
 */
export function makeGuardedFetch(base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const realFetch = base ?? globalThis.fetch;
    let currentUrl =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    // Force manual redirect so WE decide each hop; preserve tsdav's init (headers/body/method) otherwise.
    const guardedInit: RequestInit = { ...(init ?? {}), redirect: "manual" };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertIcloudHost(currentUrl); // throws (secret-free) BEFORE the credential is sent
      const resp = await realFetch(currentUrl, guardedInit);
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (loc == null || loc === "") return resp; // a 30x without a Location — hand back as-is
        const nextUrl = new URL(loc, currentUrl).href;
        assertIcloudHost(nextUrl); // an off-icloud redirect target → throw; the ASP is NOT re-sent
        currentUrl = nextUrl;
        continue;
      }
      return resp;
    }
    throw new Error("apple: too many redirects");
  };
}

// ── The real tsdav-backed transport (the LIVE path; faked in every unit/db test) ─────
//
// Exercised only by the operator-assisted live smoke (spec acceptance) — NOT by CI, which injects a
// fake DavTransport. Kept defensive: tolerant prop extraction, secret-free errors, no logging.

const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";
const ICLOUD_CARDDAV_URL = "https://contacts.icloud.com/";

// The host-guarded fetch handed to EVERY tsdav client (connect + healthProbe): it host-checks each
// request URL (incl. tsdav's internal discovery/partition-host hops) and follows redirects manually,
// so the ASP can never be redirected/discovered onto a non-*.icloud.com host.
const guardedIcloudFetch = makeGuardedFetch();

const S = DAVNamespaceShort;
const CAL_PROPS = { [`${S.DAV}:getetag`]: {}, [`${S.CALDAV}:calendar-data`]: {} };
const CARD_PROPS = { [`${S.DAV}:getetag`]: {}, [`${S.CARDDAV}:address-data`]: {} };
// The sync-collection REPORT requests ONLY getetag: iCloud returns hrefs+etags there (never inline
// bodies), so the changed hrefs are multiget'd afterward to fetch the real bodies (see syncCollection).
const ETAG_ONLY_PROPS = { [`${S.DAV}:getetag`]: {} };

// tsdav (xml-js) CAMELCASES every response element name after stripping the namespace prefix
// (calendar-data → calendarData, address-data → addressData, sync-token → syncToken; getetag/getctag
// are unchanged) and wraps CDATA bodies as { _cdata }. So we read the CAMELCASE keys off r.props —
// NOT the on-the-wire kebab element names — and propStr unwraps the { _cdata } (was the #26 body-parse bug).
const DATA_KEY: Record<DavKind, string> = { caldav: "calendarData", carddav: "addressData" };

function serverUrlFor(kind: DavKind): string {
  return kind === "caldav" ? ICLOUD_CALDAV_URL : ICLOUD_CARDDAV_URL;
}

/**
 * Read a tsdav prop as a string. A value is either a plain string (getetag: `"\"etag\""`) or an
 * xml-js text node — calendar-data / address-data bodies arrive CDATA-wrapped as `{ _cdata: "<iCal>" }`
 * (also `{ _text }` / `{ value }` for non-CDATA text). Unwrap those to the inner string; anything else → null.
 */
function propStr(props: Record<string, unknown> | undefined, name: string): string | null {
  if (props == null) return null;
  const v = props[name];
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const key of ["_cdata", "_text", "value"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
  }
  return null;
}

/** Normalize an href for comparison (trailing content only; used to drop the collection self-href). */
function isSelfHref(href: string | undefined, collectionUrl: string): boolean {
  if (!href) return true;
  try {
    const a = new URL(href, collectionUrl).pathname.replace(/\/+$/, "");
    const b = new URL(collectionUrl, collectionUrl).pathname.replace(/\/+$/, "");
    return a === b;
  } catch {
    return href.replace(/\/+$/, "") === collectionUrl.replace(/\/+$/, "");
  }
}

function displayNameStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v != null && typeof v === "object") {
    const s = propStr(v as Record<string, unknown>, "value");
    if (s != null) return s;
  }
  return "";
}

type TsdavClient = Awaited<ReturnType<typeof createDAVClient>>;

/** Build a tsdav client + a discovered account for the kind (partition host resolved here, never persisted). */
async function connect(
  kind: DavKind,
  cred: DavCredential,
): Promise<{ client: TsdavClient; account: Awaited<ReturnType<TsdavClient["createAccount"]>> }> {
  const serverUrl = serverUrlFor(kind);
  assertIcloudHost(serverUrl); // explicit entry check (serverUrl is ours; the guard documents intent)
  let client: TsdavClient;
  try {
    client = await createDAVClient({
      serverUrl,
      credentials: { username: cred.username, password: cred.appPassword },
      authMethod: "Basic",
      defaultAccountType: kind,
      // Host-guarded fetch: the ASP never leaves *.icloud.com, redirects followed manually (SSRF guard).
      fetch: guardedIcloudFetch,
    });
  } catch {
    throw new Error("apple: DAV connect failed");
  }
  try {
    const account = await client.createAccount({
      account: { serverUrl, accountType: kind },
      loadCollections: false,
      loadObjects: false,
    });
    return { client, account };
  } catch {
    throw new Error("apple: DAV account discovery failed");
  }
}

function defaultDavTransportFactory(cred: DavCredential): DavTransport {
  return {
    async discover(kind) {
      const { client, account } = await connect(kind, cred);
      let raw: DavCollection[];
      try {
        if (kind === "caldav") {
          const cals = await client.fetchCalendars({ account });
          // Skip VTODO-only collections (spec): keep a calendar only when it advertises no component
          // set (permissive) OR its set includes VEVENT.
          raw = cals
            .filter((c) => !Array.isArray(c.components) || c.components.includes("VEVENT"))
            .map((c) => ({
              url: c.url,
              displayName: displayNameStr(c.displayName),
              ctag: c.ctag ?? null,
              syncToken: c.syncToken ?? null,
            }));
        } else {
          const books = await client.fetchAddressBooks({ account });
          raw = books.map((b) => ({
            url: b.url,
            displayName: displayNameStr(b.displayName),
            ctag: b.ctag ?? null,
            syncToken: b.syncToken ?? null,
          }));
        }
      } catch {
        throw new Error("apple: DAV collection discovery failed");
      }
      // Validate the partition host of EVERY discovered collection URL BEFORE any consumer attaches
      // the ASP to it (outside the try so the refusal surfaces its own message, not the generic mask).
      for (const c of raw) assertIcloudHost(c.url);
      return raw;
    },

    async syncCollection(collectionUrl, syncToken) {
      assertIcloudHost(collectionUrl); // never attach the ASP to a non-icloud collection URL
      const kind = kindOfUrl(collectionUrl);
      const { client } = await connect(kind, cred);
      let responses: DAVResponse[];
      try {
        responses = await client.syncCollection({
          url: collectionUrl,
          // iCloud's sync-collection returns hrefs+etags, NOT inline bodies — ask for getetag only and
          // multiget the changed hrefs below. (Requesting calendar-data here just wastes the round-trip.)
          props: ETAG_ONLY_PROPS,
          syncLevel: 1,
          syncToken: syncToken ?? undefined,
        });
      } catch {
        throw new Error("apple: sync-collection failed");
      }
      // Partition into deletions (404 / bodyless 4xx) vs changed hrefs. A DELETION is signalled by the
      // report's HTTP status (tsdav drops the props of a non-2xx propstat, so a 404 arrives props-empty)
      // — NEVER by an absent body: the report carries no bodies at all, so "no body" is not a deletion.
      const deletions: string[] = [];
      const changedHrefs: string[] = [];
      const etagByHref = new Map<string, string>();
      for (const r of responses) {
        const href = r.href;
        if (href == null || isSelfHref(href, collectionUrl)) continue;
        const status = typeof r.status === "number" ? r.status : undefined;
        const hasProps = r.props != null && Object.keys(r.props).length > 0;
        if (status === 404 || (status != null && status >= 400 && status < 500 && !hasProps)) {
          deletions.push(href);
          continue;
        }
        changedHrefs.push(href);
        const etag = propStr(r.props, "getetag");
        if (etag != null) etagByHref.set(href, etag);
      }
      // Fetch the changed bodies with a multiget (the calendar-data / address-data come back here).
      let changed: DavObject[] = [];
      if (changedHrefs.length > 0) {
        const fetched = await this.multiget(kind, collectionUrl, changedHrefs);
        changed = fetched.map((o) => ({
          href: o.href,
          etag: o.etag || etagByHref.get(o.href) || "",
          body: o.body,
        }));
      }
      const nextToken = (await this.fetchSyncToken(collectionUrl)) ?? syncToken ?? "";
      return { changed, deletions, nextToken };
    },

    // Not on the frozen DavTransport interface — an internal helper the default transport uses to
    // read the collection's current DAV:sync-token after a sync-collection report.
    async fetchSyncToken(collectionUrl: string): Promise<string | null> {
      assertIcloudHost(collectionUrl);
      const { client } = await connect(kindOfUrl(collectionUrl), cred);
      try {
        const res = await client.propfind({
          url: collectionUrl,
          props: { [`${S.DAV}:sync-token`]: {} },
          depth: "0",
        });
        // tsdav camelCases the response element: <D:sync-token> → props.syncToken (NOT "sync-token").
        return propStr(res[0]?.props, "syncToken");
      } catch {
        return null;
      }
    },

    async fetchCtag(collectionUrl) {
      assertIcloudHost(collectionUrl);
      const { client } = await connect(kindOfUrl(collectionUrl), cred);
      try {
        const res = await client.propfind({
          url: collectionUrl,
          props: { [`${S.CALENDAR_SERVER}:getctag`]: {} },
          depth: "0",
        });
        return propStr(res[0]?.props, "getctag");
      } catch {
        throw new Error("apple: ctag probe failed");
      }
    },

    async listEtags(collectionUrl) {
      assertIcloudHost(collectionUrl);
      const { client } = await connect(kindOfUrl(collectionUrl), cred);
      let res: DAVResponse[];
      try {
        res = await client.propfind({
          url: collectionUrl,
          props: { [`${S.DAV}:getetag`]: {} },
          depth: "1",
        });
      } catch {
        throw new Error("apple: etag listing failed");
      }
      const out: DavEtag[] = [];
      for (const r of res) {
        if (r.href == null || isSelfHref(r.href, collectionUrl)) continue;
        const etag = propStr(r.props, "getetag");
        if (etag != null) out.push({ href: r.href, etag });
      }
      return out;
    },

    async multiget(kind, collectionUrl, hrefs) {
      if (hrefs.length === 0) return [];
      assertIcloudHost(collectionUrl); // the multiget REPORT is issued to this URL with the ASP
      const { client } = await connect(kind, cred);
      let res: DAVResponse[];
      try {
        res =
          kind === "caldav"
            ? await client.calendarMultiGet({
                url: collectionUrl,
                props: CAL_PROPS,
                objectUrls: hrefs,
                depth: "1",
              })
            : await client.addressBookMultiGet({
                url: collectionUrl,
                props: CARD_PROPS,
                objectUrls: hrefs,
                depth: "1",
              });
      } catch {
        throw new Error("apple: multiget failed");
      }
      const dataKey = DATA_KEY[kind];
      const out: DavObject[] = [];
      for (const r of res) {
        if (r.href == null || isSelfHref(r.href, collectionUrl)) continue;
        const body = propStr(r.props, dataKey);
        if (body == null) continue;
        out.push({ href: r.href, etag: propStr(r.props, "getetag") ?? "", body });
      }
      return out;
    },

    async healthProbe(kind) {
      const serverUrl = serverUrlFor(kind);
      assertIcloudHost(serverUrl);
      try {
        const client = await createDAVClient({
          serverUrl,
          credentials: { username: cred.username, password: cred.appPassword },
          authMethod: "Basic",
          defaultAccountType: kind,
          // Host-guarded fetch (SSRF guard): the ASP never leaves *.icloud.com even under a redirect.
          fetch: guardedIcloudFetch,
        });
        const res = await client.propfind({
          url: serverUrl,
          props: { [`${S.DAV}:current-user-principal`]: {} },
          depth: "0",
        });
        const status = res[0]?.status ?? 0;
        return { ok: status > 0 && status < 400, status };
      } catch {
        // A thrown auth failure surfaces as unreachable (status 0) → caller treats as unhealthy.
        return { ok: false, status: 0 };
      }
    },
  } as DavTransport & {
    fetchSyncToken(collectionUrl: string): Promise<string | null>;
  };
}

/** Which DAV flavor a collection URL belongs to (contacts host ⇒ carddav, else caldav). */
function kindOfUrl(url: string): DavKind {
  return /contact|carddav|addressbook/i.test(url) ? "carddav" : "caldav";
}
