// Google connector unit tests — DB-free, network mocked. Covers: declared shape (read-only, poll
// @15min, incremental); sync() branches on ctx.sector (calendar → events.list; contacts →
// connections.list); calendar full-sync paging → nextSyncToken, singleEvents=true, cancelled →
// tombstone, incremental sends ONLY syncToken (no timeMin), 410 GONE → full resync; contacts full
// (requestSyncToken) vs incremental (same personFields, syncToken), metadata.deleted → tombstone,
// 400/EXPIRED_SYNC_TOKEN → full resync, 429 backoff; both normalizers → the REGISTRY scalars;
// strongKeys; and the ADR-0002 scope discipline (no `gmail` substring in the authorization URL).

import { describe, it, expect, afterEach, vi } from "vitest";
import type { RawRecord, SyncContext } from "./types.js";
import { GoogleConnector, type CalendarEventRow, type ContactRow } from "./google.js";
import {
  CAL_EVENT_1,
  CAL_EVENT_2,
  CAL_EVENT_CANCELLED,
  CAL_PAGE_1,
  CAL_PAGE_2,
  PERSON_1,
  PERSON_2,
  PERSON_DELETED,
  PEOPLE_PAGE_1,
  PEOPLE_PAGE_2,
  EXPIRED_SYNC_TOKEN_ERROR,
  CALENDAR_SERVICE_DISABLED_ERROR,
  PEOPLE_SERVICE_DISABLED_ERROR,
  SCOPE_INSUFFICIENT_403_ERROR,
  calEventsPage,
  peopleConnectionsPage,
} from "./google.fixtures.js";

const TOKEN = "SECRET-GOOGLE-ACCESS-TOKEN-xyz789";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function collect(it: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    connectionId: "33333333-3333-3333-3333-333333333333",
    secretRef: "sec_x",
    secret: TOKEN,
    sector: "calendar",
    ...over,
  };
}

type Handler = (url: string, init?: RequestInit) => Record<string, unknown> | Response;

/** Install a fetch mock; returns the captured calls (url + init) for assertions. */
function installFetch(handler: Handler): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return calls;
}

/** Calendar full-sync router: page 1 (nextPageToken) → page 2 (nextSyncToken, incl. a tombstone). */
function calFullRouter(url: string): Record<string, unknown> {
  if (!url.includes("/calendar/v3/calendars/primary/events")) throw new Error(`unexpected url: ${url}`);
  return url.includes("pageToken=CAL_SKIP_1") ? CAL_PAGE_2 : CAL_PAGE_1;
}

/** People full-sync router: page 1 (nextPageToken) → page 2 (nextSyncToken, incl. a tombstone). */
function peopleFullRouter(url: string): Record<string, unknown> {
  if (!url.includes("/people/me/connections")) throw new Error(`unexpected url: ${url}`);
  return url.includes("pageToken=PEOPLE_SKIP_1") ? PEOPLE_PAGE_2 : PEOPLE_PAGE_1;
}

describe("GoogleConnector — declared shape", () => {
  const c = new GoogleConnector();
  it("is google, read-only, poll @15min, incremental; sector/objectType are calendar placeholders", () => {
    expect(c.provider).toBe("google");
    expect(c.sector).toBe("calendar"); // placeholder; the connector branches on ctx.sector
    expect(c.objectType).toBe("calendar_event");
    expect(c.actions).toEqual([]);
    expect(c.policy).toEqual({
      mode: "poll",
      defaultIntervalSec: 900,
      minIntervalSec: 300, // ADR 0025 — the cadence floor (per-minute API quota windows)
      freshnessToleranceSec: 900,
      supportsIncremental: true,
    });
  });
  it("execute() throws (read-only — no actions)", async () => {
    await expect(c.execute()).rejects.toThrow(/read-only/);
  });
});

describe("GoogleConnector.sync — branches on ctx.sector", () => {
  it("calendar sector → events.list path", async () => {
    const calls = installFetch(calFullRouter);
    await collect(new GoogleConnector().sync(ctx({ sector: "calendar" })));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url.includes("/calendar/v3/calendars/primary/events"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/people/me/connections"))).toBe(false);
  });

  it("contacts sector → connections.list path", async () => {
    const calls = installFetch(peopleFullRouter);
    await collect(new GoogleConnector().sync(ctx({ sector: "contacts" })));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url.includes("/people/me/connections"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/calendar/v3"))).toBe(false);
  });

  it("sends a bearer token (never the token in an error) and singleEvents on calendar calls", async () => {
    const calls = installFetch(calFullRouter);
    await collect(new GoogleConnector().sync(ctx({ sector: "calendar" })));
    for (const c of calls) {
      const headers = c.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).toContain("singleEvents=true");
    }
  });
});

describe("GoogleConnector.syncCalendar", () => {
  it("full sync: paginates to nextSyncToken, expands tombstone, cursor rides the LAST record", async () => {
    const calls = installFetch(calFullRouter);
    const recs = await collect(new GoogleConnector().sync(ctx({ sector: "calendar" })));

    // 2 live events + 1 tombstone, in stream order across the two pages.
    expect(recs.map((r) => r.externalId)).toEqual([
      CAL_EVENT_1.id,
      CAL_EVENT_2.id,
      CAL_EVENT_CANCELLED.id,
    ]);
    const tombstones = recs.filter((r) => r.deleted === true);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].externalId).toBe(CAL_EVENT_CANCELLED.id);

    // 2 fetches: page 1 (no pageToken) → page 2 (pageToken).
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("singleEvents=true");
    expect(calls[0].url).toContain("timeMin="); // full sync bounds history
    expect(calls[1].url).toContain("pageToken=CAL_SKIP_1");

    // The cursor (nextSyncToken) rides ONLY the last record.
    const last = recs[recs.length - 1];
    expect(last.cursor).toBe("CAL_SYNC_R1");
    expect(recs.slice(0, -1).every((r) => r.cursor == null)).toBe(true);
  });

  it("incremental sends ONLY the syncToken (no timeMin / orderBy)", async () => {
    const calls = installFetch(() => calEventsPage([CAL_EVENT_1], { nextSyncToken: "CAL_SYNC_R2" }));
    const recs = await collect(
      new GoogleConnector().sync(ctx({ sector: "calendar", cursor: "CAL_SYNC_PREV" })),
    );
    expect(calls).toHaveLength(1);
    const url = calls[0].url;
    expect(url).toContain("syncToken=CAL_SYNC_PREV");
    expect(url).toContain("singleEvents=true");
    expect(url).not.toContain("timeMin");
    expect(url).not.toContain("orderBy");
    expect(url).not.toContain("updatedMin");
    expect(recs[recs.length - 1].cursor).toBe("CAL_SYNC_R2");
  });

  it("410 GONE on an expired syncToken clears the cursor and does a full resync", async () => {
    const calls = installFetch((url) => {
      if (url.includes("syncToken=CAL_EXPIRED")) return new Response("gone", { status: 410 });
      return calEventsPage([CAL_EVENT_1], { nextSyncToken: "CAL_SYNC_FRESH" });
    });
    const recs = await collect(
      new GoogleConnector().sync(ctx({ sector: "calendar", cursor: "CAL_EXPIRED" })),
    );
    // First call used the (expired) syncToken; the resync used timeMin and NO syncToken.
    expect(calls[0].url).toContain("syncToken=CAL_EXPIRED");
    const resync = calls[calls.length - 1].url;
    expect(resync).toContain("timeMin=");
    expect(resync).not.toContain("syncToken");
    // The full resync's records are yielded (the 410 was not propagated).
    expect(recs.map((r) => r.externalId)).toEqual([CAL_EVENT_1.id]);
    expect(recs[recs.length - 1].cursor).toBe("CAL_SYNC_FRESH");
  });

  it("throws a secret-free error on a non-2xx (no token in the message)", async () => {
    installFetch(() => new Response("boom", { status: 500 }));
    try {
      await collect(new GoogleConnector().sync(ctx({ sector: "calendar" })));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/calendar fetch returned 500/);
      expect(msg).not.toContain(TOKEN);
    }
  });

  it("throws (no secret) when ctx.secret is missing", async () => {
    await expect(
      collect(new GoogleConnector().sync(ctx({ sector: "calendar", secret: null }))),
    ).rejects.toThrow(/missing access token/);
  });
});

describe("GoogleConnector.syncPeople", () => {
  it("full sync: requestSyncToken + personFields, paginates to nextSyncToken, tombstones the deleted", async () => {
    const calls = installFetch(peopleFullRouter);
    const recs = await collect(new GoogleConnector().sync(ctx({ sector: "contacts" })));

    expect(recs.map((r) => r.externalId)).toEqual([
      PERSON_1.resourceName,
      PERSON_2.resourceName,
      PERSON_DELETED.resourceName,
    ]);
    const tombstones = recs.filter((r) => r.deleted === true);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].externalId).toBe(PERSON_DELETED.resourceName);

    expect(calls[0].url).toContain("requestSyncToken=true");
    expect(calls[0].url).toContain(
      `personFields=${encodeURIComponent("names,emailAddresses,phoneNumbers,organizations,metadata")}`,
    );
    expect(calls[1].url).toContain("pageToken=PEOPLE_SKIP_1");
    expect(recs[recs.length - 1].cursor).toBe("PEOPLE_SYNC_R1");
  });

  it("incremental repeats the EXACT personFields and sends the syncToken (no requestSyncToken)", async () => {
    const calls = installFetch(() =>
      peopleConnectionsPage([PERSON_2], { nextSyncToken: "PEOPLE_SYNC_R2" }),
    );
    const recs = await collect(
      new GoogleConnector().sync(ctx({ sector: "contacts", cursor: "PEOPLE_SYNC_PREV" })),
    );
    expect(calls).toHaveLength(1);
    const url = calls[0].url;
    expect(url).toContain("syncToken=PEOPLE_SYNC_PREV");
    expect(url).toContain(
      `personFields=${encodeURIComponent("names,emailAddresses,phoneNumbers,organizations,metadata")}`,
    );
    expect(url).not.toContain("requestSyncToken");
    expect(recs[recs.length - 1].cursor).toBe("PEOPLE_SYNC_R2");
  });

  it("400 / EXPIRED_SYNC_TOKEN clears the cursor and does a full resync", async () => {
    const calls = installFetch((url) => {
      if (url.includes("syncToken=PEOPLE_EXPIRED")) {
        return new Response(JSON.stringify(EXPIRED_SYNC_TOKEN_ERROR), { status: 400 });
      }
      return peopleConnectionsPage([PERSON_1], { nextSyncToken: "PEOPLE_SYNC_FRESH" });
    });
    const recs = await collect(
      new GoogleConnector().sync(ctx({ sector: "contacts", cursor: "PEOPLE_EXPIRED" })),
    );
    expect(calls[0].url).toContain("syncToken=PEOPLE_EXPIRED");
    const resync = calls[calls.length - 1].url;
    expect(resync).toContain("requestSyncToken=true");
    expect(resync).not.toContain("syncToken=PEOPLE_EXPIRED");
    expect(recs.map((r) => r.externalId)).toEqual([PERSON_1.resourceName]);
    expect(recs[recs.length - 1].cursor).toBe("PEOPLE_SYNC_FRESH");
  });

  it("honors a 429 on the first full-sync page with backoff, then succeeds", async () => {
    let n = 0;
    const calls = installFetch((url) => {
      if (url.includes("/people/me/connections") && n++ === 0) {
        return new Response("", { status: 429, headers: { "Retry-After": "0" } });
      }
      return peopleConnectionsPage([PERSON_1], { nextSyncToken: "PEOPLE_SYNC_429" });
    });
    const recs = await collect(new GoogleConnector().sync(ctx({ sector: "contacts" })));
    expect(recs.map((r) => r.externalId)).toEqual([PERSON_1.resourceName]);
    expect(calls.length).toBeGreaterThan(1); // the throttled call was retried
  });

  it("a persistent 429 throws a secret-free error", async () => {
    installFetch(() => new Response("", { status: 429, headers: { "Retry-After": "0" } }));
    try {
      await collect(new GoogleConnector().sync(ctx({ sector: "contacts" })));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/rate limited \(429\)/);
      expect(msg).not.toContain(TOKEN);
    }
  });

  it("throws (no secret) when ctx.secret is missing", async () => {
    await expect(
      collect(new GoogleConnector().sync(ctx({ sector: "contacts", secret: null }))),
    ).rejects.toThrow(/missing access token/);
  });
});

describe("GoogleConnector.normalize", () => {
  const c = new GoogleConnector();

  it("maps a calendar event → the REGISTRY calendar scalars (all_day, organizer, owner_response, recurrence)", async () => {
    installFetch(calFullRouter);
    const recs = await collect(c.sync(ctx({ sector: "calendar" })));

    const r1 = c.normalize(recs.find((r) => r.externalId === CAL_EVENT_1.id)!) as CalendarEventRow;
    expect(r1).toEqual({
      source_object_id: CAL_EVENT_1.id,
      summary: "Q3 planning",
      description: "Quarterly planning sync.",
      location: "Conf Room A",
      starts_at: "2026-06-15T17:00:00.000Z", // -07:00 → UTC
      ends_at: "2026-06-15T18:00:00.000Z",
      start_tz: "America/Los_Angeles",
      all_day: false,
      status: "confirmed",
      organizer_email: "alice@contoso.example.com",
      owner_response: "accepted", // the self===true attendee
      is_recurring: false,
      recurrence_master_id: null,
      original_start: null,
      original_start_tz: null,
      html_link: "https://www.google.com/calendar/event?eid=evt-q3-planning-0001",
      updated_at: "2026-06-12T09:30:00.000Z",
    });

    // The all-day, moved, recurring instance.
    const r2 = c.normalize(recs.find((r) => r.externalId === CAL_EVENT_2.id)!) as CalendarEventRow;
    expect(r2.all_day).toBe(true);
    expect(r2.starts_at).toBe("2026-06-16");
    expect(r2.ends_at).toBe("2026-06-17");
    expect(r2.is_recurring).toBe(true);
    expect(r2.recurrence_master_id).toBe("evt-standup-series");
    expect(r2.original_start).toBe("2026-06-15");
  });

  it("maps a person → the REGISTRY contacts scalars (primary email/phone selection, updated_at from CONTACT source)", async () => {
    installFetch(peopleFullRouter);
    const recs = await collect(c.sync(ctx({ sector: "contacts" })));

    const p1 = c.normalize(recs.find((r) => r.externalId === PERSON_1.resourceName)!) as ContactRow;
    expect(p1).toEqual({
      source_object_id: PERSON_1.resourceName,
      display_name: "Carol Friend",
      given_name: "Carol",
      family_name: "Friend",
      primary_email: "carol@partner.example.org", // the metadata.primary email, NOT [0]
      primary_phone: "+14155550101", // canonicalForm (E.164)
      company: "Partner Co",
      job_title: "Designer",
      updated_at: "2026-05-01T12:00:00.000Z", // metadata.sources[CONTACT].updateTime
    });

    // PERSON_2: no primary flags → fall back to [0]; phone has no canonicalForm → value.
    const p2 = c.normalize(recs.find((r) => r.externalId === PERSON_2.resourceName)!) as ContactRow;
    expect(p2.primary_email).toBe("dave@vendor.example.net");
    expect(p2.primary_phone).toBe("(212) 555-0199");
    expect(p2.company).toBe("Vendor LLC");
    expect(p2.job_title).toBeNull();
    expect(p2.updated_at).toBe("2026-03-15T09:30:00.000Z");
  });

  it("never emits a non-REGISTRY key (no id, raw, attendees) — calendar=17 scalars, contacts=9", () => {
    const calRow = c.normalize({ object: "calendar_event", externalId: CAL_EVENT_1.id, raw: CAL_EVENT_1 });
    const calKeys = Object.keys(calRow);
    expect(calKeys).not.toContain("id");
    expect(calKeys).not.toContain("raw");
    expect(calKeys).not.toContain("attendees");
    expect(calKeys).toHaveLength(17); // the 18 REGISTRY calendar scalars minus `id`

    const contactRow = c.normalize({ object: "contact", externalId: PERSON_1.resourceName, raw: PERSON_1 });
    const contactKeys = Object.keys(contactRow);
    expect(contactKeys).not.toContain("id");
    expect(contactKeys).not.toContain("raw");
    expect(contactKeys).toHaveLength(9); // the 10 REGISTRY contacts scalars minus `id`
  });
});

describe("GoogleConnector.strongKeys", () => {
  const c = new GoogleConnector();
  it("calendar → { google_event_id, ical_uid }", () => {
    const rec: RawRecord = { object: "calendar_event", externalId: CAL_EVENT_1.id, raw: CAL_EVENT_1 };
    expect(c.strongKeys(rec)).toEqual({
      google_event_id: CAL_EVENT_1.id,
      ical_uid: "evt-q3-planning-0001@google.com",
    });
  });
  it("contacts → { resource_name, email }", () => {
    const rec: RawRecord = { object: "contact", externalId: PERSON_1.resourceName, raw: PERSON_1 };
    expect(c.strongKeys(rec)).toEqual({
      resource_name: PERSON_1.resourceName,
      email: "carol@partner.example.org",
    });
  });
});

// ── #121: a disabled-API 403 names its cause; every other 403 stays byte-identical ──────────────
//
// The dead-end this pins: with an API not enabled in the client's own Cloud project, consent
// succeeds, connectors come up active, and the FIRST fetch failed as literally "returned 403" —
// hit live twice on the G1 walkthrough (via the legacy-Contacts-API decoy). The witness pins the
// ACTUAL message content — a test that merely runs the sync green is the vacuous-guard shape.
describe("GoogleConnector — a SERVICE_DISABLED 403 names the disabled API (#121)", () => {
  const CAL_DISABLED_MSG =
    "google: calendar fetch returned 403 — the Google Calendar API is not enabled in the Google " +
    'Cloud project your OAuth client belongs to. Enable "Google Calendar API" in that project ' +
    "under APIs & Services → Library, wait a minute, then sync again or reconnect.";
  const PEOPLE_DISABLED_MSG =
    "google: people fetch returned 403 — the People API is not enabled in the Google Cloud " +
    'project your OAuth client belongs to. Enable "People API" (not the legacy Contacts API) in ' +
    "that project under APIs & Services → Library, wait a minute, then sync again or reconnect.";

  async function thrownMessage(sector: "calendar" | "contacts"): Promise<string> {
    try {
      await collect(new GoogleConnector().sync(ctx({ sector })));
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("should have thrown");
  }

  it("calendar 403 + SERVICE_DISABLED body → the exact named-cause message, secret-free, under the 500-char maskError cap", async () => {
    installFetch(() => new Response(JSON.stringify(CALENDAR_SERVICE_DISABLED_ERROR), { status: 403 }));
    const msg = await thrownMessage("calendar");
    expect(msg).toBe(CAL_DISABLED_MSG);
    expect(msg).not.toContain(TOKEN);
    // maskError truncates persisted errors at 500 chars — the remedy must survive the pipe intact.
    expect(msg.length).toBeLessThanOrEqual(500);
    // …and nothing body-derived rides along (the body is provider-controlled).
    expect(msg).not.toContain("000000000000");
    expect(msg).not.toContain("console.developers.google.com");
  });

  it("people 403 + SERVICE_DISABLED body → names the People API AND warns off the legacy Contacts API decoy", async () => {
    installFetch(() => new Response(JSON.stringify(PEOPLE_SERVICE_DISABLED_ERROR), { status: 403 }));
    const msg = await thrownMessage("contacts");
    expect(msg).toBe(PEOPLE_DISABLED_MSG);
    expect(msg).toContain("People API");
    expect(msg).toContain("not the legacy Contacts API");
    expect(msg).not.toContain(TOKEN);
    expect(msg.length).toBeLessThanOrEqual(500);
  });

  it("FALSIFIER: a 403 with a DIFFERENT details[].reason keeps today's status-only message", async () => {
    installFetch(() => new Response(JSON.stringify(SCOPE_INSUFFICIENT_403_ERROR), { status: 403 }));
    expect(await thrownMessage("calendar")).toBe("google: calendar fetch returned 403");
  });

  it("FALSIFIER: a 403 with an EMPTY body still surfaces the status-plus-provider message", async () => {
    installFetch(() => new Response("", { status: 403 }));
    expect(await thrownMessage("calendar")).toBe("google: calendar fetch returned 403");
    installFetch(() => new Response("", { status: 403 }));
    expect(await thrownMessage("contacts")).toBe("google: people fetch returned 403");
  });

  it("FALSIFIER: a 403 with a NON-JSON body still surfaces the status-only message (parse miss = fail-open)", async () => {
    installFetch(() => new Response("<html>forbidden</html>", { status: 403 }));
    expect(await thrownMessage("calendar")).toBe("google: calendar fetch returned 403");
  });

  it("a non-403 failure is untouched by the body read (the historical shape, byte-identical)", async () => {
    installFetch(() => new Response(JSON.stringify(CALENDAR_SERVICE_DISABLED_ERROR), { status: 500 }));
    expect(await thrownMessage("calendar")).toBe("google: calendar fetch returned 500");
  });

  it("PEOPLE coverage: a non-403 people status keeps the status-only message even WITH a disabled-shaped body", async () => {
    // The calendar cell above cannot vouch for this path: calendar hard-codes a null body off-403,
    // while the people path hands its ALREADY-PARSED body to the message builder on EVERY status —
    // so the 403 gate in fetchFailureMessage is the only thing standing between a 401/500 and a
    // wrong named cause. MUTATION: widen `status === 403` to `status >= 400` → both cells red.
    installFetch(() => new Response(JSON.stringify(PEOPLE_SERVICE_DISABLED_ERROR), { status: 500 }));
    expect(await thrownMessage("contacts")).toBe("google: people fetch returned 500");
    installFetch(() => new Response(JSON.stringify(PEOPLE_SERVICE_DISABLED_ERROR), { status: 401 }));
    expect(await thrownMessage("contacts")).toBe("google: people fetch returned 401");
  });
});

describe("Google OAuth scope discipline (ADR 0002)", () => {
  it("the authorization URL requests calendar + contacts read, and NEVER a gmail scope", async () => {
    const prev = process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id.apps.googleusercontent.com";
    try {
      const { startPkce } = await import("../oauth/pkce.js");
      const { authorizationUrl } = startPkce("google", "http://127.0.0.1:8787/oauth/callback");
      expect(authorizationUrl).not.toContain("gmail");
      const scope = new URL(authorizationUrl).searchParams.get("scope") ?? "";
      expect(scope).toContain("calendar.readonly");
      expect(scope).toContain("contacts.readonly");
      expect(scope).not.toContain("gmail");
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = prev;
    }
  });
});
