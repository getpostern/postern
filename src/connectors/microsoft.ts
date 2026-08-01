// Microsoft Outlook connector — read-only mail + calendar + contacts over Microsoft Graph v1.0.
// ONE connector instance serves THREE sectors from ONE credential (ADR 0006, the google.ts pattern;
// #26a): sync() branches on ctx.sector, normalize()/strongKeys() on rec.object.
//
// MAIL — per-folder message DELTA sync over a fixed set of well-known folders (Inbox + Sent in V0).
// Caches the RFC-5322 ENVELOPE only (ADR 0001) — sender/subject/snippet/dates/flags — never the body
// or attachment content. The body is fetched on demand by message id via fetchRecordLive (stores
// NOTHING). Graph `@removed` delta entries become ADR-0004 tombstones; a later live sighting
// resurrects. Read-only: actions:[] and execute() throws.
//
// DELTA PARTIALS (#138) — a delta round reports UPDATES, and Graph's contract for an updated item is
// "represented by their id with AT LEAST the updated properties, but other properties MIGHT be
// included" (learn.microsoft.com/en-us/graph/delta-query-overview, "Resource representation in the
// delta query response"). So a read-status flip may legitimately arrive as `{ id, isRead }` — a
// CHANGE NOTICE, not a message. It cannot be applied as one: normalizeMail is total (an absent Graph
// field becomes null) and the runner's upsert replaces EVERY non-key column with `excluded.<col>`
// (src/sync/runner.ts buildUpsert), so such an entry BLANKS a faithfully-cached message, or inserts
// an empty one for a message never seen. Every incomplete delta entry is therefore RE-READ from the
// source by id (envelope $select — never the body) before it is yielded; a 404 on that re-read means
// the source no longer has the message, so it becomes a tombstone rather than a blank row. A payload
// that still carries no envelope content after that is a shape we cannot safely apply → a LOUD error
// out of normalizeMail, never a silent hollow write.
//
// CALENDAR — GET /me/calendarView/delta over a [now−365d, now+365d] window (the only v1.0 events
// delta; expands recurrences into occurrence/exception instances, matching the store's
// expanded-instances contract). Window bounds are FROZEN into Graph's tokens, so a rolling window
// requires a NEW chain: the connector re-anchors (fresh chain, fresh window) when the stored window's
// future headroom drops under 180 days. A complete one-run fresh chain sweeps deletions the dead
// chain missed via the runner's reconcileObjectSnapshot, WINDOW-SCOPED to [ws, we] on starts_at —
// rows outside the window stay as accumulated history (Google-parity).
//
// CONTACTS — the documented folder-scoped delta /me/contactFolders/{id}/contacts/delta (the bare
// /me/contacts/delta is undocumented); the default folder is discovered by probing one contact's
// parentFolderId. A complete one-run fresh chain sweeps the whole folder (no window — the chain
// enumerates it all). Contact photos are separate per-contact binary endpoints — skipped (footprint).
//
// RESILIENCE: an expired delta/skip token surfaces as HTTP 410 GONE. Rather than wedge the
// connection in status='error' until the cursor is hand-cleared, a 410 on ANY delta page (the stored
// deltaLink, an @odata.nextLink, or the initial request) drops that folder's stored deltaLink and
// restarts a FRESH delta with the initial $select — Graph's documented resync. Delta is cumulative,
// so a fresh delta fully recovers; this mirrors the google connector's 410/EXPIRED_SYNC_TOKEN path.
//
// SECURITY: ctx.secret is the proactively-refreshed Graph access token (the OAuth/refresh seam owns
// expiry). It is a credential — NEVER logged, NEVER placed in an error message. Every Graph failure
// throws a clean, status-only error. All logging (none here beyond errors) goes to stderr. Bearer
// host-pin: the token is attached ONLY to URLs on the Graph v1.0 host — a server-provided pagination
// link (@odata.nextLink/@odata.deltaLink, possibly persisted in the cursor) pointing anywhere else
// never receives the credential (throws a secret-free error before the request).

import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";
import { RetryableError } from "../sync/errors.js";
import { reconcileObjectSnapshot } from "../sync/runner.js";

// ── Graph constants ─────────────────────────────────────────────────────────────
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Envelope fields requested on the INITIAL delta request ONLY. Graph bakes $select into the
// skip/delta token, so it must NOT be re-sent on @odata.nextLink / @odata.deltaLink follow-ups.
const ENVELOPE_SELECT =
  "id,internetMessageId,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,importance,isDraft";

// The by-id body drill (fetchRecordLive) — envelope + the body, fetched live, stored NOWHERE.
const BODY_SELECT =
  "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments";

// ── Delta partial-payload probe (#138) ──────────────────────────────────────────
// The keys whose presence says "this delta entry is a COMPLETE envelope representation, apply it
// as-is"; an entry missing ANY of them is Graph's documented UPDATE shape (id + at least the changed
// properties) and is re-read from the source instead. Presence is tested with Object.hasOwn, NOT
// truthiness: Graph emits a $select'd key even when the value is null or "" (an empty subject, a
// message with no `from`), and those are faithful values — only an ABSENT key means "not reported".
//
// DOCUMENTATION-DERIVED (no live capture was available; see microsoft.fixtures.ts). These six are
// the envelope's content core — every complete Graph message representation carries them. If a live
// capture ever shows Graph omitting one of these on a COMPLETE representation, REMOVE it from this
// list: the probe is what a live divergence corrects. The fail-closed guard it feeds
// (hasEnvelopeContent, below) is outcome-based and must never be weakened instead — a false positive
// here costs one extra Graph GET, a false negative stores a hollow row.
const ENVELOPE_REQUIRED_KEYS: ReadonlyArray<string> = [
  "subject",
  "bodyPreview",
  "receivedDateTime",
  "sentDateTime",
  "conversationId",
  "from",
];

// Bounded per-run budget for those re-reads. A pathological burst (a mailbox-wide "mark all as read"
// reports every touched message as a partial) must not turn one poll into thousands of sequential
// Graph GETs. The budget is checked at PAGE boundaries only, so a page always completes and the
// committed-through cursor always advances — exhausting it throws a RetryableError (status='syncing',
// the next poll resumes from the checkpointed cursor), which is progress, not a wedge.
const MAX_HYDRATIONS_PER_RUN = 200;

// Fixed synced set this wave (operator-decided: Inbox + Sent only). Well-known names need no GUID
// resolution. Map each to the neutral REGISTRY `folder` enum. drafts|spam|trash|archive|other are
// reserved for deferred folders / future connectors but are not produced here.
const FOLDERS: ReadonlyArray<{ readonly name: string }> = [{ name: "inbox" }, { name: "sentitems" }];
const FOLDER_ENUM: Record<string, string> = { inbox: "inbox", sentitems: "sent" };

// Synthetic key threaded into the stored envelope `raw` so normalize() — a pure function of a single
// record — knows which well-known folder the message came from (delta is per-folder; the message
// resource itself carries only the GUID parentFolderId). Mirrors SimpleFIN's __pci_parent pattern:
// the original Graph fields stay byte-faithful, this only ADDS a key.
const FOLDER_KEY = "__pci_folder";

// 429 throttling: honor Retry-After with a small bounded retry, then throw a RetryableError (the
// runner marks status='syncing'; the next poll resumes from the persisted cursor — delta is resumable).
const MAX_429_RETRIES = 3;
const RETRY_AFTER_DEFAULT_MS = 1000;
const RETRY_AFTER_CAP_MS = 60_000;

// Transient 5xx (502/503/504) — a Graph gateway/timeout error on a heavy enumeration. Retried with
// bounded EXPONENTIAL backoff (base ~1s, doubling, capped at RETRY_AFTER_CAP_MS); on exhaustion the
// final 5xx response is returned so graphFetchPage throws a RetryableError (status='syncing', resumes
// from the persisted cursor). A non-5xx/429 non-2xx (400/403/etc.) is NOT retried — it's terminal.
const MAX_5XX_RETRIES = 4;
const RETRY_5XX_BASE_MS = 1000;

/** The set of HTTP statuses treated as transient (retry, then RetryableError) — NOT terminal. */
function is5xxTransient(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** Exponential backoff for the Nth (0-based) 5xx retry: base·2^n, capped at RETRY_AFTER_CAP_MS. */
function backoff5xxMs(attempt: number): number {
  // #43 B: the base is read at call time from an OPTIONAL env override so tests can shrink the real
  // backoff to ~ms (keeping pg's pool timers honest — no vi.useFakeTimers). Unset in prod → the
  // constant RETRY_5XX_BASE_MS, byte-identical behavior.
  const base = Number(process.env.PCI_RETRY_5XX_BASE_MS) || RETRY_5XX_BASE_MS;
  return Math.min(base * 2 ** attempt, RETRY_AFTER_CAP_MS);
}

// Host-pin: the v1.0 Graph host. The Bearer credential is attached ONLY to URLs targeting this host.
// Server-provided pagination links (@odata.nextLink/@odata.deltaLink, possibly persisted in the
// cursor) are otherwise untrusted and must never receive the token.
const GRAPH_HOST = "graph.microsoft.com";

// Defensive cap on the per-folder @odata.nextLink walk so a runaway/looping pagination link can't
// spin forever. The windowed filtered delta (wave 12a) caps volume well below this; the cap stays as a
// safety net, and its throw is now RetryableError (status='syncing', resumes from the persisted
// cursor) rather than a terminal error — a residual large pull picks up where it left off.
const MAX_PAGES_PER_FOLDER = 1000;

// One day in ms — the recency-window start is computed as now − windowDays·DAY_MS (wave 12a).
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Calendar window policy (#26a) ─────────────────────────────────────────────────
// calendarView delta freezes its startDateTime/endDateTime into the skip/delta tokens, so a rolling
// window REQUIRES a new chain. Window = [now − 365d, now + 365d]; when the stored window's future
// headroom (we − now) drops under 180d, the connector abandons the stored link and re-anchors a
// fresh chain on a new window. Events beyond the future bound aren't cached until a re-anchor.
const CAL_WINDOW_PAST_MS = 365 * DAY_MS;
const CAL_WINDOW_FUTURE_MS = 365 * DAY_MS;
const CAL_REANCHOR_HEADROOM_MS = 180 * DAY_MS;

// Contact fields requested on the INITIAL contacts delta request ONLY (contacts delta supports
// $select; Graph bakes it into the skip/delta token, mail-style — never re-sent on a follow-up).
const CONTACT_SELECT =
  "id,displayName,givenName,surname,emailAddresses,businessPhones,homePhones,mobilePhone,companyName,jobTitle,lastModifiedDateTime";

/**
 * Build the windowed-delta query suffix appended to the INITIAL delta request for a folder. When a
 * recency window is set, Graph bakes `$filter=receivedDateTime ge <window-start>` (+ `$orderby` so the
 * 5k filtered-delta cap yields the MOST-RECENT messages) into the @odata.nextLink/@odata.deltaLink, so
 * the filter is sent ONCE here and carried forward by the stored links — paging IS the windowed
 * backfill, no full enumeration. windowDays null/undefined ⇒ "" (all-history; today's behaviour). The
 * filter VALUE is URL-encoded (it contains spaces + colons); $select stays unencoded as before.
 */
function windowFilterSuffix(windowDays: number | null | undefined): string {
  if (windowDays == null || !Number.isFinite(windowDays) || windowDays <= 0) return "";
  const startIso = new Date(Date.now() - windowDays * DAY_MS).toISOString();
  return (
    `&$filter=${encodeURIComponent(`receivedDateTime ge ${startIso}`)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}`
  );
}

// ── Graph resource shapes (the subset we read; parsed defensively) ───────────────
interface GraphEmailAddress {
  name?: string;
  address?: string;
}
interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}
interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  importance?: string;
  isDraft?: boolean;
  categories?: string[];
  [k: string]: unknown;
}
interface GraphRemoved {
  id: string;
  "@removed": { reason?: string };
}
type GraphDeltaEntry = GraphMessage | GraphRemoved;
interface GraphDeltaPage {
  value?: GraphDeltaEntry[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

// ── Graph calendar/contact resource shapes (the subset we read; parsed defensively) ──
interface GraphDateTimeTimeZone {
  dateTime?: string; // "2026-07-15T09:00:00.0000000" — UTC (no Prefer: outlook.timezone is sent)
  timeZone?: string;
}
interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  organizer?: GraphRecipient;
  responseStatus?: { response?: string; time?: string };
  seriesMasterId?: string;
  originalStart?: string; // exception instances: the occurrence's original UTC start
  originalStartTimeZone?: string;
  webLink?: string;
  lastModifiedDateTime?: string;
  [k: string]: unknown;
}
interface GraphContact {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: Array<{ name?: string; address?: string }>;
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string;
  companyName?: string;
  jobTitle?: string;
  lastModifiedDateTime?: string;
  parentFolderId?: string;
  [k: string]: unknown;
}
/** A generic (calendar/contact) delta page — entries are typed at the use site. */
interface GraphGenericPage {
  value?: Array<Record<string, unknown>>;
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

// ── Normalized row shape ─────────────────────────────────────────────────────────

/** Normalized mail envelope row — ONLY the REGISTRY `mail` scalar columns (no `id`, no `raw`). */
export interface MailMessageRow {
  source_object_id: string; // Graph message id, requested as an ImmutableId (stable across moves)
  thread_id: string | null; // conversationId
  message_id_header: string | null; // internetMessageId (RFC 5322 Message-ID)
  from_address: string | null; // from.emailAddress.address
  from_name: string | null; // from.emailAddress.name
  sender_address: string | null; // sender.emailAddress.address (delegate/shared; often == from)
  subject: string | null;
  snippet: string | null; // bodyPreview (first ~255 chars; NOT the body)
  sent_at: string | null; // sentDateTime (ISO 8601 UTC)
  received_at: string | null; // receivedDateTime (primaryTime / default sort)
  is_read: boolean | null; // isRead
  has_attachments: boolean | null; // hasAttachments
  folder: string | null; // neutral enum: inbox|sent|drafts|spam|trash|archive|other
  importance: string | null; // low|normal|high
}

/** Normalized calendar event row — ONLY the REGISTRY `calendar` scalar columns (no `id`/`raw`/`attendees`). */
export interface CalendarEventRow {
  source_object_id: string; // Graph event id (ImmutableId; occurrence ids stable per chain)
  summary: string | null; // subject
  description: string | null; // bodyPreview (full HTML body stays in raw)
  location: string | null; // location.displayName
  starts_at: string | null; // start.dateTime as UTC ISO
  ends_at: string | null; // end.dateTime as UTC ISO (all-day end exclusive, as Graph gives it)
  start_tz: string | null; // originalStartTimeZone as-given (may be a Windows zone name)
  all_day: boolean; // isAllDay
  status: string | null; // isCancelled ? cancelled : confirmed (Graph has no event-level tentative)
  organizer_email: string | null; // organizer.emailAddress.address
  owner_response: string | null; // responseStatus.response mapped to the Google vocabulary
  is_recurring: boolean; // seriesMasterId != null
  recurrence_master_id: string | null; // seriesMasterId
  original_start: string | null; // originalStart (exception instances)
  original_start_tz: string | null; // originalStartTimeZone
  html_link: string | null; // webLink
  updated_at: string | null; // lastModifiedDateTime
}

/** Normalized contact row — ONLY the REGISTRY `contacts` scalar columns (no `id`/`raw`). */
export interface ContactRow {
  source_object_id: string; // Graph contact id
  display_name: string | null; // displayName
  given_name: string | null; // givenName
  family_name: string | null; // surname
  primary_email: string | null; // emailAddresses[0].address
  primary_phone: string | null; // best-effort E.164: mobilePhone ?? businessPhones[0] ?? homePhones[0], cleaned
  company: string | null; // companyName
  job_title: string | null; // jobTitle
  updated_at: string | null; // lastModifiedDateTime (always present — primaryTime must populate)
}

// ── Helpers (module-private) ─────────────────────────────────────────────────────

/** The headers every Graph call sends. Bearer token + ImmutableId + page-size preferences. */
function graphHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    // ImmutableId keeps message ids stable across folder moves (a move otherwise reads as
    // delete+create); maxpagesize bounds each delta page. Reverted 20 → 50 (wave 12a): the windowed
    // filtered delta caps volume (≤ window, ≤ ~5k recent), so a larger page = fewer round-trips
    // without risking a per-request timeout on an unbounded enumeration.
    Prefer: 'IdType="ImmutableId", odata.maxpagesize=50',
  };
}

/** A delta entry is a tombstone iff it carries the `@removed` facet (any sector's delta stream). */
function isRemoved(entry: unknown): entry is GraphRemoved {
  return entry != null && typeof entry === "object" && Object.hasOwn(entry, "@removed");
}

/** Parse the per-folder delta cursor map; tolerate a missing/garbled cursor by starting fresh. */
function parseCursorMap(cursor: string | undefined): Record<string, string> {
  if (!cursor) return {};
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // garbled cursor → fall through to a fresh delta
  }
  return {};
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
 * Thrown by graphFetchPage on HTTP 410 GONE — an expired delta/skip token. The per-folder loop
 * catches it to drop that folder's stored deltaLink and restart a FRESH delta (Graph's documented
 * resync); it is never propagated, so an expired cursor self-heals instead of wedging status='error'.
 */
class GraphGoneError extends Error {
  constructor() {
    super("microsoft: delta token expired (410); resyncing folder");
    this.name = "GraphGoneError";
  }
}

/**
 * Host-pin a URL BEFORE the Bearer credential is attached. Server-provided pagination links
 * (@odata.nextLink/@odata.deltaLink, possibly persisted in the cursor) are trusted to receive the
 * token only when they target the Graph v1.0 host; anything else (an attacker-influenced or
 * malformed link) must NOT — throw a clean, secret-free error. Our own GRAPH_BASE URLs pass.
 */
function assertGraphHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("microsoft: refusing to send credential to a malformed url");
  }
  // Require BOTH the Graph host AND https — an http:// link to the right host would still leak the
  // bearer over plaintext (downgrade), so the scheme is part of the pin.
  if (parsed.protocol !== "https:" || parsed.host !== GRAPH_HOST) {
    throw new Error("microsoft: refusing to send bearer to a non-graph host");
  }
}

/**
 * GET a Graph URL with the standard headers, honoring transient failures with bounded retries:
 * HTTP 429 (Retry-After) and HTTP 502/503/504 (exponential backoff). Returns the final Response
 * (which may be a non-2xx error — callers inspect .ok / .status); on 5xx exhaustion it returns the
 * last 5xx response so the caller can classify it. A persistent 429 (RetryableError) or a network
 * failure (RetryableError) throws a clean, secret-free, TRANSIENT error. A non-2xx that is neither
 * 429 nor a transient 5xx (e.g. 400/403/404/410) is returned immediately — NO retry. Host-pins the
 * URL before attaching the bearer (a non-graph host throws a terminal, secret-free error).
 */
async function graphFetch(url: string, token: string): Promise<Response> {
  assertGraphHost(url); // never attach the credential to a non-graph host
  let attempt429 = 0;
  let attempt5xx = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp: Response;
    try {
      resp = await fetch(url, { method: "GET", headers: graphHeaders(token) });
    } catch {
      // Network/timeout: transient — resumable from the persisted cursor on the next poll.
      throw new RetryableError("microsoft: graph request failed");
    }
    if (resp.status === 429) {
      if (attempt429 >= MAX_429_RETRIES) {
        throw new RetryableError("microsoft: graph throttled (429) after retries");
      }
      await sleep(retryAfterMs(resp.headers.get("Retry-After")));
      attempt429++;
      continue;
    }
    if (is5xxTransient(resp.status)) {
      // Exhausted: return the 5xx so graphFetchPage throws a status-only RetryableError.
      if (attempt5xx >= MAX_5XX_RETRIES) return resp;
      await sleep(backoff5xxMs(attempt5xx));
      attempt5xx++;
      continue;
    }
    return resp; // 2xx, or a terminal non-2xx (400/403/404/410) — no retry
  }
}

/**
 * graphFetch + JSON parse. A 410 GONE (expired delta/skip token) throws GraphGoneError so the
 * folder loop can resync; a transient 5xx (after graphFetch exhausted its retries) throws a
 * RetryableError (status='syncing', resumes from the persisted cursor); any other non-2xx throws a
 * plain (terminal) status-only error. All messages are secret-free (status only).
 */
async function graphFetchPage(url: string, token: string): Promise<GraphDeltaPage> {
  const resp = await graphFetch(url, token);
  if (resp.status === 410) throw new GraphGoneError();
  if (is5xxTransient(resp.status)) {
    throw new RetryableError(`microsoft: delta fetch returned ${resp.status}`);
  }
  if (!resp.ok) throw new Error(`microsoft: delta fetch returned ${resp.status}`);
  return (await resp.json()) as GraphDeltaPage;
}

/**
 * Thrown by graphFetchGenericPage on a 4xx whose Graph error code is syncStateNotFound — the delta
 * state is gone (Graph's cache-eviction path that answers 40x instead of 410). Caught by the
 * calendar/contacts chain loops to restart a FRESH chain; never propagated on the first occurrence.
 */
class GraphSyncStateLostError extends Error {
  constructor(status: number) {
    super(`microsoft: delta sync state lost (${status}); restarting a fresh chain`);
    this.name = "GraphSyncStateLostError";
  }
}

/** Does a Graph 4xx error body carry code syncStateNotFound? Parsed defensively; case-insensitive. */
function isSyncStateNotFound(bodyText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" && code.toLowerCase() === "syncstatenotfound";
  } catch {
    return false;
  }
}

/**
 * graphFetch + JSON parse for the calendar/contacts delta chains. 410 GONE → GraphGoneError (the
 * response's Location restart URL has "start a new initial call" semantics — the chain loop issues a
 * fresh initial request on OUR window/select, never a stored token); a 4xx syncStateNotFound →
 * GraphSyncStateLostError (same fresh-chain restart); a transient 5xx (post-retry) → RetryableError;
 * any other non-2xx → a plain terminal status-only error. All messages secret-free.
 */
async function graphFetchGenericPage(url: string, token: string): Promise<GraphGenericPage> {
  const resp = await graphFetch(url, token);
  if (resp.status === 410) throw new GraphGoneError();
  if (is5xxTransient(resp.status)) {
    throw new RetryableError(`microsoft: delta fetch returned ${resp.status}`);
  }
  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) {
      const text = await resp.text().catch(() => "");
      if (isSyncStateNotFound(text)) throw new GraphSyncStateLostError(resp.status);
    }
    throw new Error(`microsoft: delta fetch returned ${resp.status}`);
  }
  return (await resp.json()) as GraphGenericPage;
}

// ── Calendar/contacts cursor shapes (per-connection; each sector has its OWN connectors row) ──────

/** Calendar cursor: the frozen window bounds + the committed-through nextLink/deltaLink. */
interface CalendarCursor {
  ws: string; // window start (ISO)
  we: string; // window end (ISO)
  link: string; // @odata.nextLink (mid-chain) or @odata.deltaLink (incremental)
}

/** Parse the calendar cursor; a missing/garbled cursor (or unparseable bounds) → null (fresh chain). */
function parseCalendarCursor(cursor: string | undefined): CalendarCursor | null {
  if (!cursor) return null;
  try {
    const p: unknown = JSON.parse(cursor);
    if (p != null && typeof p === "object" && !Array.isArray(p)) {
      const { ws, we, link } = p as Record<string, unknown>;
      if (
        typeof ws === "string" &&
        typeof we === "string" &&
        typeof link === "string" &&
        Number.isFinite(Date.parse(ws)) &&
        Number.isFinite(Date.parse(we))
      ) {
        return { ws, we, link };
      }
    }
  } catch {
    // garbled cursor → fresh chain
  }
  return null;
}

/** Contacts cursor: the discovered default-folder id + the committed-through link. */
interface ContactsCursor {
  folderId: string;
  link?: string;
}

/** Parse the contacts cursor; missing/garbled → null (re-probe + fresh chain). */
function parseContactsCursor(cursor: string | undefined): ContactsCursor | null {
  if (!cursor) return null;
  try {
    const p: unknown = JSON.parse(cursor);
    if (p != null && typeof p === "object" && !Array.isArray(p)) {
      const { folderId, link } = p as Record<string, unknown>;
      if (typeof folderId === "string" && folderId !== "") {
        return { folderId, link: typeof link === "string" ? link : undefined };
      }
    }
  } catch {
    // garbled cursor → fresh chain
  }
  return null;
}

// ── Calendar/contact normalizer helpers (module-private) ─────────────────────────

/**
 * Graph dateTimeTimeZone → UTC ISO instant. We send NO `Prefer: outlook.timezone`, so Graph returns
 * UTC with a bare (zone-less, 7-fraction-digit) dateTime — parse it AS UTC (suffix Z when no zone
 * marker is present) and emit a clean ISO string for the timestamptz column. Unparseable → as-given.
 */
function graphDtToUtcIso(dt: GraphDateTimeTimeZone | undefined): string | null {
  const s = dt?.dateTime;
  if (s == null || s === "") return null;
  const withZone = /(?:[zZ]|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

/** Graph responseStatus.response → the Google owner_response vocabulary (spec table, #26a). */
function mapOwnerResponse(response: string | undefined): string {
  switch (response) {
    case "accepted":
    case "organizer":
      return "accepted";
    case "declined":
      return "declined";
    case "tentativelyAccepted":
      return "tentative";
    default:
      return "needsAction";
  }
}

/**
 * Best-effort E.164: strip formatting chars (spaces/dashes/dots/parens/letters), keep a leading `+`,
 * NO country inference (deterministic; Graph has no canonicalForm — Google-fallback-parity).
 */
function cleanPhone(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  return digits === "" ? null : `${plus}${digits}`;
}

/** Map a Graph event → the REGISTRY `calendar` scalars (never `id`/`raw`/`attendees` — H2/S11). */
function normalizeCalendarEvent(rec: RawRecord): CalendarEventRow {
  const e = rec.raw as GraphEvent;
  return {
    source_object_id: String(e.id),
    summary: e.subject ?? null,
    description: e.bodyPreview ?? null, // preview only — the full HTML body stays in raw
    location: e.location?.displayName ?? null,
    starts_at: graphDtToUtcIso(e.start),
    ends_at: graphDtToUtcIso(e.end), // all-day end is EXCLUSIVE, as Graph gives it
    start_tz: e.originalStartTimeZone ?? null, // as-given (may be a Windows zone name, not IANA)
    all_day: e.isAllDay === true,
    status: e.isCancelled === true ? "cancelled" : "confirmed",
    organizer_email: e.organizer?.emailAddress?.address ?? null,
    owner_response: mapOwnerResponse(e.responseStatus?.response),
    is_recurring: e.seriesMasterId != null,
    recurrence_master_id: e.seriesMasterId ?? null,
    original_start: e.originalStart ?? null,
    original_start_tz: e.originalStartTimeZone ?? null,
    html_link: e.webLink ?? null,
    updated_at: e.lastModifiedDateTime ?? null,
  };
}

/** Map a Graph contact → the REGISTRY `contacts` scalars (never `id`/`raw`). */
function normalizeContact(rec: RawRecord): ContactRow {
  const c = rec.raw as GraphContact;
  return {
    source_object_id: String(c.id),
    display_name: c.displayName ?? null,
    given_name: c.givenName ?? null,
    family_name: c.surname ?? null,
    primary_email: c.emailAddresses?.[0]?.address ?? null,
    primary_phone: cleanPhone(c.mobilePhone ?? c.businessPhones?.[0] ?? c.homePhones?.[0]),
    company: c.companyName ?? null,
    job_title: c.jobTitle ?? null,
    updated_at: c.lastModifiedDateTime ?? null, // always present — primaryTime must populate
  };
}

/**
 * Is this delta entry a COMPLETE envelope representation (apply as-is), or Graph's UPDATE shape
 * (id + at least the changed properties → re-read by id)? See ENVELOPE_REQUIRED_KEYS.
 */
function isCompleteEnvelope(entry: GraphMessage): boolean {
  return ENVELOPE_REQUIRED_KEYS.every((k) => Object.hasOwn(entry, k));
}

/** A present, non-empty string value (an empty string is "reported as empty", not content). */
function hasText(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

/**
 * Does this Graph message carry ANY value that makes a stored row real mail? Every complete message
 * representation does (a stored message always has a receivedDateTime and a conversationId), so a
 * false answer means the payload is a change notice, not a message — the one shape that must never
 * reach the store. This is the FAIL-CLOSED backstop behind the re-read: outcome-based, so it holds
 * whatever Graph's per-resource payload rules turn out to be.
 */
function hasEnvelopeContent(m: GraphMessage): boolean {
  return (
    hasText(m.subject) ||
    hasText(m.bodyPreview) ||
    hasText(m.receivedDateTime) ||
    hasText(m.sentDateTime) ||
    hasText(m.internetMessageId) ||
    hasText(m.conversationId) ||
    hasText(m.from?.emailAddress?.address) ||
    hasText(m.sender?.emailAddress?.address) ||
    (Array.isArray(m.toRecipients) && m.toRecipients.length > 0)
  );
}

/**
 * Re-read ONE message's envelope from the source by id — the faithful-cache repair for a delta
 * partial (#138): missing content is FILLED FROM THE SOURCE, never synthesized. Uses ENVELOPE_SELECT,
 * never BODY_SELECT, so the envelope-only footprint (ADR 0001) is unchanged. Returns null when Graph
 * 404s the id (the source no longer has the message → the caller tombstones instead of storing a
 * blank). 429/transient 5xx are already retried inside graphFetch; an exhausted 5xx becomes a
 * RetryableError (status='syncing', resume from the checkpointed cursor). Any other non-2xx is
 * terminal and secret-free (status only).
 */
async function fetchEnvelopeById(id: string, token: string): Promise<GraphMessage | null> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?$select=${ENVELOPE_SELECT}`;
  const resp = await graphFetch(url, token);
  if (resp.status === 404) return null; // source says gone
  if (is5xxTransient(resp.status)) {
    throw new RetryableError(`microsoft: envelope re-read returned ${resp.status}`);
  }
  if (!resp.ok) throw new Error(`microsoft: envelope re-read returned ${resp.status}`);
  return (await resp.json()) as GraphMessage;
}

/** Build a non-removed message → RawRecord (envelope raw + threaded folder), or a removed → tombstone. */
function toRawRecord(entry: GraphDeltaEntry, folderName: string): RawRecord {
  if (isRemoved(entry)) {
    // raw is required by the contract but the runner's deletion branch ignores it (tombstone-only).
    return { object: "message", deleted: true, externalId: String(entry.id), raw: null };
  }
  const raw = { ...entry, [FOLDER_KEY]: folderName };
  return { object: "message", externalId: String(entry.id), raw };
}

// ── Connector ────────────────────────────────────────────────────────────────────

/**
 * Microsoft Outlook connector (read-only) — mail + calendar + contacts from ONE credential. The
 * runner routes by the CONNECTION's sector (ctx.sector) + each record's `object` (ADR 0006). The
 * static sector/objectType below are placeholders for the multi-sector model (conformance S6).
 */
export class MicrosoftConnector implements Connector<MailMessageRow | CalendarEventRow | ContactRow> {
  readonly provider = "microsoft";
  readonly sector = "mail"; // placeholder; the connector branches on ctx.sector (ADR 0006)
  readonly objectType = "message"; // fallback; calendar/contact RawRecords set their own `object`

  // Poll source. 5 min balances mail freshness against Graph rate limits (retunable — policy, not code).
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 300,
    // Floor 300s (= the current default): Graph's Outlook throttle is 10,000 req/10 min per
    // app-per-mailbox (learn.microsoft.com/en-us/graph/throttling-limits) — one delta poll per 5 min
    // is orders of magnitude below it; faster adds no mail-freshness value.
    minIntervalSec: 300,
    freshnessToleranceSec: 300,
    supportsIncremental: true,
    // Microsoft's per-page Graph delta cursor (@odata.nextLink) is committed-through: every record
    // carrying it means all records up to and including it are committed, so the runner may persist
    // it mid-stream (resumable large initial syncs). (ADR 0016, opt-in.)
    cursorCommittedThrough: true,
  };

  // Read-only this wave (send/flag/move would trigger the P5 read|act split first).
  readonly actions: ActionSpec[] = [];

  /** Branch on the CONNECTION's sector: calendar/contacts have their own delta chains; else mail. */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    if (ctx.sector === "calendar") {
      yield* this.syncCalendar(ctx);
      return;
    }
    if (ctx.sector === "contacts") {
      yield* this.syncContacts(ctx);
      return;
    }
    yield* this.syncMail(ctx);
  }

  /**
   * MAIL: walk the per-folder message delta of Inbox + Sent, yielding envelope-metadata RawRecords
   * (plus `@removed` tombstones). ctx.secret is the Graph access token; ctx.cursor is a JSON map
   * { folderName: nextLink|deltaLink URL }. Per folder: resume from the stored link if present (an
   * in-progress @odata.nextLink continues paging, a final @odata.deltaLink fetches incremental
   * changes), else a fresh delta with $select; follow @odata.nextLink until @odata.deltaLink.
   *
   * INCREMENTAL CHECKPOINTING (resumable large initial syncs): the folder's entry in the running
   * cursor map advances to the latest @odata.nextLink WHILE paging (and to @odata.deltaLink on
   * completion), and that map is emitted as rec.cursor on the LAST record of EACH page. A cursor on
   * record R means "R and everything streamed before it is committed; resume from this link." The
   * runner persists connectors.cursor immediately, so a mid-enumeration 504 resumes from the last
   * page instead of restarting from zero. Memory stays O(maxpagesize) — one page is buffered at a
   * time, never the whole mailbox. Edge: a record-less page carries no cursor (nothing to ride on) —
   * not checkpointed (a bounded, cheap re-fetch on the next run); we do NOT emit a cursor-only record.
   */
  private async *syncMail(ctx: SyncContext): AsyncIterable<RawRecord> {
    const token = ctx.secret;
    if (!token) throw new Error("microsoft: missing access token");

    const cursorMap = parseCursorMap(ctx.cursor);
    const nextMap: Record<string, string> = { ...cursorMap };

    // The recency window (wave 12a) — applied to the INITIAL delta per folder. Graph carries it forward
    // in the stored nextLink/deltaLink, so follow-ups (and a 410 resync's `fresh` restart) stay windowed
    // without re-appending it. null/undefined ⇒ no filter (all history; back-compat).
    const windowSuffix = windowFilterSuffix(ctx.windowDays);

    // Per-RUN count of by-id envelope re-reads (#138), shared across folders. See MAX_HYDRATIONS_PER_RUN.
    let hydrations = 0;

    for (const folder of FOLDERS) {
      // The fresh-delta URL (WITH $select + the window filter) — both the cold-start path and the
      // 410-resync target. The window filter rides ONLY this initial request (Graph bakes it into the
      // skip/delta token); never re-appended on a stored-link follow-up.
      const fresh = `${GRAPH_BASE}/me/mailFolders/${folder.name}/messages/delta?$select=${ENVELOPE_SELECT}${windowSuffix}`;
      const stored = Object.hasOwn(cursorMap, folder.name) ? cursorMap[folder.name] : undefined;
      // Resume from the stored link ($select already baked into the skip/delta token); else a fresh
      // delta WITH $select. Never re-send $select on a follow-up link.
      let nextUrl: string | undefined = stored ?? fresh;

      let didResync = false; // at most one 410-resync per folder per run (no loop on a repeat 410)
      let pages = 0;
      while (nextUrl) {
        // Per-run re-read budget (#138), checked at the PAGE boundary so a page is never abandoned
        // half-hydrated: the previous page's committed-through cursor has already been persisted, so
        // status='syncing' + the next poll resumes exactly here. Only reached when there IS more to
        // fetch, so a run that finishes its work never trips it.
        if (hydrations >= MAX_HYDRATIONS_PER_RUN) {
          throw new RetryableError(
            `microsoft: re-read ${hydrations} delta partials this run; resuming from the checkpoint`,
          );
        }
        if (++pages > MAX_PAGES_PER_FOLDER) {
          // RetryableError (wave 12a): a residual large pull resumes as status='syncing' from the
          // incrementally-checkpointed cursor instead of wedging status='error'. Windowing makes this rare.
          throw new RetryableError(
            `microsoft: delta paging exceeded ${MAX_PAGES_PER_FOLDER} pages for one folder`,
          );
        }
        let page: GraphDeltaPage;
        try {
          page = await graphFetchPage(nextUrl, token);
        } catch (err) {
          // 410 GONE = an expired delta/skip token. Drop this folder's stored checkpoint and restart
          // a FRESH delta with the initial $select (Graph's documented resync). Delta is cumulative,
          // so a fresh delta fully recovers — never wedge the connection in status='error'. Only one
          // resync per folder: a 410 on the fresh delta itself is a real error and propagates.
          if (err instanceof GraphGoneError && !didResync) {
            delete nextMap[folder.name];
            nextUrl = fresh;
            didResync = true;
            pages = 0;
            continue;
          }
          throw err;
        }
        // Buffer this page's records (O(maxpagesize) — never the whole mailbox). Any entry that is
        // not a COMPLETE envelope is Graph's documented UPDATE shape (#138) and is re-read from the
        // source by id here — BEFORE the checkpoint advances and before anything is yielded, so a
        // failed re-read leaves this page uncommitted and the next run replays it.
        const pageRecs: RawRecord[] = [];
        for (const entry of page.value ?? []) {
          if (isRemoved(entry)) {
            pageRecs.push(toRawRecord(entry, folder.name));
            continue;
          }
          const msg = entry as GraphMessage;
          if (isCompleteEnvelope(msg)) {
            pageRecs.push(toRawRecord(msg, folder.name));
            continue;
          }
          // A partial with no usable id cannot be re-read OR applied — loud, never a silent skip.
          if (typeof msg.id !== "string" || msg.id === "") {
            throw new Error("microsoft: delta entry has no id; cannot re-read a partial payload");
          }
          hydrations++;
          const full = await fetchEnvelopeById(msg.id, token);
          if (full == null) {
            // 404 — the source no longer has this message. A tombstone (ADR 0004) is the faithful
            // answer; a blank row is not. Matches 0 rows harmlessly if we never stored it.
            pageRecs.push({ object: "message", deleted: true, externalId: msg.id, raw: null });
            continue;
          }
          // The re-read is the source's own representation; keep the folder the DELTA attributed it
          // to (the by-id resource carries only a GUID parentFolderId, and a message that moved
          // between synced folders is re-reported by the target folder's own delta next round).
          pageRecs.push(toRawRecord(full, folder.name));
        }

        // Advance this folder's resumable checkpoint BEFORE emitting, so the cursor we attach is the
        // link to resume FROM (everything in this page is committed once these records are applied).
        const np = page["@odata.nextLink"];
        if (np) {
          nextMap[folder.name] = np; // in-progress skiptoken — $select stays baked in
          nextUrl = np;
        } else {
          const dl = page["@odata.deltaLink"];
          if (dl) nextMap[folder.name] = dl; // final page — persist this folder's deltaLink
          nextUrl = undefined;
        }

        // Emit the cursor map on the LAST record of this page (a record-less page can't carry one).
        if (pageRecs.length > 0) {
          pageRecs[pageRecs.length - 1].cursor = JSON.stringify(nextMap);
          for (const rec of pageRecs) yield rec;
        }
      }
    }
  }

  /**
   * CALENDAR: GET /me/calendarView/delta over a frozen UTC window (the only v1.0 events delta;
   * recurrences arrive pre-expanded as occurrence/exception instances). ctx.cursor is JSON
   * {ws, we, link}. Resume from the stored link UNLESS the window needs re-anchoring (we − now <
   * 180d) or the cursor is missing/garbled — then start a FRESH chain on [now−365d, now+365d].
   * A 410 GONE or a 4xx syncStateNotFound mid-chain also restarts fresh (once per run). calendarView
   * delta supports no $select — full payloads, all of it into raw. `@removed` → tombstone
   * UNCONDITIONALLY (Graph documents out-of-window @removed noise; a tombstone UPDATE matching 0 rows
   * is harmless). Ignores ctx.windowDays by construction (the ADR-0017 mail window; the runner passes
   * null for non-mail sectors).
   *
   * WINDOW SWEEP: when a fresh chain's initial request AND its terminating deltaLink both happen in
   * THIS run (complete enumeration in one invocation), reconcileObjectSnapshot window-scoped to
   * starts_at ∈ [ws, we] catches deletions the dead chain missed, leaving rows outside the window as
   * accumulated history. A chain resumed from a persisted mid-stream nextLink NEVER sweeps (partial
   * soid set = mass-tombstone hazard); the next re-anchor catches up. Cursor rides the last record of
   * each page (committed-through), exactly like mail.
   */
  private async *syncCalendar(ctx: SyncContext): AsyncIterable<RawRecord> {
    const token = ctx.secret;
    if (!token) throw new Error("microsoft: missing access token");

    const freshUrl = (ws: string, we: string): string =>
      `${GRAPH_BASE}/me/calendarView/delta?startDateTime=${encodeURIComponent(ws)}&endDateTime=${encodeURIComponent(we)}`;
    const newWindow = (): { ws: string; we: string } => ({
      ws: new Date(Date.now() - CAL_WINDOW_PAST_MS).toISOString(),
      we: new Date(Date.now() + CAL_WINDOW_FUTURE_MS).toISOString(),
    });

    const stored = parseCalendarCursor(ctx.cursor);
    let ws: string;
    let we: string;
    let url: string | undefined;
    // Fresh chain when: no/garbled cursor, or RE-ANCHOR (the stored window's future headroom fell
    // under 180d — Graph froze the bounds into the token, so a rolling window needs a new chain).
    let freshChain: boolean;
    if (stored != null && Date.parse(stored.we) - Date.now() >= CAL_REANCHOR_HEADROOM_MS) {
      ({ ws, we } = stored);
      url = stored.link;
      freshChain = false;
    } else {
      ({ ws, we } = newWindow());
      url = freshUrl(ws, we);
      freshChain = true;
    }

    // Sweep bookkeeping: eligible ONLY when the chain's initial request was issued THIS run; the soid
    // set + fence restart with each fresh chain (a 410 restart resets them — the dead chain's partial
    // enumeration must never feed the sweep).
    let sweepEligible = freshChain;
    let chainStartedAt = new Date();
    let soids = new Set<string>();
    let completed = false; // terminating deltaLink seen THIS run

    let didResync = false; // at most one fresh-chain restart per run (no loop on a repeat 410)
    let pages = 0;
    while (url) {
      if (++pages > MAX_PAGES_PER_FOLDER) {
        throw new RetryableError(
          `microsoft: calendar delta paging exceeded ${MAX_PAGES_PER_FOLDER} pages`,
        );
      }
      let page: GraphGenericPage;
      try {
        page = await graphFetchGenericPage(url, token);
      } catch (err) {
        // 410 GONE (the Location restart URL means "make a new initial call") or syncStateNotFound:
        // restart ONE fresh chain on a re-anchored window. A repeat failure propagates (real error).
        if ((err instanceof GraphGoneError || err instanceof GraphSyncStateLostError) && !didResync) {
          didResync = true;
          pages = 0;
          ({ ws, we } = newWindow());
          url = freshUrl(ws, we);
          sweepEligible = true;
          chainStartedAt = new Date();
          soids = new Set<string>();
          continue;
        }
        throw err;
      }

      const pageRecs: RawRecord[] = [];
      for (const entry of page.value ?? []) {
        if (isRemoved(entry)) {
          // Unconditional tombstone — out-of-window @removed noise matches 0 rows, harmlessly.
          pageRecs.push({
            object: "calendar_event",
            externalId: String(entry.id),
            deleted: true,
            raw: null,
          });
        } else {
          const ev = entry as GraphEvent;
          soids.add(String(ev.id));
          pageRecs.push({ object: "calendar_event", externalId: String(ev.id), raw: ev });
        }
      }

      const np = page["@odata.nextLink"];
      const dl = page["@odata.deltaLink"];
      let checkpoint: string | undefined;
      if (np) {
        checkpoint = np;
        url = np;
      } else {
        if (dl) {
          checkpoint = dl;
          completed = true;
        }
        url = undefined;
      }

      // Committed-through cursor rides the LAST record of each page (a record-less page can't carry one).
      if (pageRecs.length > 0) {
        if (checkpoint) {
          pageRecs[pageRecs.length - 1].cursor = JSON.stringify({ ws, we, link: checkpoint });
        }
        for (const rec of pageRecs) yield rec;
      }
    }

    // Complete one-run fresh chain → window-scoped sweep. (Generator code after the last yield runs
    // once the consumer has upserted every yielded record; the ingested_at < chainStartedAt fence
    // additionally protects rows written during this run.)
    if (sweepEligible && completed) {
      await reconcileObjectSnapshot(ctx.connectionId, "calendar", "calendar_event", soids, chainStartedAt, {
        column: "starts_at",
        from: new Date(ws),
        to: new Date(we),
      });
    }
  }

  /**
   * CONTACTS: the documented folder-scoped delta /me/contactFolders/{id}/contacts/delta over the
   * DEFAULT contacts folder, discovered by probe (GET /me/contacts?$top=1&$select=parentFolderId →
   * value[0].parentFolderId). An empty mailbox yields no records and NO cursor — the probe retries
   * next poll (nothing to sync anyway). ctx.cursor is JSON {folderId, link}. $select rides the
   * INITIAL request only (baked into the token thereafter, mail-style). `@removed` → tombstone;
   * 410 / syncStateNotFound → fresh chain (folder ids don't expire — the stored folderId is reused).
   * A complete one-run fresh chain sweeps the whole folder via reconcileObjectSnapshot (no window:
   * the chain enumerates the entire folder). Photos are separate binary endpoints — skipped.
   */
  private async *syncContacts(ctx: SyncContext): AsyncIterable<RawRecord> {
    const token = ctx.secret;
    if (!token) throw new Error("microsoft: missing access token");

    const stored = parseContactsCursor(ctx.cursor);
    let folderId = stored?.folderId;
    if (folderId == null) {
      // Probe the default folder from any one contact's parentFolderId.
      const resp = await graphFetch(`${GRAPH_BASE}/me/contacts?$top=1&$select=parentFolderId`, token);
      if (is5xxTransient(resp.status)) {
        throw new RetryableError(`microsoft: contacts probe returned ${resp.status}`);
      }
      if (!resp.ok) throw new Error(`microsoft: contacts probe returned ${resp.status}`);
      const body = (await resp.json()) as { value?: Array<{ parentFolderId?: string }> } | null;
      const parent = body?.value?.[0]?.parentFolderId;
      if (typeof parent !== "string" || parent === "") {
        return; // empty mailbox: no records, no cursor — clean retry next poll
      }
      folderId = parent;
    }

    const freshUrl = `${GRAPH_BASE}/me/contactFolders/${encodeURIComponent(folderId)}/contacts/delta?$select=${CONTACT_SELECT}`;
    let url: string | undefined = stored?.link ?? freshUrl;

    // Sweep-eligible ONLY when the chain's initial request was issued THIS run (one-run rule).
    let sweepEligible = stored?.link == null;
    let chainStartedAt = new Date();
    let soids = new Set<string>();
    let completed = false;

    let didResync = false;
    let pages = 0;
    while (url) {
      if (++pages > MAX_PAGES_PER_FOLDER) {
        throw new RetryableError(
          `microsoft: contacts delta paging exceeded ${MAX_PAGES_PER_FOLDER} pages`,
        );
      }
      let page: GraphGenericPage;
      try {
        page = await graphFetchGenericPage(url, token);
      } catch (err) {
        if ((err instanceof GraphGoneError || err instanceof GraphSyncStateLostError) && !didResync) {
          didResync = true;
          pages = 0;
          url = freshUrl; // an initial request again — $select re-sent, folder id reused
          sweepEligible = true;
          chainStartedAt = new Date();
          soids = new Set<string>();
          continue;
        }
        throw err;
      }

      const pageRecs: RawRecord[] = [];
      for (const entry of page.value ?? []) {
        if (isRemoved(entry)) {
          pageRecs.push({
            object: "contact",
            externalId: String(entry.id),
            deleted: true,
            raw: null,
          });
        } else {
          const contact = entry as GraphContact;
          soids.add(String(contact.id));
          pageRecs.push({ object: "contact", externalId: String(contact.id), raw: contact });
        }
      }

      const np = page["@odata.nextLink"];
      const dl = page["@odata.deltaLink"];
      let checkpoint: string | undefined;
      if (np) {
        checkpoint = np;
        url = np;
      } else {
        if (dl) {
          checkpoint = dl;
          completed = true;
        }
        url = undefined;
      }

      if (pageRecs.length > 0) {
        if (checkpoint) {
          pageRecs[pageRecs.length - 1].cursor = JSON.stringify({ folderId, link: checkpoint });
        }
        for (const rec of pageRecs) yield rec;
      }
    }

    // Complete one-run fresh chain → full-folder sweep (no window: the chain enumerated it all).
    if (sweepEligible && completed) {
      await reconcileObjectSnapshot(ctx.connectionId, "contacts", "contact", soids, chainStartedAt);
    }
  }

  /** Route on rec.object: calendar_event/contact → their normalizers; default → the mail envelope. */
  normalize(rec: RawRecord): MailMessageRow | CalendarEventRow | ContactRow {
    if (rec.object === "calendar_event") return normalizeCalendarEvent(rec);
    if (rec.object === "contact") return normalizeContact(rec);
    return this.normalizeMail(rec);
  }

  /**
   * Map a Graph envelope record → the REGISTRY `mail` scalars (never `id`/`raw`).
   *
   * FAIL-CLOSED (#138): this mapping is TOTAL — every absent Graph field becomes null — and the
   * runner's upsert replaces every non-key column with the normalized value, so normalizing a delta
   * PARTIAL here would blank a faithfully-cached message (or insert an empty one). syncMail re-reads
   * such payloads from the source before yielding them; if one still reaches this point it is a shape
   * we cannot safely apply, and that is an ERROR, never a silent hollow write. Secret-free.
   */
  private normalizeMail(rec: RawRecord): MailMessageRow {
    const m = rec.raw as GraphMessage;
    if (m == null || !hasEnvelopeContent(m)) {
      throw new Error(
        "microsoft: refusing to store a content-hollow mail row (delta partial payload, not a message)",
      );
    }
    const folderName = (rec.raw as Record<string, unknown>)[FOLDER_KEY];
    const folderKey = typeof folderName === "string" ? folderName : "";
    const folder = Object.hasOwn(FOLDER_ENUM, folderKey) ? FOLDER_ENUM[folderKey] : null;
    return {
      source_object_id: String(m.id),
      thread_id: m.conversationId ?? null,
      message_id_header: m.internetMessageId ?? null,
      from_address: m.from?.emailAddress?.address ?? null,
      from_name: m.from?.emailAddress?.name ?? null,
      sender_address: m.sender?.emailAddress?.address ?? null,
      subject: m.subject ?? null,
      snippet: m.bodyPreview ?? null, // preview only — NOT the body
      sent_at: m.sentDateTime ?? null,
      received_at: m.receivedDateTime ?? null, // primaryTime / default sort
      is_read: typeof m.isRead === "boolean" ? m.isRead : null,
      has_attachments: typeof m.hasAttachments === "boolean" ? m.hasAttachments : null,
      folder,
      importance: m.importance ?? null,
    };
  }

  /**
   * Route on rec.object: calendar_event → {graph_event_id, ical_uid?}; contact →
   * {graph_contact_id, email?}; mail (default) → cross-provider-stable { message_id_header } when
   * internetMessageId is present, else { graph_id }.
   */
  strongKeys(rec: RawRecord): Record<string, string> {
    if (rec.object === "calendar_event") {
      const e = rec.raw as GraphEvent | null;
      const keys: Record<string, string> = { graph_event_id: String(e?.id ?? rec.externalId) };
      if (typeof e?.iCalUId === "string" && e.iCalUId !== "") keys.ical_uid = e.iCalUId;
      return keys;
    }
    if (rec.object === "contact") {
      const c = rec.raw as GraphContact | null;
      const keys: Record<string, string> = { graph_contact_id: String(c?.id ?? rec.externalId) };
      const email = c?.emailAddresses?.[0]?.address;
      if (typeof email === "string" && email !== "") keys.email = email;
      return keys;
    }
    const m = rec.raw as GraphMessage | undefined;
    const imi = m != null && typeof m.internetMessageId === "string" ? m.internetMessageId : null;
    if (imi) return { message_id_header: imi };
    const id = m != null && m.id != null ? String(m.id) : rec.externalId;
    return { graph_id: id };
  }

  /**
   * The fetch_live {id} drill, routed per the CONNECTION's sector (ctx.sector): calendar →
   * GET /me/events/{id}; contacts → GET /me/contacts/{id}; mail (default) →
   * GET /me/messages/{id}?$select=...,body → the raw payload incl. body:{contentType,content}.
   * Stores NOTHING (H8/S2; mail is footprint-limited, ADR 0001; calendar/contact drills are pure
   * reads too). Returns null when Graph 404s the id (the source says the object is gone). 429 is
   * retried (bounded); a persistent throttle / non-2xx throws a secret-free error.
   */
  async fetchRecordLive(ctx: SyncContext, sourceObjectId: string): Promise<unknown> {
    const token = ctx.secret;
    if (!token) throw new Error("microsoft: missing access token");
    let url: string;
    let what: string;
    if (ctx.sector === "calendar") {
      url = `${GRAPH_BASE}/me/events/${encodeURIComponent(sourceObjectId)}`;
      what = "event";
    } else if (ctx.sector === "contacts") {
      url = `${GRAPH_BASE}/me/contacts/${encodeURIComponent(sourceObjectId)}`;
      what = "contact";
    } else {
      url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(sourceObjectId)}?$select=${BODY_SELECT}`;
      what = "message";
    }
    const resp = await graphFetch(url, token);
    if (resp.status === 404) return null; // source says gone
    if (!resp.ok) throw new Error(`microsoft: ${what} fetch returned ${resp.status}`);
    return await resp.json();
  }

  /** Read-only: no actions on the source side this wave. */
  async execute(): Promise<ActionResult> {
    throw new Error("MicrosoftConnector has no actions (mail/calendar/contacts are read-only this wave)");
  }
}
