// Google connector — read-only, TWO sectors from ONE OAuth credential (ADR 0006):
//   * calendar → Google Calendar v3 events.list on the PRIMARY calendar
//   * contacts → People API v1 people.me/connections.list
// The OAuth callback auto-creates two `connectors` rows (sector calendar + sector contacts) under
// one credential; each connection has its OWN `cursor` column. sync() branches on ctx.sector;
// normalize() branches on rec.object. Both sectors use Google's `syncToken` incremental model and
// emit ADR-0004 tombstones for removed objects (cancelled events / deleted people). Bounded sources
// → cached in full. Read-only: actions:[] and execute() throws.
//
// SECURITY: ctx.secret is the proactively-refreshed Google access token (the OAuth/refresh seam owns
// expiry — NEVER refresh inside the connector). It is a credential — NEVER logged, NEVER placed in an
// error message. Every Google failure throws a clean, status-only error. (No Gmail scope is ever
// requested — Gmail is onboarded as an IMAP app-password; ADR 0002.)

import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";

// ── API bases ────────────────────────────────────────────────────────────────────
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const PEOPLE_BASE = "https://people.googleapis.com/v1";

// People personFields are MANDATORY and must be byte-identical across the full sync AND every
// incremental follow-up (changing them invalidates the syncToken).
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,metadata";

// Full-sync history bound for calendar — caps infinite-recurrence expansion (singleEvents=true
// expands recurrences into instances). One year back (spec open question → 1 year).
const CALENDAR_BACKFILL_MS = 365 * 24 * 60 * 60 * 1000;

// 429 throttling: honor Retry-After with a small bounded retry, then throw (the runner marks
// status='error'; the next poll resumes from the persisted syncToken).
const MAX_429_RETRIES = 3;
const RETRY_AFTER_DEFAULT_MS = 1000;
const RETRY_AFTER_CAP_MS = 60_000;

// ── Google Calendar v3 event shapes (the subset we read; parsed defensively) ───────
interface GCalDateTime {
  date?: string; // all-day: "YYYY-MM-DD"
  dateTime?: string; // RFC 3339 with offset
  timeZone?: string; // IANA tz
}
interface GCalAttendee {
  email?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
  resource?: boolean;
  displayName?: string;
}
interface GCalOrganizer {
  email?: string;
  self?: boolean;
  displayName?: string;
}
interface GCalEvent {
  id: string;
  status?: string; // confirmed | tentative | cancelled
  summary?: string;
  description?: string;
  location?: string;
  start?: GCalDateTime;
  end?: GCalDateTime;
  organizer?: GCalOrganizer;
  attendees?: GCalAttendee[];
  recurringEventId?: string;
  originalStartTime?: GCalDateTime;
  htmlLink?: string;
  updated?: string;
  iCalUID?: string;
  recurrence?: string[];
  [k: string]: unknown;
}
interface GCalEventsResponse {
  items?: GCalEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

// ── Google People v1 person shapes (the subset we read; parsed defensively) ────────
interface PeopleFieldMetadata {
  primary?: boolean;
  source?: { type?: string; id?: string };
}
interface PName {
  displayName?: string;
  givenName?: string;
  familyName?: string;
  metadata?: PeopleFieldMetadata;
}
interface PEmail {
  value?: string;
  type?: string;
  metadata?: PeopleFieldMetadata;
}
interface PPhone {
  value?: string;
  canonicalForm?: string; // E.164
  type?: string;
  metadata?: PeopleFieldMetadata;
}
interface POrg {
  name?: string;
  title?: string;
  metadata?: PeopleFieldMetadata;
}
interface PSource {
  type?: string; // "CONTACT" for the contact record itself
  id?: string;
  updateTime?: string;
}
interface PPersonMetadata {
  sources?: PSource[];
  deleted?: boolean;
}
interface PPerson {
  resourceName: string; // "people/c123..."
  etag?: string;
  names?: PName[];
  emailAddresses?: PEmail[];
  phoneNumbers?: PPhone[];
  organizations?: POrg[];
  metadata?: PPersonMetadata;
  [k: string]: unknown;
}
interface PConnectionsResponse {
  connections?: PPerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalPeople?: number;
}

// ── Normalized row shapes (the REGISTRY scalars MINUS `id`; never `raw`) ────────────

/** Normalized calendar event row — ONLY the REGISTRY `calendar` scalar columns. */
export interface CalendarEventRow {
  source_object_id: string; // Google event.id
  summary: string | null;
  description: string | null;
  location: string | null;
  starts_at: string | null; // start.dateTime || start.date (UTC)
  ends_at: string | null; // end.dateTime || end.date
  start_tz: string | null; // start.timeZone (IANA)
  all_day: boolean; // start.date present
  status: string | null; // confirmed | tentative | cancelled
  organizer_email: string | null;
  owner_response: string | null; // the self===true attendee's responseStatus
  is_recurring: boolean; // recurringEventId present
  recurrence_master_id: string | null; // recurringEventId
  original_start: string | null; // originalStartTime.dateTime|date
  original_start_tz: string | null; // originalStartTime.timeZone
  html_link: string | null; // htmlLink
  updated_at: string | null; // updated (delta watermark)
}

/** Normalized contact row — ONLY the REGISTRY `contacts` scalar columns. */
export interface ContactRow {
  source_object_id: string; // resourceName
  display_name: string | null;
  given_name: string | null;
  family_name: string | null;
  primary_email: string | null;
  primary_phone: string | null; // canonicalForm (E.164) || value
  company: string | null;
  job_title: string | null;
  updated_at: string | null; // metadata.sources[CONTACT].updateTime (primaryTime)
}

// ── Helpers (module-private) ───────────────────────────────────────────────────────

/** A non-empty cursor string, else undefined (treats "" the same as absent). */
function nonEmptyCursor(cursor: string | undefined): string | undefined {
  return cursor != null && cursor !== "" ? cursor : undefined;
}

/** Retry-After (delta-seconds or HTTP-date) → bounded ms; absent/malformed → a small default. */
function retryAfterMs(header: string | null): number {
  if (header == null) return RETRY_AFTER_DEFAULT_MS;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), RETRY_AFTER_CAP_MS));
  return RETRY_AFTER_DEFAULT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET a Google API URL with the bearer token, honoring HTTP 429 with a bounded Retry-After retry.
 * Returns the final non-429 Response (callers inspect .status / .ok). A persistent 429 or a network
 * failure throws a clean, secret-free error (status/condition only — NEVER the token).
 */
async function httpGet(url: string, token: string): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch {
      throw new Error("google: request failed");
    }
    if (resp.status !== 429) return resp;
    if (attempt >= MAX_429_RETRIES) throw new Error("google: rate limited (429) after retries");
    await sleep(retryAfterMs(resp.headers.get("Retry-After")));
    attempt++;
  }
}

/** Read a Response body ONCE and JSON-parse it; empty/garbled → null. */
async function parseJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A 403 whose body carries Google's SERVICE_DISABLED ErrorInfo: the API was never enabled in the
 * client's own Cloud project. Consent still succeeds, the connectors come up active, and the FIRST
 * fetch dies here — the live-caught #121 dead-end (twice, via the legacy-Contacts-API decoy). The
 * walk mirrors isExpiredSyncToken: details[].reason first, then the documented message template.
 *
 * ⚠️ Documentation-derived: no real SERVICE_DISABLED body has ever been captured (spec
 * onboarding-clarity, 2026-07-30), so this must stay a STRICT detector — a parse miss means the
 * caller falls back to the status-only message, never a wrong cause. A different `reason` must
 * return false. A real-403 capture is an owed operator-assisted acceptance step.
 */
function isServiceDisabled(body: unknown): boolean {
  if (body == null || typeof body !== "object") return false;
  const err = (body as { error?: unknown }).error;
  if (err == null || typeof err !== "object") return false;
  const e = err as { message?: unknown; details?: unknown };
  if (Array.isArray(e.details)) {
    for (const d of e.details) {
      if (d != null && typeof d === "object" && (d as { reason?: unknown }).reason === "SERVICE_DISABLED") {
        return true;
      }
    }
  }
  if (typeof e.message === "string") {
    // Google's documented disabled-API template ("<API> has not been used in project <n> before or
    // it is disabled. Enable it by visiting …") — the fallback for a body whose details were stripped.
    if (e.message.includes("SERVICE_DISABLED")) return true;
    if (e.message.includes("has not been used in project")) return true;
  }
  return false;
}

/** Builds one API-disabled named cause. Module-private; the exported record below is the seam. */
function apiDisabledMessage(kind: "calendar" | "people"): string {
  const api = kind === "calendar" ? "Google Calendar API" : "People API";
  const decoy = kind === "people" ? " (not the legacy Contacts API)" : "";
  return (
    `google: ${kind} fetch returned 403 — the ${api} is not enabled in the Google Cloud project ` +
    `your OAuth client belongs to. Enable "${api}"${decoy} in that project under ` +
    `APIs & Services → Library, wait a minute, then sync again or reconnect.`
  );
}

/**
 * The named API-disabled causes (#121), EXPORTED as the one seam the classification and pipe
 * tests import — so drift in this text breaks those tests red instead of silently un-matching the
 * terminal vocabulary in src/sync/retryability.ts. The CONTENT is pinned as literals in
 * google.test.ts (importing there too would be a tautology).
 */
export const API_DISABLED_MESSAGE: Readonly<Record<"calendar" | "people", string>> = {
  calendar: apiDisabledMessage("calendar"),
  people: apiDisabledMessage("people"),
};

/**
 * The message a failed Google fetch throws. On a 403 whose body names SERVICE_DISABLED, the message
 * names the SPECIFIC disabled API (the connector knows which fetch failed independent of the body)
 * and the remedy; anything else keeps the historical status-only shape byte-identical (fail-open —
 * a wrong guess about the body must never make the error LESS informative than the status).
 *
 * The strings are load-bearing beyond their text: classifySyncError's provider vocabulary matches
 * them (src/sync/retryability.ts — both shapes terminal), they must survive maskError's 500-char
 * cap intact, and they are rendered verbatim by the Console's caption path. NEVER interpolate any
 * body-derived text — the body is provider-controlled and could carry anything.
 */
function fetchFailureMessage(kind: "calendar" | "people", status: number, body: unknown): string {
  if (status === 403 && isServiceDisabled(body)) return API_DISABLED_MESSAGE[kind];
  return `google: ${kind} fetch returned ${status}`;
}

/**
 * People returns an expired syncToken as HTTP 400 with an ErrorInfo whose reason is
 * EXPIRED_SYNC_TOKEN (7-day expiry). Detect it defensively from the error body.
 */
function isExpiredSyncToken(body: unknown): boolean {
  if (body == null || typeof body !== "object") return false;
  const err = (body as { error?: unknown }).error;
  if (err == null || typeof err !== "object") return false;
  const e = err as { status?: unknown; message?: unknown; details?: unknown };
  if (Array.isArray(e.details)) {
    for (const d of e.details) {
      if (d != null && typeof d === "object" && (d as { reason?: unknown }).reason === "EXPIRED_SYNC_TOKEN") {
        return true;
      }
    }
  }
  if (typeof e.status === "string" && e.status === "FAILED_PRECONDITION") return true;
  if (typeof e.message === "string" && e.message.includes("EXPIRED_SYNC_TOKEN")) return true;
  return false;
}

/** A Google date-time → ISO (UTC for dateTime; the bare date for all-day). null when absent. */
function dtToIso(dt: GCalDateTime | undefined): string | null {
  if (!dt) return null;
  if (dt.dateTime) {
    const t = Date.parse(dt.dateTime);
    return Number.isFinite(t) ? new Date(t).toISOString() : dt.dateTime;
  }
  if (dt.date) return dt.date;
  return null;
}

/** First entry flagged metadata.primary, else the first entry (Google's primary-selection rule). */
function pickPrimary<T extends { metadata?: PeopleFieldMetadata }>(arr: T[] | undefined): T | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr.find((x) => x.metadata?.primary === true) ?? arr[0];
}

/** People has no top-level updated; use the CONTACT source's updateTime (the primaryTime). */
function contactUpdateTime(p: PPerson): string | null {
  const sources = p.metadata?.sources ?? [];
  const contactSrc = sources.find((s) => s.type === "CONTACT") ?? sources[0];
  return contactSrc?.updateTime ?? null;
}

/** A Calendar event → a live RawRecord, or (status==="cancelled") an ADR-0004 tombstone. */
function toCalRecord(ev: GCalEvent): RawRecord {
  if (ev.status === "cancelled") {
    // raw is required by the contract but the runner's deletion branch ignores it (tombstone-only).
    return { object: "calendar_event", externalId: String(ev.id), deleted: true, raw: null };
  }
  return { object: "calendar_event", externalId: String(ev.id), raw: ev };
}

/** A People person → a live RawRecord, or (metadata.deleted) an ADR-0004 tombstone. */
function toPersonRecord(p: PPerson): RawRecord {
  if (p.metadata?.deleted === true) {
    return { object: "contact", externalId: String(p.resourceName), deleted: true, raw: null };
  }
  return { object: "contact", externalId: String(p.resourceName), raw: p };
}

// ── Normalizers (module-private; one per object) ───────────────────────────────────

/** Map a Google Calendar event → the REGISTRY `calendar` scalars (never `id`/`raw`/`attendees`). */
function normalizeCalendarEvent(rec: RawRecord): CalendarEventRow {
  const e = rec.raw as GCalEvent;
  const start = e.start;
  const end = e.end;
  const orig = e.originalStartTime;
  const self = (e.attendees ?? []).find((a) => a.self === true);
  return {
    source_object_id: String(e.id),
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    starts_at: dtToIso(start),
    ends_at: dtToIso(end),
    start_tz: start?.timeZone ?? null,
    all_day: start?.date != null,
    status: e.status ?? null,
    organizer_email: e.organizer?.email ?? null,
    owner_response: self?.responseStatus ?? null,
    is_recurring: e.recurringEventId != null,
    recurrence_master_id: e.recurringEventId ?? null,
    original_start: orig ? dtToIso(orig) : null,
    original_start_tz: orig?.timeZone ?? null,
    html_link: e.htmlLink ?? null,
    updated_at: e.updated ?? null,
  };
}

/** Map a Google People person → the REGISTRY `contacts` scalars (never `id`/`raw`). */
function normalizeContact(rec: RawRecord): ContactRow {
  const p = rec.raw as PPerson;
  const name = (p.names ?? [])[0];
  const email = pickPrimary(p.emailAddresses);
  const phone = pickPrimary(p.phoneNumbers);
  const org = (p.organizations ?? [])[0];
  return {
    source_object_id: String(p.resourceName),
    display_name: name?.displayName ?? null,
    given_name: name?.givenName ?? null,
    family_name: name?.familyName ?? null,
    primary_email: email?.value ?? null,
    primary_phone: phone?.canonicalForm ?? phone?.value ?? null,
    company: org?.name ?? null,
    job_title: org?.title ?? null,
    updated_at: contactUpdateTime(p),
  };
}

// ── Connector ──────────────────────────────────────────────────────────────────────

/**
 * Google calendar + contacts connector (read-only). ONE instance serves BOTH sectors; the runner
 * routes by the CONNECTION's sector (ctx.sector) + each record's `object`. The static sector /
 * objectType below are placeholders for the multi-sector model (ADR 0006).
 */
export class GoogleConnector implements Connector<CalendarEventRow | ContactRow> {
  readonly provider = "google";
  readonly sector = "calendar"; // placeholder; the connector branches on ctx.sector (ADR 0006)
  readonly objectType = "calendar_event"; // fallback; each RawRecord sets its own `object`

  // Poll source; 15 min cadence. Both sectors support Google's syncToken incremental model.
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 900,
    // Floor 300s: Calendar/People quotas are per-minute sliding windows per user/project (default
    // 1M queries/day — developers.google.com/workspace/calendar/api/guides/quota) — one syncToken
    // incremental pull per 5 min never approaches a per-minute window.
    minIntervalSec: 300,
    freshnessToleranceSec: 900,
    supportsIncremental: true,
  };

  // Read-only: no write scopes, no actions on the source side.
  readonly actions: ActionSpec[] = [];

  /** Branch on the CONNECTION's sector: contacts → People; everything else → Calendar (primary). */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    if (ctx.sector === "contacts") {
      yield* this.syncPeople(ctx);
      return;
    }
    yield* this.syncCalendar(ctx);
  }

  /**
   * Drain the PRIMARY calendar's events. ctx.secret = access token; ctx.cursor = the prior
   * syncToken (per-connection). Incremental: send ONLY syncToken (+singleEvents) — timeMin/orderBy/q/
   * updatedMin are FORBIDDEN with a syncToken (400). Full: singleEvents=true + timeMin=now−1y. Both
   * paginate to the final page's nextSyncToken; cancelled events → tombstones. A 410 GONE on an
   * expired syncToken clears the cursor and downgrades to a full resync (never propagated).
   */
  private async *syncCalendar(ctx: SyncContext): AsyncIterable<RawRecord> {
    const token = ctx.secret;
    if (!token) throw new Error("google: missing access token");

    const syncToken = nonEmptyCursor(ctx.cursor);
    // singleEvents expands recurrences into instances (the REGISTRY stores instances, not masters).
    let params: Record<string, string> = syncToken
      ? { singleEvents: "true", syncToken }
      : { singleEvents: "true", timeMin: new Date(Date.now() - CALENDAR_BACKFILL_MS).toISOString() };
    let canDowngrade = syncToken != null;

    let pageToken: string | undefined;
    let pending: RawRecord | null = null; // one-record look-behind so the cursor rides the LAST record
    let nextSyncToken: string | undefined;

    for (;;) {
      const p = { ...params };
      if (pageToken) p.pageToken = pageToken;
      const url = `${CALENDAR_BASE}/calendars/primary/events?${new URLSearchParams(p).toString()}`;
      const resp = await httpGet(url, token);

      if (resp.status === 410 && canDowngrade) {
        // Expired syncToken → full resync from scratch (don't propagate the 410).
        params = {
          singleEvents: "true",
          timeMin: new Date(Date.now() - CALENDAR_BACKFILL_MS).toISOString(),
        };
        canDowngrade = false;
        pageToken = undefined;
        continue;
      }
      if (!resp.ok) {
        // The calendar path used to DISCARD the response body unread (#121) — a disabled-API 403
        // surfaced as literally "returned 403". Read it ONLY for the 403 cause-check, defensively:
        // a body that cannot be read/parsed degrades to the status-only message, never a throw of
        // its own.
        const errBody = resp.status === 403 ? await parseJson(resp).catch(() => null) : null;
        throw new Error(fetchFailureMessage("calendar", resp.status, errBody));
      }

      const page = (await parseJson(resp)) as GCalEventsResponse | null;
      for (const ev of page?.items ?? []) {
        const rec = toCalRecord(ev);
        if (pending) yield pending;
        pending = rec;
      }
      if (page?.nextSyncToken) nextSyncToken = page.nextSyncToken;
      canDowngrade = false;
      if (page?.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      break;
    }

    if (pending) {
      if (nextSyncToken) pending.cursor = nextSyncToken;
      yield pending;
    }
    // Empty incremental run → nothing yielded; the fresh nextSyncToken is dropped and the prior token
    // is reused next run (Google re-accepts it; the 410 handler covers expiry). No cursor-only sentinel.
  }

  /**
   * Drain people/me/connections. ctx.secret = access token; ctx.cursor = the prior syncToken
   * (per-connection). personFields are sent on EVERY request and are byte-identical across full +
   * incremental (changing them invalidates the token; sortOrder is incompatible with syncToken).
   * Full: requestSyncToken=true. Incremental: syncToken. Both paginate to nextSyncToken; deleted
   * people → tombstones. An expired token (HTTP 400 / EXPIRED_SYNC_TOKEN) downgrades to a full resync.
   * 429s are retried with backoff (httpGet).
   */
  private async *syncPeople(ctx: SyncContext): AsyncIterable<RawRecord> {
    const token = ctx.secret;
    if (!token) throw new Error("google: missing access token");

    const syncToken = nonEmptyCursor(ctx.cursor);
    let params: Record<string, string> = syncToken
      ? { personFields: PERSON_FIELDS, syncToken }
      : { personFields: PERSON_FIELDS, requestSyncToken: "true" };
    let canDowngrade = syncToken != null;

    let pageToken: string | undefined;
    let pending: RawRecord | null = null;
    let nextSyncToken: string | undefined;

    for (;;) {
      const p = { ...params };
      if (pageToken) p.pageToken = pageToken;
      const url = `${PEOPLE_BASE}/people/me/connections?${new URLSearchParams(p).toString()}`;
      const resp = await httpGet(url, token);
      const body = await parseJson(resp);

      if (resp.status === 400 && canDowngrade && isExpiredSyncToken(body)) {
        // Expired syncToken → full resync from scratch.
        params = { personFields: PERSON_FIELDS, requestSyncToken: "true" };
        canDowngrade = false;
        pageToken = undefined;
        continue;
      }
      if (!resp.ok) throw new Error(fetchFailureMessage("people", resp.status, body));

      const page = body as PConnectionsResponse | null;
      for (const person of page?.connections ?? []) {
        const rec = toPersonRecord(person);
        if (pending) yield pending;
        pending = rec;
      }
      if (page?.nextSyncToken) nextSyncToken = page.nextSyncToken;
      canDowngrade = false;
      if (page?.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      break;
    }

    if (pending) {
      if (nextSyncToken) pending.cursor = nextSyncToken;
      yield pending;
    }
  }

  /** Branch on rec.object: contact → ContactRow; everything else → CalendarEventRow. */
  normalize(rec: RawRecord): CalendarEventRow | ContactRow {
    return rec.object === "contact" ? normalizeContact(rec) : normalizeCalendarEvent(rec);
  }

  /** Deterministic strong keys: calendar → {google_event_id, ical_uid}; contacts → {resource_name, email}. */
  strongKeys(rec: RawRecord): Record<string, string> {
    if (rec.object === "contact") {
      const p = rec.raw as PPerson | null;
      const keys: Record<string, string> = {
        resource_name: String(p?.resourceName ?? rec.externalId),
      };
      const email = pickPrimary(p?.emailAddresses)?.value;
      if (email) keys.email = email;
      return keys;
    }
    const e = rec.raw as GCalEvent | null;
    const keys: Record<string, string> = { google_event_id: String(e?.id ?? rec.externalId) };
    if (e?.iCalUID) keys.ical_uid = e.iCalUID;
    return keys;
  }

  /** Read-only: no actions on the source side. */
  async execute(): Promise<ActionResult> {
    throw new Error("GoogleConnector has no actions (calendar + contacts are read-only)");
  }
}
