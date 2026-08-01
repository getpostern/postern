// Unit tests for dav-core: the pure ctag+etag diff engine and the frozen free-functions delegating
// to the injectable transport factory. No real iCloud (the transport is faked).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createDAVClient } from "tsdav";
import {
  runCtagEtagDiff,
  discoverCollections,
  syncCollection,
  ctagEtagDiff,
  multiget,
  davHealthProbe,
  fetchCtag,
  setDavTransportFactory,
  getDavTransportFactory,
  assertIcloudHost,
  makeGuardedFetch,
  type DavCredential,
  type DavCollection,
  type DavEtag,
  type DavObject,
  type DavKind,
  type DavTransport,
  type SyncCollectionResult,
} from "./dav-core.js";

// Mock ONLY tsdav's createDAVClient (keep the real DAVNamespaceShort etc.), so the "default transport
// against a faked tsdav client" suite below can drive the REAL defaultDavTransportFactory extraction.
vi.mock("tsdav", async () => {
  const actual = await vi.importActual<typeof import("tsdav")>("tsdav");
  return { ...actual, createDAVClient: vi.fn() };
});

const CRED: DavCredential = { username: "me@icloud.com", appPassword: "secret-asp" };

afterEach(() => setDavTransportFactory(null));

/** A recording fake covering the whole DavTransport surface. */
function fakeTransport(over: Partial<DavTransport> = {}): DavTransport & { calls: string[] } {
  const calls: string[] = [];
  const base: DavTransport = {
    async discover(kind) {
      calls.push(`discover:${kind}`);
      return [{ url: "u", displayName: "d", ctag: "c", syncToken: null }] as DavCollection[];
    },
    async syncCollection(url, token) {
      calls.push(`sync:${url}:${token}`);
      return { changed: [], deletions: [], nextToken: "T" } as SyncCollectionResult;
    },
    async fetchCtag(url) {
      calls.push(`ctag:${url}`);
      return "ctag-live";
    },
    async listEtags(url) {
      calls.push(`etags:${url}`);
      return [] as DavEtag[];
    },
    async multiget(kind, url, hrefs) {
      calls.push(`multiget:${kind}:${hrefs.join(",")}`);
      return [] as DavObject[];
    },
    async healthProbe(kind) {
      calls.push(`health:${kind}`);
      return { ok: true, status: 207 };
    },
  };
  return Object.assign({ calls }, base, over);
}

describe("runCtagEtagDiff", () => {
  it("classifies new / changed / removed hrefs and returns the ctag", async () => {
    const listing: DavEtag[] = [
      { href: "A", etag: "1" }, // unchanged
      { href: "B", etag: "2b" }, // changed etag
      { href: "C", etag: "3" }, // new
    ];
    const t = fakeTransport({
      async listEtags() {
        return listing;
      },
    });
    const res = await runCtagEtagDiff(t, "book", { A: "1", B: "2", D: "4" }, "known-ctag");
    expect(res.changed.sort()).toEqual(["B", "C"]);
    expect(res.removedHrefs).toEqual(["D"]); // present before, gone from the listing
    expect(res.ctag).toBe("known-ctag"); // knownCtag short-circuits the fetch
    expect(t.calls).not.toContain("ctag:book"); // fetchCtag NOT called when knownCtag given
  });

  it("fetches the ctag when none is supplied", async () => {
    const t = fakeTransport({ async listEtags() { return []; } });
    const res = await runCtagEtagDiff(t, "book", {});
    expect(res.ctag).toBe("ctag-live");
    expect(t.calls).toContain("ctag:book");
  });
});

describe("frozen free-functions delegate to the injected factory", () => {
  it("routes each call to the transport built from the credential", async () => {
    let seenCred: DavCredential | null = null;
    const t = fakeTransport();
    setDavTransportFactory((cred) => {
      seenCred = cred;
      return t;
    });

    await discoverCollections("caldav", CRED);
    await syncCollection("col", "tok", CRED);
    await ctagEtagDiff("col", { X: "1" }, CRED);
    await multiget("carddav", "col", ["h1", "h2"], CRED);
    await davHealthProbe("caldav", CRED);
    await fetchCtag("col", CRED);

    expect(seenCred).toEqual(CRED);
    expect(t.calls).toContain("discover:caldav");
    expect(t.calls).toContain("sync:col:tok");
    expect(t.calls).toContain("multiget:carddav:h1,h2");
    expect(t.calls).toContain("health:caldav");
    // ctagEtagDiff ran the diff engine (etag listing).
    expect(t.calls).toContain("etags:col");
  });

  it("setDavTransportFactory(null) restores a usable default factory", () => {
    setDavTransportFactory(((_: DavCredential) => fakeTransport()) as (c: DavCredential) => DavTransport);
    setDavTransportFactory(null);
    expect(typeof getDavTransportFactory()).toBe("function");
  });

  // touch the imported kind type so it's exercised (documents the caldav|carddav union).
  it("kind union is caldav|carddav", () => {
    const k: DavKind[] = ["caldav", "carddav"];
    expect(k).toHaveLength(2);
  });
});

// ── SSRF / credential-exfil guard (security review block) ────────────────────────────

describe("assertIcloudHost", () => {
  it("accepts icloud.com and its subdomains over https (incl. the partition host)", () => {
    for (const u of [
      "https://icloud.com/",
      "https://caldav.icloud.com/",
      "https://contacts.icloud.com/",
      "https://p52-caldav.icloud.com/123456/calendars/home/",
      "https://p99-contacts.icloud.com/999/carddavhome/card/",
    ]) {
      expect(() => assertIcloudHost(u)).not.toThrow();
    }
  });

  it("rejects non-icloud hosts, look-alikes, an http downgrade, and malformed URLs (secret-free)", () => {
    for (const u of [
      "https://evil.com/",
      "https://icloud.com.evil.com/", // suffix look-alike
      "https://myicloud.com/", // no dot boundary before icloud.com
      "https://evil.com/?redirect=https://caldav.icloud.com/", // query trick
      "http://caldav.icloud.com/", // TLS downgrade — would leak the ASP in cleartext
      "not-a-url",
    ]) {
      expect(() => assertIcloudHost(u)).toThrow(/^apple:/);
    }
  });
});

describe("makeGuardedFetch — the ASP never reaches a non-icloud host", () => {
  const AUTH = "Basic " + Buffer.from("me@icloud.com:secret-asp").toString("base64");

  /** A base fetch that records every (url, authorization) it is asked to send. */
  function recordingFetch(
    responder: (url: string) => { status: number; location?: string },
  ): typeof fetch & { calls: Array<{ url: string; auth: string | null; redirect?: string }> } {
    const calls: Array<{ url: string; auth: string | null; redirect?: string }> = [];
    const fn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization"), redirect: init?.redirect });
      const r = responder(url);
      const h = new Headers();
      if (r.location != null) h.set("location", r.location);
      return { status: r.status, headers: h } as unknown as Response;
    }) as typeof fetch;
    return Object.assign(fn, { calls });
  }

  it("refuses a DIRECT non-icloud request before any network call — the ASP is never sent", async () => {
    const base = recordingFetch(() => ({ status: 200 }));
    await expect(
      makeGuardedFetch(base)("https://evil.com/steal", { headers: { authorization: AUTH } }),
    ).rejects.toThrow(/non-icloud host/);
    expect(base.calls).toHaveLength(0); // guard fired before the fetch → the ASP never left the process
  });

  it("refuses a REDIRECT to a non-icloud host — the ASP reaches icloud once, never evil.com", async () => {
    const base = recordingFetch((url) =>
      url.startsWith("https://caldav.icloud.com")
        ? { status: 302, location: "https://evil.com/steal" }
        : { status: 200 },
    );
    await expect(
      makeGuardedFetch(base)("https://caldav.icloud.com/", { headers: { authorization: AUTH } }),
    ).rejects.toThrow(/non-icloud host/);
    expect(base.calls).toHaveLength(1); // exactly the legitimate icloud hop
    expect(base.calls[0].url).toBe("https://caldav.icloud.com/");
    expect(base.calls[0].redirect).toBe("manual"); // fetch forced not to auto-follow
    expect(base.calls.some((c) => c.url.includes("evil.com"))).toBe(false); // ASP never went to evil.com
  });

  it("follows a redirect that STAYS on *.icloud.com (the partition host), carrying the ASP", async () => {
    const base = recordingFetch((url) =>
      url === "https://caldav.icloud.com/"
        ? { status: 301, location: "https://p52-caldav.icloud.com/home/" }
        : { status: 207 },
    );
    const resp = await makeGuardedFetch(base)("https://caldav.icloud.com/", {
      headers: { authorization: AUTH },
    });
    expect(resp.status).toBe(207);
    expect(base.calls.map((c) => c.url)).toEqual([
      "https://caldav.icloud.com/",
      "https://p52-caldav.icloud.com/home/",
    ]);
    expect(base.calls.every((c) => c.auth === AUTH)).toBe(true); // both hops are icloud — carrying the ASP is correct
  });
});

// ── The DEFAULT (real) transport against a FAKED tsdav client (the #26 body-parse bug's actual home) ──
//
// Every OTHER suite fakes at the DavTransport seam, so none of them exercise defaultDavTransportFactory's
// tsdav-response → DavObject extraction — which is exactly WHY the kebab-key / bodyless-deletion bug
// shipped green. tsdav (xml-js) camelCases response element names (calendar-data → calendarData,
// address-data → addressData, sync-token → syncToken) and wraps CDATA bodies as { _cdata }. Here we mock
// createDAVClient and drive the REAL transport, proving it reads the CAMELCASE keys + unwraps { _cdata },
// that syncCollection multigets bodies (iCloud's sync report carries hrefs+etags only), and that a 404 is
// a deletion (NOT a bodyless "change").

describe("defaultDavTransportFactory — real transport, tsdav faked (the layer the bug lived in)", () => {
  const COLLECTION_CAL = "https://p11-caldav.icloud.com/1/calendars/home/";
  const COLLECTION_CARD = "https://p11-contacts.icloud.com/1/carddavhome/card/";
  const ICS_BODY =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:EVT-1\r\nSUMMARY:Hi\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const VCF_BODY = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:UID-1\r\nFN:Jane Q Public\r\nEND:VCARD";

  /** Point the mocked createDAVClient at a fake tsdav client for this test. */
  function installClient(client: Record<string, unknown>): void {
    vi.mocked(createDAVClient).mockResolvedValue(
      client as Awaited<ReturnType<typeof createDAVClient>>,
    );
  }

  beforeEach(() => {
    vi.mocked(createDAVClient).mockReset();
    setDavTransportFactory(null); // exercise the REAL default transport (the code under test)
  });

  it("multiget (caldav) unwraps the { _cdata } body under props.calendarData + reads getetag; drops the self-href", async () => {
    const hrefA = `${COLLECTION_CAL}a.ics`;
    installClient({
      createAccount: vi.fn().mockResolvedValue({}),
      calendarMultiGet: vi.fn().mockResolvedValue([
        { href: COLLECTION_CAL, status: 207, props: { getetag: '"self"' } }, // collection self-href → dropped
        { href: hrefA, status: 207, props: { getetag: '"e1"', calendarData: { _cdata: ICS_BODY } } },
      ]),
    });
    const objs = await getDavTransportFactory()(CRED).multiget("caldav", COLLECTION_CAL, [hrefA]);
    expect(objs).toEqual([{ href: hrefA, etag: '"e1"', body: ICS_BODY }]);
  });

  it("multiget (carddav) unwraps the { _cdata } body under props.addressData", async () => {
    const hrefC = `${COLLECTION_CARD}c.vcf`;
    installClient({
      createAccount: vi.fn().mockResolvedValue({}),
      addressBookMultiGet: vi.fn().mockResolvedValue([
        { href: hrefC, status: 207, props: { getetag: '"c1"', addressData: { _cdata: VCF_BODY } } },
      ]),
    });
    const objs = await getDavTransportFactory()(CRED).multiget("carddav", COLLECTION_CARD, [hrefC]);
    expect(objs).toEqual([{ href: hrefC, etag: '"c1"', body: VCF_BODY }]);
  });

  it("multiget returns [] for a body-less response (no calendarData) — extraction, not a crash", async () => {
    const hrefA = `${COLLECTION_CAL}a.ics`;
    installClient({
      createAccount: vi.fn().mockResolvedValue({}),
      calendarMultiGet: vi.fn().mockResolvedValue([{ href: hrefA, status: 207, props: { getetag: '"e1"' } }]),
    });
    const objs = await getDavTransportFactory()(CRED).multiget("caldav", COLLECTION_CAL, [hrefA]);
    expect(objs).toEqual([]);
  });

  it("syncCollection: hrefs+etags report → multigets bodies for changed; 404 → deletion; camelCase syncToken", async () => {
    const hrefA = `${COLLECTION_CAL}a.ics`;
    const hrefDel = `${COLLECTION_CAL}gone.ics`;
    const client = {
      createAccount: vi.fn().mockResolvedValue({}),
      // iCloud's sync-collection returns ONLY hrefs+etags (present=207 with getetag; removed=404, props dropped).
      syncCollection: vi.fn().mockResolvedValue([
        { href: hrefA, status: 207, props: { getetag: '"e1"' } },
        { href: hrefDel, status: 404, props: {} },
      ]),
      // the changed href is multiget'd — THIS is where the real body arrives.
      calendarMultiGet: vi
        .fn()
        .mockResolvedValue([
          { href: hrefA, status: 207, props: { getetag: '"e1"', calendarData: { _cdata: ICS_BODY } } },
        ]),
      // fetchSyncToken → props.syncToken (camelCase, was read as "sync-token" → always null before the fix).
      propfind: vi.fn().mockResolvedValue([{ status: 207, props: { syncToken: "sync-2" } }]),
    };
    installClient(client);

    const res = await getDavTransportFactory()(CRED).syncCollection(COLLECTION_CAL, "sync-1");

    // The present href (getetag only, NO inline body) is a CHANGE with its body fetched via multiget —
    // NOT misclassified as a deletion the way the old `body == null` path did.
    expect(res.changed).toEqual([{ href: hrefA, etag: '"e1"', body: ICS_BODY }]);
    expect(res.deletions).toEqual([hrefDel]); // the 404 is the only deletion
    expect(res.nextToken).toBe("sync-2");

    // The sync-collection REPORT requested getetag ONLY (bodies come from the multiget round-trip).
    expect(client.syncCollection).toHaveBeenCalledOnce();
    const props = (client.syncCollection.mock.calls[0][0] as { props: Record<string, unknown> }).props;
    const keys = Object.keys(props);
    expect(keys.some((k) => k.includes("getetag"))).toBe(true);
    expect(keys.some((k) => k.includes("calendar-data"))).toBe(false);
    // and it multiget the changed href.
    expect(client.calendarMultiGet).toHaveBeenCalledOnce();
    expect((client.calendarMultiGet.mock.calls[0][0] as { objectUrls: string[] }).objectUrls).toEqual([hrefA]);
  });

  it("syncCollection: an all-clear report (no member responses) yields nothing changed and no deletions", async () => {
    installClient({
      createAccount: vi.fn().mockResolvedValue({}),
      // sync-collection with an up-to-date token returns only the top-level token holder (no href).
      syncCollection: vi.fn().mockResolvedValue([{ status: 207, statusText: "Multi-Status", ok: true }]),
      calendarMultiGet: vi.fn().mockResolvedValue([]),
      propfind: vi.fn().mockResolvedValue([{ status: 207, props: { syncToken: "sync-3" } }]),
    });
    const res = await getDavTransportFactory()(CRED).syncCollection(COLLECTION_CAL, "sync-2");
    expect(res.changed).toEqual([]);
    expect(res.deletions).toEqual([]);
    expect(res.nextToken).toBe("sync-3");
  });
});
