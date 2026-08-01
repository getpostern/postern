// Microsoft Graph v1.0 mail fixtures — production string forms of the message resource and the
// per-folder message-delta pages, for the network-free unit tests and the DB round-trip.
//
// Shapes mirror real Graph responses: messages carry from/sender (emailAddress.{name,address}),
// conversationId, internetMessageId, bodyPreview (NOT body), receivedDateTime/sentDateTime as ISO
// 8601 UTC, isRead/hasAttachments booleans, importance, and categories. Delta pages carry `value`
// plus `@odata.nextLink` ($skiptoken) for more pages or `@odata.deltaLink` ($deltatoken) on the
// final page. A tombstone entry is `{ id, "@removed": { reason } }`. The by-id body resource adds
// `body:{contentType,content}` — fetched on demand, never stored.

const GRAPH = "https://graph.microsoft.com/v1.0";

// ── Inbox messages (envelope only — no `body`) ───────────────────────────────────

/** Unread, high-importance, with an attachment. Full from/sender split + internetMessageId. */
export const MSG_INBOX_1 = {
  id: "AAMkAGI2-Inbox-Immutable-0001",
  internetMessageId: "<CY4PR01MB-inbox-0001@contoso.example.com>",
  conversationId: "AAQkAGI2Conv0001",
  subject: "Q3 planning agenda",
  bodyPreview: "Here is the proposed agenda for the Q3 planning session next week.",
  from: { emailAddress: { name: "Alice Sender", address: "alice@contoso.example.com" } },
  sender: { emailAddress: { name: "Alice Sender", address: "alice@contoso.example.com" } },
  toRecipients: [{ emailAddress: { name: "Operator", address: "operator@contoso.example.com" } }],
  ccRecipients: [{ emailAddress: { name: "Bob Watcher", address: "bob@contoso.example.com" } }],
  receivedDateTime: "2026-06-12T09:30:00Z",
  sentDateTime: "2026-06-12T09:29:55Z",
  isRead: false,
  hasAttachments: true,
  importance: "high",
  isDraft: false,
  categories: ["Work", "Planning"],
} as const;

/** Read, normal importance, no attachment. Distinct sender (delegate) from `from`. */
export const MSG_INBOX_2 = {
  id: "AAMkAGI2-Inbox-Immutable-0002",
  internetMessageId: "<CY4PR01MB-inbox-0002@contoso.example.com>",
  conversationId: "AAQkAGI2Conv0002",
  subject: "Lunch?",
  bodyPreview: "Want to grab lunch on Friday?",
  from: { emailAddress: { name: "Carol Friend", address: "carol@partner.example.org" } },
  sender: { emailAddress: { name: "Assistant On Behalf", address: "assistant@partner.example.org" } },
  toRecipients: [{ emailAddress: { name: "Operator", address: "operator@contoso.example.com" } }],
  ccRecipients: [],
  receivedDateTime: "2026-06-11T15:05:00Z",
  sentDateTime: "2026-06-11T15:04:30Z",
  isRead: true,
  hasAttachments: false,
  importance: "normal",
  isDraft: false,
  categories: [],
} as const;

/** Lands on the second delta page (proves multi-page paging). */
export const MSG_INBOX_3 = {
  id: "AAMkAGI2-Inbox-Immutable-0003",
  internetMessageId: "<CY4PR01MB-inbox-0003@contoso.example.com>",
  conversationId: "AAQkAGI2Conv0003",
  subject: "Invoice March",
  bodyPreview: "Please find March invoice details below.",
  from: { emailAddress: { name: "Billing", address: "billing@vendor.example.net" } },
  sender: { emailAddress: { name: "Billing", address: "billing@vendor.example.net" } },
  toRecipients: [{ emailAddress: { name: "Operator", address: "operator@contoso.example.com" } }],
  ccRecipients: [],
  receivedDateTime: "2026-06-10T08:00:00Z",
  sentDateTime: "2026-06-10T07:59:00Z",
  isRead: false,
  hasAttachments: true,
  importance: "normal",
  isDraft: false,
  categories: [],
} as const;

// ── Sent message (envelope only) ─────────────────────────────────────────────────

/** A message in the Sent Items folder — folder enum must resolve to `sent`. */
export const MSG_SENT_1 = {
  id: "AAMkAGI2-Sent-Immutable-0001",
  internetMessageId: "<CY4PR01MB-sent-0001@outlook.com>",
  conversationId: "AAQkAGI2Conv0002",
  subject: "RE: Lunch?",
  bodyPreview: "Friday works for me, see you at noon.",
  from: { emailAddress: { name: "Operator", address: "operator@contoso.example.com" } },
  sender: { emailAddress: { name: "Operator", address: "operator@contoso.example.com" } },
  toRecipients: [{ emailAddress: { name: "Carol Friend", address: "carol@partner.example.org" } }],
  ccRecipients: [],
  receivedDateTime: "2026-06-11T15:20:00Z",
  sentDateTime: "2026-06-11T15:20:00Z",
  isRead: true,
  hasAttachments: false,
  importance: "normal",
  isDraft: false,
  categories: [],
} as const;

// ── Tombstone entry ──────────────────────────────────────────────────────────────

/** A Graph `@removed` delta entry for MSG_INBOX_1 (deletion / move out of the folder). */
export const REMOVED_INBOX_1 = {
  id: MSG_INBOX_1.id,
  "@removed": { reason: "deleted" },
} as const;

// ── Delta UPDATE partials (#138) ─────────────────────────────────────────────────
//
// ⚠️ DOCUMENTATION-DERIVED, NOT A LIVE CAPTURE (the `google.fixtures.ts` precedent). No live Graph
// traffic was available to the implementer. The shape is taken from Microsoft's own contract for an
// updated item — learn.microsoft.com/en-us/graph/delta-query-overview, "Resource representation in
// the delta query response": *"Updated instances are represented by their **id** with at least the
// updated properties, but other properties might be included."* — plus the `@odata.type`/`@odata.etag`
// annotations every message entry in the delta samples carries. A read-status flip is therefore
// `{ @odata.type, @odata.etag, id, isRead }`, which is exactly the row shape observed live in #138
// (191 hollow rows: microsoft, folder inbox, is_read true, every content column null).
//
// If a live capture ever shows a DIFFERENT partial shape, update THESE FIXTURES (and, if it shows
// Graph omitting one of ENVELOPE_REQUIRED_KEYS on a COMPLETE message, that list) — never the
// connector's fail-closed guard.

/** A read-status flip reported for a message this store already holds in full. */
export const MSG_INBOX_1_READ_FLIP_PARTIAL = {
  "@odata.type": "#microsoft.graph.message",
  "@odata.etag": 'W/"CQAAABYAAAARn2vdzPFjSbaPPxzjlzOTAAASsKZz"',
  id: MSG_INBOX_1.id,
  isRead: true,
} as const;

/** The by-id envelope re-read that answers the flip above: the full envelope, now read. */
export const MSG_INBOX_1_READ = { ...MSG_INBOX_1, isRead: true } as const;

/** A read-status flip for a message the store has NEVER seen (no full row to fall back on). */
export const MSG_UNSEEN_READ_FLIP_PARTIAL = {
  "@odata.type": "#microsoft.graph.message",
  "@odata.etag": 'W/"CQAAABYAAAARn2vdzPFjSbaPPxzjlzOTAAAEfYB9"',
  id: "AAMkAGI2-Inbox-Immutable-0009",
  isRead: true,
} as const;

/** The by-id envelope re-read that answers the unseen flip: a complete, previously-uncached message. */
export const MSG_UNSEEN_FULL = {
  id: MSG_UNSEEN_READ_FLIP_PARTIAL.id,
  internetMessageId: "<CY4PR01MB-inbox-0009@contoso.example.com>",
  conversationId: "AAQkAGI2Conv0009",
  subject: "Renewal notice",
  bodyPreview: "Your subscription renews on the 1st.",
  from: { emailAddress: { name: "Renewals", address: "renewals@vendor.example.net" } },
  sender: { emailAddress: { name: "Renewals", address: "renewals@vendor.example.net" } },
  toRecipients: [{ emailAddress: { name: "Operator", address: "operator@contoso.example.com" } }],
  ccRecipients: [],
  receivedDateTime: "2026-06-09T11:22:00Z",
  sentDateTime: "2026-06-09T11:21:40Z",
  isRead: true,
  hasAttachments: false,
  importance: "normal",
  isDraft: false,
  categories: [],
} as const;

// ── By-id body resource (fetchRecordLive) — includes `body`, never stored ─────────
export const MESSAGE_BODY_RESOURCE = {
  id: MSG_INBOX_1.id,
  subject: MSG_INBOX_1.subject,
  from: MSG_INBOX_1.from,
  toRecipients: MSG_INBOX_1.toRecipients,
  ccRecipients: MSG_INBOX_1.ccRecipients,
  receivedDateTime: MSG_INBOX_1.receivedDateTime,
  hasAttachments: MSG_INBOX_1.hasAttachments,
  body: {
    contentType: "html",
    content:
      "<html><body><p>Here is the proposed agenda for the Q3 planning session next week.</p></body></html>",
  },
} as const;

// ── Delta-page builders + concrete fixtures ───────────────────────────────────────

/** A non-final delta page: `value` + an `@odata.nextLink` carrying a $skiptoken. */
export function deltaPageWithNext(
  folder: string,
  value: ReadonlyArray<unknown>,
  skiptoken: string,
): Record<string, unknown> {
  return {
    "@odata.context": `${GRAPH}/$metadata#users('me')/mailFolders('${folder}')/messages`,
    "@odata.nextLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$skiptoken=${skiptoken}`,
    value: [...value],
  };
}

/** A final delta page: `value` + an `@odata.deltaLink` carrying a $deltatoken (the next cursor). */
export function deltaPageWithDelta(
  folder: string,
  value: ReadonlyArray<unknown>,
  deltatoken: string,
): Record<string, unknown> {
  return {
    "@odata.context": `${GRAPH}/$metadata#users('me')/mailFolders('${folder}')/messages`,
    "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${deltatoken}`,
    value: [...value],
  };
}

// Inbox: two pages (page 1 → nextLink, page 2 → deltaLink). Page 2 includes a tombstone.
export const INBOX_DELTA_PAGE_1 = deltaPageWithNext(
  "inbox",
  [MSG_INBOX_1, MSG_INBOX_2],
  "INBOX_SKIP_1",
);
export const INBOX_DELTA_PAGE_2 = deltaPageWithDelta(
  "inbox",
  [MSG_INBOX_3, REMOVED_INBOX_1],
  "INBOX_DELTA_R1",
);

// Sent: a single page (deltaLink directly).
export const SENT_DELTA_PAGE = deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_DELTA_R1");

// ═══════════════════════════════════════════════════════════════════════════════════
// Calendar fixtures (#26a) — production string forms of the calendarView delta event
// resource. No Prefer: outlook.timezone is sent, so Graph returns UTC dateTimes with the
// 7-fraction-digit, ZONE-LESS format ("2026-07-15T09:00:00.0000000") + timeZone: "UTC".
// calendarView delta supports no $select — full payloads (attendees included) ride `raw`.
// ═══════════════════════════════════════════════════════════════════════════════════

/** A recurring-series OCCURRENCE — seriesMasterId set, attendee self-response accepted. */
export const CAL_OCCURRENCE_1 = {
  id: "AAMkAGI2-Cal-Occurrence-0001",
  iCalUId: "040000008200E00074C5B7101A82E00800000000B0C1D2occurrence0001",
  type: "occurrence",
  seriesMasterId: "AAMkAGI2-Cal-Master-0001",
  subject: "Weekly sync",
  bodyPreview: "Agenda: status round + blockers.",
  body: { contentType: "html", content: "<html><body>Agenda: status round + blockers.</body></html>" },
  location: { displayName: "Teams", locationType: "default", uniqueIdType: "unknown" },
  start: { dateTime: "2026-07-15T16:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-07-15T16:30:00.0000000", timeZone: "UTC" },
  isAllDay: false,
  isCancelled: false,
  showAs: "busy",
  organizer: { emailAddress: { name: "Alice Sender", address: "alice@contoso.example.com" } },
  attendees: [
    {
      type: "required",
      status: { response: "accepted", time: "2026-07-01T09:00:00Z" },
      emailAddress: { name: "Operator", address: "operator@contoso.example.com" },
    },
  ],
  responseStatus: { response: "accepted", time: "2026-07-01T09:00:00Z" },
  originalStartTimeZone: "Pacific Standard Time", // a WINDOWS zone name — stored as-given
  originalEndTimeZone: "Pacific Standard Time",
  webLink: "https://outlook.live.com/calendar/item/AAMkAGI2-Cal-Occurrence-0001",
  lastModifiedDateTime: "2026-07-01T09:00:01.1234567Z",
} as const;

/** An EXCEPTION instance — originalStart set (the slot it moved from), tentative self-response. */
export const CAL_EXCEPTION_1 = {
  id: "AAMkAGI2-Cal-Exception-0002",
  iCalUId: "040000008200E00074C5B7101A82E00800000000B0C1D2exception0002",
  type: "exception",
  seriesMasterId: "AAMkAGI2-Cal-Master-0001",
  subject: "Weekly sync (moved)",
  bodyPreview: "Moved one hour later this week only.",
  location: { displayName: "Room 4B" },
  start: { dateTime: "2026-07-22T17:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-07-22T17:30:00.0000000", timeZone: "UTC" },
  isAllDay: false,
  isCancelled: false,
  organizer: { emailAddress: { name: "Alice Sender", address: "alice@contoso.example.com" } },
  responseStatus: { response: "tentativelyAccepted", time: "2026-07-02T08:00:00Z" },
  originalStart: "2026-07-22T16:00:00Z",
  originalStartTimeZone: "Pacific Standard Time",
  webLink: "https://outlook.live.com/calendar/item/AAMkAGI2-Cal-Exception-0002",
  lastModifiedDateTime: "2026-07-02T08:00:02.7654321Z",
} as const;

/** An ALL-DAY single event — isAllDay true, midnight bounds, EXCLUSIVE end (as Graph gives it). */
export const CAL_ALLDAY_1 = {
  id: "AAMkAGI2-Cal-AllDay-0003",
  iCalUId: "040000008200E00074C5B7101A82E00800000000B0C1D2allday0003",
  type: "singleInstance",
  subject: "Company holiday",
  bodyPreview: "",
  location: { displayName: "" },
  start: { dateTime: "2026-07-20T00:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-07-21T00:00:00.0000000", timeZone: "UTC" }, // exclusive all-day end
  isAllDay: true,
  isCancelled: false,
  organizer: { emailAddress: { name: "Operator", address: "operator@contoso.example.com" } },
  responseStatus: { response: "organizer", time: "0001-01-01T00:00:00Z" },
  originalStartTimeZone: "UTC",
  webLink: "https://outlook.live.com/calendar/item/AAMkAGI2-Cal-AllDay-0003",
  lastModifiedDateTime: "2026-06-30T12:00:00.0000000Z",
} as const;

/** A CANCELLED `@removed` delta entry for CAL_OCCURRENCE_1 (deleted from the calendar). */
export const CAL_REMOVED_1 = {
  id: CAL_OCCURRENCE_1.id,
  "@removed": { reason: "deleted" },
} as const;

/** An OUT-OF-WINDOW `@removed` id (Graph's documented noise) — must tombstone 0 rows, no error. */
export const CAL_REMOVED_OUT_OF_WINDOW = {
  id: "AAMkAGI2-Cal-OutOfWindow-9999",
  "@removed": { reason: "deleted" },
} as const;

/** A 4xx error body whose Graph code is SyncStateNotFound (the non-410 delta-state-loss path). */
export const SYNC_STATE_NOT_FOUND_BODY = {
  error: {
    code: "SyncStateNotFound",
    message: "The sync state is not found. Please restart the sync.",
    innerError: { date: "2026-07-11T00:00:00", "request-id": "0f00-req", "client-request-id": "0f00-cli" },
  },
} as const;

/** A non-final calendarView delta page: `value` + an `@odata.nextLink` carrying a $skiptoken. */
export function calPageWithNext(
  value: ReadonlyArray<unknown>,
  skiptoken: string,
): Record<string, unknown> {
  return {
    "@odata.context": `${GRAPH}/$metadata#Collection(event)`,
    "@odata.nextLink": `${GRAPH}/me/calendarView/delta?$skiptoken=${skiptoken}`,
    value: [...value],
  };
}

/** A final calendarView delta page: `value` + an `@odata.deltaLink` carrying a $deltatoken. */
export function calPageWithDelta(
  value: ReadonlyArray<unknown>,
  deltatoken: string,
): Record<string, unknown> {
  return {
    "@odata.context": `${GRAPH}/$metadata#Collection(event)`,
    "@odata.deltaLink": `${GRAPH}/me/calendarView/delta?$deltatoken=${deltatoken}`,
    value: [...value],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════
// Contacts fixtures (#26a) — production string forms of the contact resource + the
// default-folder probe. Delta is folder-scoped: /me/contactFolders/{id}/contacts/delta.
// ═══════════════════════════════════════════════════════════════════════════════════

export const CONTACTS_FOLDER_ID = "AAMkAGI2-ContactFolder-Default";

/** Full contact — mobile phone in a formatted E.164-ish form (leading + must survive cleaning). */
export const CONTACT_1 = {
  "@odata.etag": 'W/"EQAAABYAAAA1"',
  id: "AAMkAGI2-Contact-0001",
  parentFolderId: CONTACTS_FOLDER_ID,
  displayName: "Carol Friend",
  givenName: "Carol",
  surname: "Friend",
  emailAddresses: [{ name: "Carol Friend", address: "carol@partner.example.org" }],
  businessPhones: ["+1 425 555 0111"],
  homePhones: [],
  mobilePhone: "+1 (425) 555-0100",
  companyName: "Partner Org",
  jobTitle: "Head of Partnerships",
  lastModifiedDateTime: "2026-07-01T10:00:00Z",
} as const;

/** No mobile — falls back to businessPhones[0]; NO leading + (no country inference allowed). */
export const CONTACT_2 = {
  "@odata.etag": 'W/"EQAAABYAAAA2"',
  id: "AAMkAGI2-Contact-0002",
  parentFolderId: CONTACTS_FOLDER_ID,
  displayName: "Bob Watcher",
  givenName: "Bob",
  surname: "Watcher",
  emailAddresses: [{ name: "Bob Watcher", address: "bob@contoso.example.com" }],
  businessPhones: ["(425) 555-0199"],
  homePhones: ["425.555.0122"],
  mobilePhone: null,
  companyName: "Contoso",
  jobTitle: null,
  lastModifiedDateTime: "2026-06-20T08:30:00Z",
} as const;

/** An `@removed` delta entry for CONTACT_1 (deleted from the folder). */
export const CONTACT_REMOVED_1 = {
  id: CONTACT_1.id,
  "@removed": { reason: "deleted" },
} as const;

/** The default-folder PROBE response (GET /me/contacts?$top=1&$select=parentFolderId). */
export const CONTACTS_PROBE_PAGE = {
  "@odata.context": `${GRAPH}/$metadata#users('me')/contacts(parentFolderId)`,
  value: [{ "@odata.etag": 'W/"EQAAABYAAAA1"', id: CONTACT_1.id, parentFolderId: CONTACTS_FOLDER_ID }],
} as const;

/** The probe against an EMPTY mailbox — no contacts, so no folder id can be discovered. */
export const CONTACTS_PROBE_EMPTY = {
  "@odata.context": `${GRAPH}/$metadata#users('me')/contacts(parentFolderId)`,
  value: [],
} as const;

/** A non-final contacts delta page: `value` + an `@odata.nextLink` carrying a $skiptoken. */
export function contactPageWithNext(
  value: ReadonlyArray<unknown>,
  skiptoken: string,
): Record<string, unknown> {
  return {
    "@odata.context": `${GRAPH}/$metadata#Collection(contact)`,
    "@odata.nextLink": `${GRAPH}/me/contactFolders/${CONTACTS_FOLDER_ID}/contacts/delta?$skiptoken=${skiptoken}`,
    value: [...value],
  };
}

/** A final contacts delta page: `value` + an `@odata.deltaLink` carrying a $deltatoken. */
export function contactPageWithDelta(
  value: ReadonlyArray<unknown>,
  deltatoken: string,
): Record<string, unknown> {
  return {
    "@odata.context": `${GRAPH}/$metadata#Collection(contact)`,
    "@odata.deltaLink": `${GRAPH}/me/contactFolders/${CONTACTS_FOLDER_ID}/contacts/delta?$deltatoken=${deltatoken}`,
    value: [...value],
  };
}
