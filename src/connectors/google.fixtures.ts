// Google Calendar v3 + People v1 fixtures — production string forms of the event / person resources
// and the paginated list responses, for the network-free unit tests and the DB round-trip.
//
// Calendar events carry start/end (dateTime+timeZone OR all-day date), organizer, attendees
// (with a self===true entry → owner_response), recurringEventId + originalStartTime (a moved
// recurring instance), htmlLink, iCalUID, and `updated`. A cancelled event is the tombstone form
// ({ id, status:"cancelled" }). People persons carry names, emailAddresses (one flagged primary),
// phoneNumbers (canonicalForm E.164), organizations, and metadata.sources[CONTACT].updateTime; a
// deleted person is { resourceName, metadata:{deleted:true} }. Pages carry `nextPageToken` for more
// pages or `nextSyncToken` on the final page (the next cursor).

// ── Calendar events (live) ─────────────────────────────────────────────────────────

/** A timed event: attendees incl. the owner (self) who ACCEPTED; organizer; iCalUID + updated. */
export const CAL_EVENT_1 = {
  kind: "calendar#event",
  id: "evt-q3-planning-0001",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=evt-q3-planning-0001",
  summary: "Q3 planning",
  description: "Quarterly planning sync.",
  location: "Conf Room A",
  updated: "2026-06-12T09:30:00.000Z",
  iCalUID: "evt-q3-planning-0001@google.com",
  organizer: { email: "alice@contoso.example.com", displayName: "Alice Organizer" },
  start: { dateTime: "2026-06-15T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-06-15T11:00:00-07:00", timeZone: "America/Los_Angeles" },
  attendees: [
    { email: "alice@contoso.example.com", organizer: true, responseStatus: "accepted" },
    { email: "operator@contoso.example.com", self: true, responseStatus: "accepted" },
    { email: "bob@contoso.example.com", responseStatus: "needsAction" },
  ],
  sequence: 0,
} as const;

/** An ALL-DAY, RECURRING instance that was MOVED (originalStartTime present). */
export const CAL_EVENT_2 = {
  kind: "calendar#event",
  id: "evt-standup-20260616",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=evt-standup-20260616",
  summary: "Team offsite (all-day)",
  updated: "2026-06-10T08:00:00.000Z",
  iCalUID: "evt-standup-series@google.com",
  organizer: { email: "operator@contoso.example.com", self: true },
  start: { date: "2026-06-16" },
  end: { date: "2026-06-17" },
  recurringEventId: "evt-standup-series",
  originalStartTime: { date: "2026-06-15" },
  attendees: [
    { email: "operator@contoso.example.com", self: true, organizer: true, responseStatus: "accepted" },
  ],
} as const;

/** A cancelled event → tombstone form (incremental delta). */
export const CAL_EVENT_CANCELLED = {
  kind: "calendar#event",
  id: "evt-cancelled-0003",
  status: "cancelled",
} as const;

/** The cancelled form of CAL_EVENT_1 (used by the DB round-trip's tombstone round). */
export const CAL_EVENT_1_CANCELLED = {
  kind: "calendar#event",
  id: CAL_EVENT_1.id,
  status: "cancelled",
} as const;

// ── People persons (live) ───────────────────────────────────────────────────────────

/** Full contact: a non-primary + a PRIMARY email (selection must pick the primary), E.164 phone,
 * an organization, and metadata.sources[CONTACT].updateTime (the primaryTime). */
export const PERSON_1 = {
  resourceName: "people/c1000000000000000001",
  etag: "%EgcBAj0DBgcuGgQBAgUHIgxabc=",
  metadata: {
    sources: [
      { type: "CONTACT", id: "1000000000000000001", updateTime: "2026-05-01T12:00:00.000Z" },
      { type: "PROFILE", id: "p-xyz", updateTime: "2026-04-01T00:00:00.000Z" },
    ],
    objectType: "PERSON",
  },
  names: [
    {
      displayName: "Carol Friend",
      givenName: "Carol",
      familyName: "Friend",
      metadata: { primary: true, source: { type: "CONTACT", id: "1000000000000000001" } },
    },
  ],
  emailAddresses: [
    { value: "carol.work@partner.example.org", type: "work" },
    { value: "carol@partner.example.org", type: "home", metadata: { primary: true } },
  ],
  phoneNumbers: [
    { value: "+1 415-555-0101", canonicalForm: "+14155550101", type: "mobile", metadata: { primary: true } },
  ],
  organizations: [{ name: "Partner Co", title: "Designer", metadata: { primary: true } }],
} as const;

/** A leaner contact: no primary flags → selection falls back to [0]; phone has no canonicalForm. */
export const PERSON_2 = {
  resourceName: "people/c2000000000000000002",
  etag: "%EgcBAj0DBgcuGgQBAgUHIgxdef=",
  metadata: {
    sources: [{ type: "CONTACT", id: "2000000000000000002", updateTime: "2026-03-15T09:30:00.000Z" }],
    objectType: "PERSON",
  },
  names: [{ displayName: "Dave Vendor", givenName: "Dave", familyName: "Vendor" }],
  emailAddresses: [{ value: "dave@vendor.example.net" }],
  phoneNumbers: [{ value: "(212) 555-0199" }],
  organizations: [{ name: "Vendor LLC" }],
} as const;

/** A deleted person → tombstone form (incremental delta). */
export const PERSON_DELETED = {
  resourceName: "people/c3000000000000000003",
  metadata: { deleted: true, sources: [{ type: "CONTACT", id: "3000000000000000003" }] },
} as const;

/** The deleted form of PERSON_1 (used by the DB round-trip's tombstone round). */
export const PERSON_1_DELETED = {
  resourceName: PERSON_1.resourceName,
  metadata: { deleted: true, sources: [{ type: "CONTACT", id: "1000000000000000001" }] },
} as const;

// ── Error bodies ─────────────────────────────────────────────────────────────────────

/** People expired-syncToken error (HTTP 400, ErrorInfo reason = EXPIRED_SYNC_TOKEN). */
export const EXPIRED_SYNC_TOKEN_ERROR = {
  error: {
    code: 400,
    message: "Sync token is expired. Clear local cache and retry call without the sync token.",
    status: "INVALID_ARGUMENT",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "EXPIRED_SYNC_TOKEN",
        domain: "googleapis.com",
      },
    ],
  },
} as const;

/**
 * A 403 SERVICE_DISABLED error body — the API-never-enabled dead-end (#121).
 *
 * ⚠️ DOCUMENTATION-DERIVED, not a live capture: no real SERVICE_DISABLED body has ever been
 * observed on this project (verified 2026-07-30 — the walkthrough logs hold only the summarized
 * string). Shape per Google's error-model docs (`google.rpc.ErrorInfo` inside `error.details`,
 * `error.status = "PERMISSION_DENIED"`, the "has not been used in project … or it is disabled"
 * message template). The operator-assisted live-verify step (disable the People API once in the
 * throwaway GCP project) is owed to confirm — paste the raw body here if it differs.
 */
export function serviceDisabledError(api: string, service: string): Record<string, unknown> {
  return {
    error: {
      code: 403,
      message:
        `${api} has not been used in project 000000000000 before or it is disabled. Enable it by ` +
        `visiting https://console.developers.google.com/apis/api/${service}/overview?project=000000000000 ` +
        `then retry. If you enabled this API recently, wait a few minutes for the action to propagate ` +
        `to our systems and retry.`,
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          domain: "googleapis.com",
          metadata: { service, consumer: "projects/000000000000" },
        },
      ],
    },
  };
}

export const CALENDAR_SERVICE_DISABLED_ERROR = serviceDisabledError(
  "Google Calendar API",
  "calendar-json.googleapis.com",
);
export const PEOPLE_SERVICE_DISABLED_ERROR = serviceDisabledError(
  "People API",
  "people.googleapis.com",
);

/** A 403 with a DIFFERENT ErrorInfo reason — the falsifier: must NOT read as API-disabled. */
export const SCOPE_INSUFFICIENT_403_ERROR = {
  error: {
    code: 403,
    message: "Request had insufficient authentication scopes.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        domain: "googleapis.com",
        metadata: { service: "calendar-json.googleapis.com", method: "calendar.v3.Events.List" },
      },
    ],
  },
} as const;

// ── Page builders ──────────────────────────────────────────────────────────────────

/** A Calendar events.list page: `items` + (nextPageToken | nextSyncToken). */
export function calEventsPage(
  items: ReadonlyArray<unknown>,
  opts: { nextPageToken?: string; nextSyncToken?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: "calendar#events", items: [...items] };
  if (opts.nextPageToken) out.nextPageToken = opts.nextPageToken;
  if (opts.nextSyncToken) out.nextSyncToken = opts.nextSyncToken;
  return out;
}

/** A People connections.list page: `connections` + (nextPageToken | nextSyncToken). */
export function peopleConnectionsPage(
  connections: ReadonlyArray<unknown>,
  opts: { nextPageToken?: string; nextSyncToken?: string; totalPeople?: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = { connections: [...connections] };
  if (opts.nextPageToken) out.nextPageToken = opts.nextPageToken;
  if (opts.nextSyncToken) out.nextSyncToken = opts.nextSyncToken;
  if (opts.totalPeople != null) out.totalPeople = opts.totalPeople;
  return out;
}

// ── Concrete two-page fixtures (full-sync paging → nextSyncToken) ──────────────────

// Calendar full sync: page 1 (nextPageToken) → page 2 (nextSyncToken). Page 2 carries a tombstone.
export const CAL_PAGE_1 = calEventsPage([CAL_EVENT_1], { nextPageToken: "CAL_SKIP_1" });
export const CAL_PAGE_2 = calEventsPage([CAL_EVENT_2, CAL_EVENT_CANCELLED], {
  nextSyncToken: "CAL_SYNC_R1",
});

// People full sync: page 1 (nextPageToken) → page 2 (nextSyncToken). Page 2 carries a tombstone.
export const PEOPLE_PAGE_1 = peopleConnectionsPage([PERSON_1], { nextPageToken: "PEOPLE_SKIP_1" });
export const PEOPLE_PAGE_2 = peopleConnectionsPage([PERSON_2, PERSON_DELETED], {
  nextSyncToken: "PEOPLE_SYNC_R1",
});
