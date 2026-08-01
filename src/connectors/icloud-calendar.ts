// iCloud CalDAV calendar connector (read-only; provider "apple", sector "calendar"). Consumes ONE
// Apple credential (Apple ID + app-specific password) shared with icloud-contacts + icloud-mail via
// dav-core. Spec docs/specs/icloud-connector.md §Calendar, ADR 0030.
//
// SYNC (per collection, re-discovered every run — partition host never persisted):
//   1. Depth:0 getctag gate — an unchanged ctag with a stored sync-token ⇒ nothing to do (one cheap
//      PROPFIND). First run (no stored ctag) always proceeds.
//   2. RFC 6578 sync-collection with the stored sync-token (WORKS on iCloud). Changed objects carry
//      their calendar-data body; removed hrefs (404-in-report) → tombstones (ADR 0004).
//   3. Each changed .ics is parsed with ical.js and EXPANDED CLIENT-SIDE (ICAL.RecurExpansion) into
//      per-occurrence rows within a bounded window; RECURRENCE-ID overrides are reconciled to the
//      master by UID; TZID is resolved from the EMBEDDED VTIMEZONE (never a hardcoded table).
//
// DELETION MODEL: a CalDAV resource (one .ics href) holds a master VEVENT + its RECURRENCE-ID
// overrides, which we expand into MANY occurrence rows (source_object_id `${UID}` or
// `${UID}::${recurrenceId}`). The cursor persists, per collection, the map href → [soids] it last
// produced. On a 404-in-report we tombstone every soid that href held; on a changed .ics we tombstone
// the soids it USED to produce but no longer does (a shrunk RRULE / removed override / window slide).
// Deletions are yielded BEFORE upserts so a moved/recreated UID ends LIVE.
//
// SECURITY (S1): ctx.secret is the ASP and ctx.username the Apple ID — both credentials, never
// logged. Every failure throws a clean `apple: …` message (dav-core masks upstream detail).
//
// This is the STORED model for the calendar sector; see ADR 0030 for the "stable recurring event
// future-horizon" tradeoff (an unchanged recurring master is not re-expanded until it next changes).

import ICAL from "ical.js";
import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";
import {
  type DavCredential,
  type DavObject,
  type DavTransport,
  type DavTransportFactory,
  getDavTransportFactory,
} from "./dav-core.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Bounded client-side expansion window (ADR 0030). Instances whose START falls in
// [now − PAST_DAYS, now + FUTURE_DAYS] are materialized; the rest are left to a future re-expansion.
const EXPAND_PAST_DAYS = 90;
const EXPAND_FUTURE_DAYS = 400;

// Hard cap on occurrences materialized per master (a FREQ=DAILY-forever master is unbounded) — a
// safety valve; the window bound normally stops iteration long before this.
const MAX_OCCURRENCES_PER_EVENT = 2000;

// ── Normalized row (the REGISTRY `calendar` scalars minus `id`; never `raw`/`attendees`) ──
export interface CalendarEventRow {
  source_object_id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  starts_at: string | null; // ISO UTC (resolved via embedded VTIMEZONE)
  ends_at: string | null;
  start_tz: string | null; // the DTSTART TZID (IANA), as embedded
  all_day: boolean; // DTSTART VALUE=DATE
  status: string | null; // confirmed | cancelled | tentative
  organizer_email: string | null;
  owner_response: string | null; // the self-attendee PARTSTAT (matched by ctx.username), else null
  is_recurring: boolean;
  recurrence_master_id: string | null; // the UID for occurrences/overrides
  original_start: string | null; // the occurrence's scheduled start (RECURRENCE-ID)
  original_start_tz: string | null;
  html_link: string | null; // iCloud has none
  updated_at: string | null; // LAST-MODIFIED / DTSTAMP
}

/** The per-occurrence `raw` payload (attendees ride here, like google — NOT a normalize output). */
interface AppleEventInstanceRaw extends CalendarEventRow {
  uid: string;
  attendees: unknown[];
  ics: string; // the raw iCalendar text of the whole resource (spec: store the raw iCalendar in raw)
}

/** Per-connection cursor (JSON): per-collection sync-token + ctag + the href → [soids] map. */
interface CalCursor {
  collections: Record<
    string,
    { syncToken: string | null; ctag: string | null; hrefSoids: Record<string, string[]> }
  >;
}

// ── ical.js extraction helpers (module-private, pure) ────────────────────────────────

function mailAddr(v: string | null | undefined): string | null {
  if (typeof v !== "string" || v === "") return null;
  const m = v.trim().replace(/^mailto:/i, "");
  return m === "" ? null : m;
}

function timeToIso(t: ICAL.Time | null | undefined): string | null {
  if (t == null) return null;
  try {
    const d = t.toJSDate();
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** The DTSTART TZID as embedded (IANA); "floating"/"UTC" and unset resolve sensibly, never a table. */
function tzidOf(t: ICAL.Time | null | undefined): string | null {
  if (t == null) return null;
  const zone = t.zone;
  const tzid = zone && typeof zone.tzid === "string" ? zone.tzid : null;
  if (tzid == null || tzid === "floating") return null;
  return tzid;
}

function statusOf(comp: ICAL.Component): string | null {
  const s = comp.getFirstPropertyValue("status");
  return typeof s === "string" && s !== "" ? s.toLowerCase() : null;
}

function updatedAtOf(comp: ICAL.Component): string | null {
  for (const name of ["last-modified", "dtstamp"]) {
    const v = comp.getFirstPropertyValue(name);
    if (v instanceof ICAL.Time) {
      const iso = timeToIso(v);
      if (iso != null) return iso;
    }
  }
  return null;
}

function attendeesOf(comp: ICAL.Component): unknown[] {
  const out: unknown[] = [];
  for (const p of comp.getAllProperties("attendee")) {
    const val = p.getFirstValue();
    out.push({
      email: mailAddr(typeof val === "string" ? val : null),
      name: p.getParameter("cn") ?? null,
      partstat: p.getParameter("partstat") ?? null,
      role: p.getParameter("role") ?? null,
    });
  }
  return out;
}

/** The self-attendee PARTSTAT, matched by the account email (ctx.username). null when unknown. */
function ownerResponseOf(comp: ICAL.Component, selfEmail: string | null): string | null {
  if (selfEmail == null || selfEmail === "") return null;
  const self = selfEmail.toLowerCase();
  for (const p of comp.getAllProperties("attendee")) {
    const val = p.getFirstValue();
    const email = mailAddr(typeof val === "string" ? val : null);
    if (email != null && email.toLowerCase() === self) {
      const ps = p.getParameter("partstat");
      return typeof ps === "string" && ps !== "" ? ps.toLowerCase() : null;
    }
  }
  return null;
}

/** Build the per-occurrence raw payload from an ICAL.Event view of the (possibly overridden) instance. */
function buildInstanceRaw(
  soid: string,
  uid: string,
  view: ICAL.Event,
  opts: {
    startIso: string | null;
    endIso: string | null;
    startTz: string | null;
    allDay: boolean;
    isRecurring: boolean;
    recurrenceMasterId: string | null;
    originalStart: string | null;
    originalStartTz: string | null;
    selfEmail: string | null;
    ics: string;
  },
): AppleEventInstanceRaw {
  const comp = view.component;
  return {
    source_object_id: soid,
    uid,
    summary: view.summary ?? null,
    description: view.description ?? null,
    location: view.location ?? null,
    starts_at: opts.startIso,
    ends_at: opts.endIso,
    start_tz: opts.startTz,
    all_day: opts.allDay,
    status: statusOf(comp),
    organizer_email: mailAddr(view.organizer),
    owner_response: ownerResponseOf(comp, opts.selfEmail),
    is_recurring: opts.isRecurring,
    recurrence_master_id: opts.recurrenceMasterId,
    original_start: opts.originalStart,
    original_start_tz: opts.originalStartTz,
    html_link: null,
    updated_at: updatedAtOf(comp),
    attendees: attendeesOf(comp),
    ics: opts.ics,
  };
}

/**
 * Parse ONE CalDAV resource (an .ics that may hold a master VEVENT + its RECURRENCE-ID overrides) and
 * EXPAND it client-side into per-occurrence RawRecords within [windowStart, windowEnd]. Pure +
 * defensive: a malformed body yields no records (never throws). TZIDs resolve from the resource's
 * OWN embedded VTIMEZONEs. Exported for unit tests.
 */
export function expandCalendarObject(
  body: string,
  windowStart: Date,
  windowEnd: Date,
  selfEmail: string | null = null,
): { records: RawRecord[]; soids: string[] } {
  // Parse + gather subcomponents defensively: ICAL.parse tolerates junk (returns a malformed jCal),
  // so the whole structural walk is guarded — any throw yields no records.
  let vevents: ICAL.Component[];
  try {
    const comp = new ICAL.Component(ICAL.parse(body));
    // Register the resource's embedded VTIMEZONEs so toJSDate() resolves TZIDs correctly.
    for (const vt of comp.getAllSubcomponents("vtimezone")) {
      try {
        const tz = new ICAL.Timezone(vt);
        if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(vt);
      } catch {
        // ignore a malformed VTIMEZONE — floating/UTC handling still applies
      }
    }
    vevents = comp.getAllSubcomponents("vevent");
  } catch {
    return { records: [], soids: [] };
  }
  if (vevents.length === 0) return { records: [], soids: [] };

  // Group VEVENTs by UID → { master?, overrides[] }.
  const groups = new Map<string, { master?: ICAL.Component; overrides: ICAL.Component[] }>();
  for (const ve of vevents) {
    const uid = ve.getFirstPropertyValue("uid");
    if (typeof uid !== "string" || uid === "") continue;
    const g = groups.get(uid) ?? { overrides: [] };
    if (ve.hasProperty("recurrence-id")) g.overrides.push(ve);
    else g.master = ve;
    groups.set(uid, g);
  }

  const records: RawRecord[] = [];
  const soids: string[] = [];
  const push = (soid: string, raw: AppleEventInstanceRaw) => {
    records.push({ object: "calendar_event", externalId: soid, raw });
    soids.push(soid);
  };
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();

  for (const [uid, g] of groups) {
    if (g.master == null) {
      // Detached overrides delivered without a master — each in-window override is its own row.
      for (const ov of g.overrides) {
        const ovEv = new ICAL.Event(ov);
        const startIso = timeToIso(ovEv.startDate);
        const ms = startIso ? Date.parse(startIso) : NaN;
        if (!Number.isFinite(ms) || ms < winStart || ms > winEnd) continue;
        const recId = ovEv.recurrenceId;
        const soid = `${uid}::${recId ? recId.toICALString() : "override"}`;
        push(
          soid,
          buildInstanceRaw(soid, uid, ovEv, {
            startIso,
            endIso: timeToIso(ovEv.endDate),
            startTz: tzidOf(ovEv.startDate),
            allDay: ovEv.startDate?.isDate === true,
            isRecurring: true,
            recurrenceMasterId: uid,
            originalStart: timeToIso(recId),
            originalStartTz: tzidOf(recId),
            selfEmail,
            ics: body,
          }),
        );
      }
      continue;
    }

    const masterEv = new ICAL.Event(g.master);
    for (const ov of g.overrides) {
      try {
        masterEv.relateException(new ICAL.Event(ov));
      } catch {
        // a mismatched override — skip relating it (defensive)
      }
    }

    if (!masterEv.isRecurring()) {
      const startIso = timeToIso(masterEv.startDate);
      const soid = uid;
      push(
        soid,
        buildInstanceRaw(soid, uid, masterEv, {
          startIso,
          endIso: timeToIso(masterEv.endDate),
          startTz: tzidOf(masterEv.startDate),
          allDay: masterEv.startDate?.isDate === true,
          isRecurring: false,
          recurrenceMasterId: null,
          originalStart: null,
          originalStartTz: null,
          selfEmail,
          ics: body,
        }),
      );
      continue;
    }

    // Recurring master → bounded client-side expansion. Seed the iterator at windowStart when the
    // master starts long before the window, so an old daily-forever master doesn't iterate for years.
    let iterator: ICAL.RecurExpansion;
    try {
      const dtstartMs = masterEv.startDate.toJSDate().getTime();
      const seed =
        Number.isFinite(dtstartMs) && dtstartMs < winStart
          ? ICAL.Time.fromJSDate(windowStart, false)
          : undefined;
      iterator = masterEv.iterator(seed);
    } catch {
      continue;
    }
    const startTz = tzidOf(masterEv.startDate);
    let next: ICAL.Time | null;
    let n = 0;
    while ((next = iterator.next()) && n < MAX_OCCURRENCES_PER_EVENT) {
      n++;
      let details: ReturnType<ICAL.Event["getOccurrenceDetails"]>;
      try {
        details = masterEv.getOccurrenceDetails(next);
      } catch {
        continue;
      }
      const startMs = details.startDate ? details.startDate.toJSDate().getTime() : NaN;
      if (!Number.isFinite(startMs)) continue;
      if (startMs > winEnd) break; // occurrences are ascending — nothing further is in-window
      if (startMs < winStart) continue;
      const recId = details.recurrenceId;
      const soid = `${uid}::${recId ? recId.toICALString() : String(n)}`;
      push(
        soid,
        buildInstanceRaw(soid, uid, details.item, {
          startIso: timeToIso(details.startDate),
          endIso: timeToIso(details.endDate),
          startTz: tzidOf(details.startDate) ?? startTz,
          allDay: details.startDate?.isDate === true,
          isRecurring: true,
          recurrenceMasterId: uid,
          originalStart: timeToIso(recId),
          originalStartTz: tzidOf(recId) ?? startTz,
          selfEmail,
          ics: body,
        }),
      );
    }
  }

  return { records, soids };
}

// ── Cursor (de)serialization ─────────────────────────────────────────────────────────

function parseCursor(cursor: string | undefined): CalCursor {
  const empty: CalCursor = { collections: {} };
  if (!cursor) return empty;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cols = (parsed as { collections?: unknown }).collections;
      if (cols != null && typeof cols === "object" && !Array.isArray(cols)) {
        const out: CalCursor = { collections: {} };
        for (const [url, v] of Object.entries(cols as Record<string, unknown>)) {
          if (v == null || typeof v !== "object") continue;
          const o = v as Record<string, unknown>;
          out.collections[url] = {
            syncToken: typeof o.syncToken === "string" ? o.syncToken : null,
            ctag: typeof o.ctag === "string" ? o.ctag : null,
            hrefSoids:
              o.hrefSoids != null && typeof o.hrefSoids === "object" && !Array.isArray(o.hrefSoids)
                ? sanitizeHrefSoids(o.hrefSoids as Record<string, unknown>)
                : {},
          };
        }
        return out;
      }
    }
  } catch {
    // garbled cursor → fresh full sync
  }
  return empty;
}

function sanitizeHrefSoids(m: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [href, v] of Object.entries(m)) {
    if (Array.isArray(v)) out[href] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

// ── Connector ────────────────────────────────────────────────────────────────────────

export class IcloudCalendarConnector implements Connector<CalendarEventRow> {
  readonly provider = "apple";
  readonly sector = "calendar";
  readonly objectType = "calendar_event";

  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 900,
    // Floor 300s (spec D5): iCloud publishes no DAV rate limits — a conservative minutes-scale floor
    // with ctag-gating so an unchanged collection costs one cheap Depth:0 PROPFIND per poll.
    minIntervalSec: 300,
    freshnessToleranceSec: 900,
    supportsIncremental: true,
  };

  readonly actions: ActionSpec[] = [];

  private readonly factoryOverride: DavTransportFactory | null;

  constructor(factory?: DavTransportFactory) {
    this.factoryOverride = factory ?? null;
  }

  private transport(cred: DavCredential): DavTransport {
    return (this.factoryOverride ?? getDavTransportFactory())(cred);
  }

  /**
   * Per collection (re-discovered every run): ctag gate → sync-collection incremental → expand +
   * diff. Deletions are yielded BEFORE upserts (a moved/recreated UID ends live); the final cursor
   * rides the LAST yielded record.
   */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    const username = ctx.username;
    const appPassword = ctx.secret;
    if (!username || !appPassword) throw new Error("apple: missing app-specific password or Apple ID");
    const cred: DavCredential = { username, appPassword };
    const selfEmail = username;

    const transport = this.transport(cred);
    const now = Date.now();
    const windowStart = new Date(now - EXPAND_PAST_DAYS * DAY_MS);
    const windowEnd = new Date(now + EXPAND_FUTURE_DAYS * DAY_MS);

    const prior = parseCursor(ctx.cursor);
    const nextCursor: CalCursor = { collections: {} };

    const collections = await transport.discover("caldav");

    const deletions: RawRecord[] = [];
    const upserts: RawRecord[] = [];

    for (const col of collections) {
      const stored = prior.collections[col.url] ?? { syncToken: null, ctag: null, hrefSoids: {} };
      const hrefSoids: Record<string, string[]> = { ...stored.hrefSoids };

      // ctag gate: an unchanged ctag with an existing sync-token means nothing changed — carry state.
      if (stored.syncToken != null && stored.ctag != null) {
        let liveCtag: string | null = null;
        try {
          liveCtag = await transport.fetchCtag(col.url);
        } catch {
          liveCtag = null; // a failed probe: fall through and sync (never silently skip forever)
        }
        if (liveCtag != null && liveCtag === stored.ctag) {
          nextCursor.collections[col.url] = { syncToken: stored.syncToken, ctag: stored.ctag, hrefSoids };
          continue;
        }
      }

      const res = await transport.syncCollection(col.url, stored.syncToken);

      // Removed hrefs (404-in-report) → tombstone every soid that href produced.
      for (const href of res.deletions) {
        for (const soid of hrefSoids[href] ?? []) {
          deletions.push({ object: "calendar_event", deleted: true, externalId: soid, raw: null });
        }
        delete hrefSoids[href];
      }

      // Changed objects → expand + diff against the soids that href last produced.
      for (const obj of res.changed as DavObject[]) {
        const { records, soids } = expandCalendarObject(obj.body, windowStart, windowEnd, selfEmail);
        const newSet = new Set(soids);
        for (const oldSoid of hrefSoids[obj.href] ?? []) {
          if (!newSet.has(oldSoid)) {
            deletions.push({ object: "calendar_event", deleted: true, externalId: oldSoid, raw: null });
          }
        }
        for (const rec of records) upserts.push(rec);
        hrefSoids[obj.href] = soids;
      }

      // A fresh ctag (best-effort) so the next poll's gate is accurate.
      let freshCtag = col.ctag;
      try {
        freshCtag = (await transport.fetchCtag(col.url)) ?? col.ctag;
      } catch {
        freshCtag = col.ctag;
      }
      nextCursor.collections[col.url] = {
        syncToken: res.nextToken || stored.syncToken,
        ctag: freshCtag,
        hrefSoids,
      };
    }

    const cursorStr = JSON.stringify(nextCursor);
    // Deletions FIRST, then upserts; the last record carries the cursor.
    const ordered = [...deletions, ...upserts];
    for (let i = 0; i < ordered.length; i++) {
      if (i === ordered.length - 1) ordered[i].cursor = cursorStr;
      yield ordered[i];
    }
    // A zero-record run leaves the cursor untouched (idempotent re-sync next poll), mirroring gmail.
  }

  /** Map a per-occurrence raw payload → the REGISTRY `calendar` scalars (never `id`/`raw`/`attendees`). */
  normalize(rec: RawRecord): CalendarEventRow {
    const r = rec.raw as AppleEventInstanceRaw;
    return {
      source_object_id: r.source_object_id,
      summary: r.summary ?? null,
      description: r.description ?? null,
      location: r.location ?? null,
      starts_at: r.starts_at ?? null,
      ends_at: r.ends_at ?? null,
      start_tz: r.start_tz ?? null,
      all_day: r.all_day === true,
      status: r.status ?? null,
      organizer_email: r.organizer_email ?? null,
      owner_response: r.owner_response ?? null,
      is_recurring: r.is_recurring === true,
      recurrence_master_id: r.recurrence_master_id ?? null,
      original_start: r.original_start ?? null,
      original_start_tz: r.original_start_tz ?? null,
      html_link: null,
      updated_at: r.updated_at ?? null,
    };
  }

  /** Deterministic strong keys: { ical_uid: the VEVENT UID }. */
  strongKeys(rec: RawRecord): Record<string, string> {
    const r = rec.raw as AppleEventInstanceRaw | undefined;
    const uid = r?.uid;
    return uid != null && uid !== "" ? { ical_uid: String(uid) } : {};
  }

  /** Read-only (ADR 0030): CalDAV writes are a deferred follow-on. */
  async execute(): Promise<ActionResult> {
    throw new Error("IcloudCalendarConnector has no actions (calendar is read-only in V0)");
  }
}
