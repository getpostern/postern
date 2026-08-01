// Unit tests for the iCloud CalDAV calendar connector — pure expansion + fake-transport sync. No DB,
// no network (the DavTransport is faked).

import { describe, it, expect } from "vitest";
import type { RawRecord, SyncContext } from "./types.js";
import { IcloudCalendarConnector, expandCalendarObject, type CalendarEventRow } from "./icloud-calendar.js";
import {
  CAL_COLLECTION,
  makeFakeCalFactory,
  recurringIcs,
  singleEventIcs,
  allDayIcs,
} from "./icloud-calendar.fixtures.js";
import type { DavObject } from "./dav-core.js";

const DAY = 24 * 60 * 60 * 1000;

function ctx(cursor?: string): SyncContext {
  return {
    userId: "u1",
    connectionId: "c1",
    secretRef: "ref",
    secret: "app-specific-password",
    username: "me@icloud.com",
    sector: "calendar",
    cursor,
  };
}

async function drain(it: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("expandCalendarObject", () => {
  const winStart = new Date("2026-01-01T00:00:00Z");
  const winEnd = new Date("2026-12-31T00:00:00Z");

  it("expands a single non-recurring event with a VTIMEZONE-resolved UTC start", () => {
    const body = singleEventIcs("EVT-1", new Date("2026-03-10T13:30:00Z")); // 13:30Z ~ 09:30 EDT wall
    const { records, soids } = expandCalendarObject(body, winStart, winEnd, "me@icloud.com");
    expect(soids).toEqual(["EVT-1"]);
    const raw = records[0].raw as CalendarEventRow & { attendees: unknown[]; ics: string };
    expect(records[0].externalId).toBe("EVT-1");
    expect(raw.summary).toBe("Dentist");
    expect(raw.location).toBe("Downtown");
    expect(raw.is_recurring).toBe(false);
    expect(raw.recurrence_master_id).toBeNull();
    expect(raw.start_tz).toBe("America/New_York");
    expect(raw.status).toBe("confirmed");
    expect(raw.organizer_email).toBe("me@icloud.com");
    // The self-attendee PARTSTAT surfaces as owner_response.
    expect(raw.owner_response).toBe("accepted");
    // starts_at is a real UTC instant.
    expect(raw.starts_at).toMatch(/^2026-03-10T\d\d:\d\d:00\.000Z$/);
    // attendees ride in raw (never a normalize output).
    expect(Array.isArray(raw.attendees)).toBe(true);
    expect(raw.ics).toContain("BEGIN:VEVENT");
  });

  it("expands a recurring event into occurrences and applies the RECURRENCE-ID override", () => {
    const first = new Date("2026-06-01T13:00:00Z");
    const body = recurringIcs("REC-1", first, 5);
    const { records, soids } = expandCalendarObject(body, winStart, winEnd, "me@icloud.com");
    expect(records.length).toBe(5);
    // Every occurrence carries the master UID + is_recurring.
    for (const rec of records) {
      const raw = rec.raw as CalendarEventRow & { uid: string };
      expect(raw.is_recurring).toBe(true);
      expect(raw.recurrence_master_id).toBe("REC-1");
      expect(raw.original_start).not.toBeNull();
      expect(rec.externalId.startsWith("REC-1::")).toBe(true);
    }
    // The 3rd occurrence is the override: re-summarized + shifted +1h.
    const moved = records.find((r) => (r.raw as CalendarEventRow).summary === "Standup (moved)");
    expect(moved).toBeDefined();
    // soids are distinct per occurrence.
    expect(new Set(soids).size).toBe(5);
  });

  it("marks an all-day (VALUE=DATE) event", () => {
    const body = allDayIcs("AD-1", "20260704");
    const { records } = expandCalendarObject(body, winStart, winEnd);
    expect(records.length).toBe(1);
    expect((records[0].raw as CalendarEventRow).all_day).toBe(true);
  });

  it("returns nothing for a malformed body (defensive, never throws)", () => {
    expect(expandCalendarObject("not an ical", winStart, winEnd)).toEqual({ records: [], soids: [] });
    expect(expandCalendarObject("", winStart, winEnd)).toEqual({ records: [], soids: [] });
  });

  it("drops occurrences outside the window", () => {
    const body = recurringIcs("REC-2", new Date("2026-06-01T13:00:00Z"), 5);
    const narrow = expandCalendarObject(
      body,
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-02T23:59:00Z"), // only the first 2 days
    );
    expect(narrow.records.length).toBe(2);
  });
});

describe("IcloudCalendarConnector.sync (fake transport)", () => {
  it("round 1 expands, round 2 tombstones every soid of a removed href, round 3 gate-skips", async () => {
    const href = `${CAL_COLLECTION.url}rec-1.ics`;
    const first = new Date(Date.now() + 1 * DAY); // in-window (now .. now+400d)
    const body = recurringIcs("REC-1", first, 5);
    const obj: DavObject = { href, etag: "e1", body };

    const { factory } = makeFakeCalFactory(
      [CAL_COLLECTION],
      [
        // round 0: full sync — 5 occurrences of REC-1.
        { [CAL_COLLECTION.url]: { changed: [obj], nextToken: "tok-1", ctag: "ctag-1" } },
        // round 1: the href is removed (404-in-report) → all 5 soids tombstoned.
        { [CAL_COLLECTION.url]: { deletions: [href], nextToken: "tok-2", ctag: "ctag-2" } },
        // round 2: ctag unchanged since round 1 → gate skips, nothing yielded.
        { [CAL_COLLECTION.url]: { nextToken: "tok-2", ctag: "ctag-2" } },
      ],
    );
    const conn = new IcloudCalendarConnector(factory);

    const r1 = await drain(conn.sync(ctx()));
    const upserts1 = r1.filter((r) => !r.deleted);
    expect(upserts1.length).toBe(5);
    const cursor1 = r1[r1.length - 1].cursor;
    expect(cursor1).toBeDefined();

    const r2 = await drain(conn.sync(ctx(cursor1)));
    const dels2 = r2.filter((r) => r.deleted === true);
    expect(dels2.length).toBe(5); // every occurrence soid tombstoned
    expect(dels2.every((d) => typeof d.externalId === "string" && d.externalId.startsWith("REC-1"))).toBe(true);
    const cursor2 = r2[r2.length - 1].cursor;

    const r3 = await drain(conn.sync(ctx(cursor2)));
    expect(r3.length).toBe(0); // ctag-gate skip
  });

  it("yields deletions BEFORE upserts within a run (a moved/recreated UID ends live)", async () => {
    const href = `${CAL_COLLECTION.url}shrink.ics`;
    const start = new Date(Date.now() + 1 * DAY);
    // Round 0: recurring COUNT=5. Round 1: same href now COUNT=2 → 3 occurrence soids drop.
    const body5: DavObject = { href, etag: "e1", body: recurringIcs("SH-1", start, 5) };
    const body2: DavObject = { href, etag: "e2", body: recurringIcs("SH-1", start, 2) };
    const { factory } = makeFakeCalFactory(
      [CAL_COLLECTION],
      [
        { [CAL_COLLECTION.url]: { changed: [body5], nextToken: "t1", ctag: "a" } },
        { [CAL_COLLECTION.url]: { changed: [body2], nextToken: "t2", ctag: "b" } },
      ],
    );
    const conn = new IcloudCalendarConnector(factory);
    const c1 = (await drain(conn.sync(ctx()))).slice(-1)[0].cursor;
    const r2 = await drain(conn.sync(ctx(c1)));
    const dels = r2.filter((r) => r.deleted);
    const ups = r2.filter((r) => !r.deleted);
    expect(dels.length).toBe(3); // 3 shrunk occurrences tombstoned
    expect(ups.length).toBe(2); // the 2 survivors re-upserted
    // ordering: all deletions precede all upserts.
    const firstUpsertIdx = r2.findIndex((r) => !r.deleted);
    const lastDelIdx = r2.map((r) => !!r.deleted).lastIndexOf(true);
    expect(lastDelIdx).toBeLessThan(firstUpsertIdx);
  });
});

describe("IcloudCalendarConnector.normalize / strongKeys / execute", () => {
  const conn = new IcloudCalendarConnector();

  it("normalize emits only REGISTRY calendar scalars (no attendees/ics/uid/id)", () => {
    const body = singleEventIcs("N-1", new Date("2026-05-05T15:00:00Z"));
    const { records } = expandCalendarObject(body, new Date("2026-01-01T00:00:00Z"), new Date("2027-01-01T00:00:00Z"));
    const row = conn.normalize(records[0]);
    expect(Object.keys(row).sort()).toEqual(
      [
        "all_day",
        "description",
        "ends_at",
        "html_link",
        "is_recurring",
        "location",
        "organizer_email",
        "original_start",
        "original_start_tz",
        "owner_response",
        "recurrence_master_id",
        "source_object_id",
        "start_tz",
        "starts_at",
        "status",
        "summary",
        "updated_at",
      ].sort(),
    );
    expect(row.html_link).toBeNull();
  });

  it("strongKeys returns the ical UID", () => {
    const body = singleEventIcs("SK-1", new Date("2026-05-05T15:00:00Z"));
    const { records } = expandCalendarObject(body, new Date("2026-01-01T00:00:00Z"), new Date("2027-01-01T00:00:00Z"));
    expect(conn.strongKeys(records[0])).toEqual({ ical_uid: "SK-1" });
  });

  it("execute() throws (read-only)", async () => {
    await expect(conn.execute()).rejects.toThrow(/read-only/);
  });
});
