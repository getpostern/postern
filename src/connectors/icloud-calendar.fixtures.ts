// Fixtures for the iCloud CalDAV calendar connector: real iCalendar bodies + a fake DavTransport
// (no real iCloud in tests). The fake serves scripted per-run "rounds" so a test drives discovery →
// ctag gate → sync-collection deterministically.

import type {
  DavCollection,
  DavObject,
  DavTransport,
  DavTransportFactory,
  SyncCollectionResult,
} from "./dav-core.js";

const CRLF = "\r\n";
export function ics(lines: string[]): string {
  return lines.join(CRLF);
}

/** An embedded America/New_York VTIMEZONE (so TZID resolves from the body, not a hardcoded table). */
const VTIMEZONE_NY = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** iCal basic timestamp (YYYYMMDDTHHMMSS) in the event's local wall time. */
export function icalLocal(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(
    d.getUTCMinutes(),
  )}${p(d.getUTCSeconds())}`;
}

/** A single non-recurring timed event in America/New_York. */
export function singleEventIcs(uid: string, start: Date, summary = "Dentist"): string {
  const startL = icalLocal(start);
  const endL = icalLocal(new Date(start.getTime() + 30 * 60 * 1000));
  return ics([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Apple Inc.//iCloud//EN",
    ...VTIMEZONE_NY,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "LOCATION:Downtown",
    "DESCRIPTION:Routine cleaning",
    "STATUS:CONFIRMED",
    "ORGANIZER:mailto:me@icloud.com",
    "ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@icloud.com",
    `DTSTART;TZID=America/New_York:${startL}`,
    `DTEND;TZID=America/New_York:${endL}`,
    "LAST-MODIFIED:20260101T000000Z",
    "DTSTAMP:20260101T000000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
}

/** An all-day event (DTSTART VALUE=DATE). */
export function allDayIcs(uid: string, ymd: string, summary = "Holiday"): string {
  return ics([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Apple Inc.//iCloud//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART;VALUE=DATE:${ymd}`,
    "DTSTAMP:20260101T000000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
}

/**
 * A daily recurring event (5 occurrences) with ONE RECURRENCE-ID override (the 3rd moved +1h,
 * re-summarized). Anchored at `firstStart` (local NY wall time).
 */
export function recurringIcs(uid: string, firstStart: Date, count = 5): string {
  const startL = icalLocal(firstStart);
  const endL = icalLocal(new Date(firstStart.getTime() + 15 * 60 * 1000));
  const overrideRecId = icalLocal(new Date(firstStart.getTime() + 2 * 24 * 60 * 60 * 1000)); // day 3
  const ovStart = icalLocal(new Date(firstStart.getTime() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000));
  const ovEnd = icalLocal(new Date(firstStart.getTime() + 2 * 24 * 60 * 60 * 1000 + 75 * 60 * 1000));
  return ics([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Apple Inc.//iCloud//EN",
    ...VTIMEZONE_NY,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "SUMMARY:Standup",
    `DTSTART;TZID=America/New_York:${startL}`,
    `DTEND;TZID=America/New_York:${endL}`,
    `RRULE:FREQ=DAILY;COUNT=${count}`,
    "ORGANIZER:mailto:boss@example.com",
    "LAST-MODIFIED:20260101T000000Z",
    "DTSTAMP:20260101T000000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `RECURRENCE-ID;TZID=America/New_York:${overrideRecId}`,
    "SUMMARY:Standup (moved)",
    `DTSTART;TZID=America/New_York:${ovStart}`,
    `DTEND;TZID=America/New_York:${ovEnd}`,
    "LAST-MODIFIED:20260102T000000Z",
    "DTSTAMP:20260102T000000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
}

// ── The fake transport ────────────────────────────────────────────────────────────────

export const CAL_COLLECTION: DavCollection = {
  url: "https://p11-caldav.icloud.com/1234/calendars/home/",
  displayName: "Home",
  ctag: "ctag-0",
  syncToken: null,
};

export interface CalRound {
  changed?: DavObject[];
  deletions?: string[];
  nextToken: string;
  ctag: string;
}

/** A per-collection scripted transport. discover() advances one round; each round drives one sync(). */
export class FakeCalTransport implements DavTransport {
  private round = -1;
  constructor(
    private readonly collections: DavCollection[],
    private readonly rounds: Array<Record<string, CalRound>>,
  ) {}

  async discover(): Promise<DavCollection[]> {
    this.round++;
    return this.collections;
  }
  private cur(url: string): CalRound | undefined {
    return this.rounds[this.round]?.[url];
  }
  async fetchCtag(url: string): Promise<string | null> {
    return this.cur(url)?.ctag ?? null;
  }
  async syncCollection(url: string): Promise<SyncCollectionResult> {
    const r = this.cur(url);
    if (!r) return { changed: [], deletions: [], nextToken: "" };
    return { changed: r.changed ?? [], deletions: r.deletions ?? [], nextToken: r.nextToken };
  }
  async listEtags(): Promise<never[]> {
    return [];
  }
  async multiget(): Promise<DavObject[]> {
    return [];
  }
  async healthProbe(): Promise<{ ok: boolean; status: number }> {
    return { ok: true, status: 207 };
  }
}

export function makeFakeCalFactory(
  collections: DavCollection[],
  rounds: Array<Record<string, CalRound>>,
): { factory: DavTransportFactory; transport: FakeCalTransport } {
  const transport = new FakeCalTransport(collections, rounds);
  return { factory: () => transport, transport };
}
