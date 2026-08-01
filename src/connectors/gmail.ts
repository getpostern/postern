// Gmail mail connector — read-only mail over IMAP (imapflow) with a Gmail APP-PASSWORD (ADR 0002 —
// never OAuth for self-host personal Gmail). Per-folder CONDSTORE/QRESYNC incremental sync caches
// the RFC-5322 ENVELOPE only (ADR 0001) — sender/subject/dates/flags — never the body or attachment
// content. The body is fetched on demand by `folder:uid` via fetchRecordLive (stores NOTHING).
// QRESYNC `VANISHED` UIDs become ADR-0004 tombstones; a later live sighting resurrects. Read-only:
// actions:[] and execute() throws.
//
// RECENCY WINDOW (ADR 0017, day-15 fast-follow): when ctx.windowDays is set (runner: mail-sector
// default 180), the full-resync branch bounds the backfill with a server-side `UID SEARCH SINCE
// (windowStart − 1d)` and fetches EXACTLY the returned UID set (range-compacted, ≤1000 UIDs per
// sequential fetch command); the incremental CHANGEDSINCE path stays one command and drops
// out-of-window records client-side. Deletion reality: Gmail advertises CONDSTORE without QRESYNC,
// so VANISHED likely never fires against real Gmail — a DAILY windowed UID census (the same SEARCH)
// is diffed via the window-scoped reconcileObjectSnapshot to tombstone missed deletions. The census
// clock rides a reserved `_census:{at}` key in the cursor JSON. windowDays null/≤0 ⇒ the historical
// unbounded `1:*` behavior exactly (no search, no sweep). The window bounds FETCH, not retention:
// out-of-window rows are never tombstoned or pruned (they sit outside the sweep's scope by
// construction) and stay reachable on demand via fetchRecordLive.
//
// BLOCK fold (2026-07-11, adversarial review): (1) the sweep is ALSO withheld when a folder key
// present in the stored cursor map is absent from this run's discovered folder set (a vanished
// folder is a census skip laundered through discovery — sweeping would falsely tombstone its rows);
// (2) the sweep passes resurrectPresent:true — a census sighting clears a stale tombstone (ADR 0004,
// self-healing); (3) a failed incremental census emits ONE masked console.warn (folder enum only,
// zero error detail); (4) a census SEARCH returning > 200,000 UIDs is treated as incomplete (masked
// warn, no sweep, no stamp) — a hostile/buggy result must never drive an unbounded soid set into
// the sweep.
//
// SECURITY: ctx.secret is the Gmail app-password and ctx.username the gmail address — both are
// CREDENTIALS. `logger:false` is REQUIRED (imapflow logs via pino otherwise — the app-password/body
// must never hit logs). Every connect/fetch failure throws a clean, secret-free Error (no token,
// username, folder body, or original IMAP message echoed). All diagnostics go to stderr; we emit none.

import { ImapFlow } from "imapflow";
import type {
  ImapFlowOptions,
  ListResponse,
  MailboxObject,
  FetchMessageObject,
  FetchQueryObject,
  FetchOptions,
  MessageEnvelopeObject,
  MessageStructureObject,
  ExpungeEvent,
  SearchObject,
} from "imapflow";
import { reconcileObjectSnapshot } from "../sync/runner.js";
import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";

// ── IMAP constants ───────────────────────────────────────────────────────────────
const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;

// Fixed synced set this wave (operator-decided: INBOX + Sent only, matching the Outlook connector).
// INBOX is the well-known root path; the Sent path is DISCOVERED via the RFC-6154 SPECIAL-USE flag
// (Gmail localizes "[Gmail]/Sent Mail" — never hardcode it).
const SPECIAL_USE_INBOX = "\\Inbox";
const SPECIAL_USE_SENT = "\\Sent";

// Neutral REGISTRY `folder` enum — the connector tags each record with its enum; normalize() maps it
// through this whitelist (Object.hasOwn lookup) so a stray key resolves to null, never a SQL surprise.
const FOLDER_ENUM: Record<string, string> = { inbox: "inbox", sent: "sent" };

// Synthetic key threaded into the stored envelope `raw` so normalize() — a pure function of a single
// record — knows the folder enum (UID is per-folder; the message itself carries no folder). Mirrors
// the Microsoft `__pci_folder` / SimpleFIN `__pci_parent` pattern: ADDS a key, original fields stay.
const FOLDER_KEY = "__pci_folder";

// Envelope-metadata fetch (ADR 0001 — never the body). `threadId`/`labels` request the Gmail
// X-GM-EXT-1 fields; `emailId` (X-GM-MSGID) is returned automatically when the server supports it.
const ENVELOPE_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  bodyStructure: true,
  threadId: true,
  labels: true,
};

// The by-id body drill (fetchRecordLive) — the full RFC822 source, fetched live, stored NOWHERE.
const BODY_QUERY: FetchQueryObject = {
  uid: true,
  source: true,
  envelope: true,
  bodyStructure: true,
};

const SEEN_FLAG = "\\Seen";

// ── Recency window / daily census constants (ADR 0017 fast-follow) ─────────────────
const DAY_MS = 24 * 60 * 60 * 1000;

// The reserved top-level cursor key carrying the daily deletion-census clock: `_census: {at: <ISO>}`.
// Namespace-safe: folder keys come from the fixed FOLDER_ENUM whitelist, so the reserved key can
// never collide with a folder entry; parseCursor tolerates its absence and garbage (→ census due).
const CENSUS_KEY = "_census";

// Census cadence (operator-set, 2026-07-11: DAILY). Incremental runs re-census only when ≥24h have
// passed since the last COMPLETED census+sweep; full-resync folders always census (the backfill
// search IS the census — zero extra cost). Deletion staleness ≤ ~24h; new-mail freshness stays at
// the poll cadence.
const CENSUS_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Max UIDs per windowed-backfill fetch command. Chunks are SEQUENTIAL — no IMAP command is ever
// issued while a fetch generator is mid-stream (documented imapflow deadlock); each chunk's
// generator fully drains before the next command.
const MAX_UIDS_PER_FETCH = 1000;

// Census sanity cap (BLOCK fold #4, security LOW): a 180-day window with > 200,000 messages in one
// folder is implausible — a hostile/buggy SEARCH result that size marks the folder's census
// incomplete (masked warn; no sweep, no stamp) rather than driving an unbounded soid set into the
// sweep. The backfill fetch still proceeds on the full-resync branch (the window bounds FETCH —
// data is never silently dropped); only the census accounting is refused.
const CENSUS_MAX_UIDS = 200_000;

/** BLOCK fold #3/#4 — the ONE masked census warn: folder enum only, ZERO error detail (an IMAP/
 * library error may embed protocol strings; the enum comes from the fixed FOLDER_ENUM whitelist). */
function warnCensusWithheld(folderEnum: string, reason: "failed" | "oversized" | "vanished"): void {
  const detail =
    reason === "vanished"
      ? `folder '${folderEnum}' vanished from discovery`
      : `census ${reason} for folder '${folderEnum}'`;
  console.warn(`gmail: ${detail} — sweep withheld this run`);
}

// ── Injectable client seam ─────────────────────────────────────────────────────────
// imapflow's client is a class (not `fetch`), so the test seam is a factory the connector calls
// once per run. `ImapClient` is the exact structural subset we use; the default factory wraps the
// real `ImapFlow`. `mailboxOpen` carries the QRESYNC params (changedSince/uidValidity) the real
// SELECT command accepts (RFC 7162) but the published `MailboxOpenOptions` type omits.

export interface MailboxOpenQresyncOptions {
  readOnly?: boolean;
  /** QRESYNC: the last-known HIGHESTMODSEQ (string). Triggers VANISHED (EARLIER) on open. */
  changedSince?: string;
  /** QRESYNC: the last-known UIDVALIDITY. VANISHED only flows when this matches the live value. */
  uidValidity?: bigint;
}

export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<ListResponse[]>;
  mailboxOpen(path: string, options?: MailboxOpenQresyncOptions): Promise<MailboxObject>;
  /**
   * UID SEARCH over the open mailbox (the imapflow subset; the windowed backfill/census issues
   * `{since}, {uid:true}` → ascending UID array). imapflow resolves `false` on failure — the
   * connector treats that as a failed search (backfill: run fails masked; census: sweep withheld).
   */
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>;
  fetch(
    range: string,
    query: FetchQueryObject,
    options?: FetchOptions,
  ): AsyncIterableIterator<FetchMessageObject>;
  fetchOne(
    seq: string,
    query: FetchQueryObject,
    options?: FetchOptions,
  ): Promise<FetchMessageObject | false>;
  on(event: "expunge", listener: (e: ExpungeEvent) => void): unknown;
}

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClient;

/** Build the imapflow connection options. `logger:false` is REQUIRED (no pino → no secret in logs). */
function buildClientOptions(user: string, pass: string): ImapFlowOptions {
  return {
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
    qresync: true,
  };
}

/** Default factory: the real imapflow client. Tests inject a fake via the constructor. */
function defaultClientFactory(options: ImapFlowOptions): ImapClient {
  return new ImapFlow(options);
}

// ── Stored envelope `raw` shape (envelope-level only — NEVER the body) ──────────────
interface GmailEnvelopeRaw {
  uid: number;
  envelope: MessageEnvelopeObject;
  flags: string[];
  internalDate: string | null; // ISO; the INTERNALDATE → received_at (primaryTime)
  bodyStructure?: MessageStructureObject; // MIME tree (structure metadata; no content) → has_attachments
  threadId?: string; // X-GM-THRID
  emailId?: string; // X-GM-MSGID
  labels: string[]; // X-GM-LABELS — store-only (NOT a REGISTRY column)
  [FOLDER_KEY]: string; // neutral folder enum
}

/** A folder's persisted CONDSTORE state (BigInts carried as strings — JSON can't hold BigInt). */
interface FolderCursor {
  uidValidity: string;
  modseq: string;
}

// ── Helpers (module-private) ────────────────────────────────────────────────────────

/** A Date/string IMAP timestamp → ISO 8601; null / unparseable → null. */
function toIso(v: Date | string | undefined | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * has_attachments from the BODYSTRUCTURE MIME tree: any attachment-disposition (or non-inline) leaf.
 * A multipart node recurses into its children; a leaf with disposition "attachment" — or any
 * disposition that isn't "inline" — counts. A plain text/plain message (no disposition) → false.
 */
function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (node == null) return false;
  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    return node.childNodes.some(hasAttachments);
  }
  const disp = typeof node.disposition === "string" ? node.disposition.toLowerCase() : null;
  return disp != null && disp !== "inline";
}

/** The parsed cursor: the per-folder CONDSTORE map + the daily deletion-census clock. */
interface ParsedCursor {
  folders: Record<string, FolderCursor>;
  /**
   * ISO timestamp of the last COMPLETED census+sweep (`_census.at`). null = census due immediately
   * (covers every pre-window cursor, a garbled/absent stamp, and a fresh post-setSyncWindow cursor).
   */
  censusAt: string | null;
}

/**
 * Parse the per-folder CONDSTORE cursor map; a missing/garbled cursor starts fresh (full resync).
 * The reserved `_census` top-level key is NEVER a folder entry: it is extracted into `censusAt`
 * (tolerating absence and any garbage shape → null = census due) and skipped by folder iteration.
 */
function parseCursor(cursor: string | undefined): ParsedCursor {
  const out: ParsedCursor = { folders: {}, censusAt: null };
  if (!cursor) return out;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k === CENSUS_KEY) {
          // Reserved daily-census clock — never treated as a folder, garbage-tolerant.
          if (v != null && typeof v === "object" && !Array.isArray(v)) {
            const at = (v as Record<string, unknown>).at;
            if (typeof at === "string" && Number.isFinite(Date.parse(at))) out.censusAt = at;
          }
          continue;
        }
        if (v != null && typeof v === "object" && !Array.isArray(v)) {
          const o = v as Record<string, unknown>;
          if (typeof o.uidValidity === "string" && typeof o.modseq === "string") {
            out.folders[k] = { uidValidity: o.uidValidity, modseq: o.modseq };
          }
        }
      }
    }
  } catch {
    // garbled cursor → fall through to a fresh delta (and a due census)
  }
  return out;
}

/**
 * Compact an ascending, deduped UID array into IMAP UID-set range strings ("101:103,107"), with at
 * most `maxPerChunk` UIDs per chunk — the windowed backfill fetches EXACTLY the searched set, never
 * `1:*`, and never more than MAX_UIDS_PER_FETCH UIDs in one fetch command. Empty input → no chunks
 * (an empty SEARCH result is a complete, legitimate census: zero in-window messages).
 */
function compactUidRanges(uids: number[], maxPerChunk: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < uids.length; i += maxPerChunk) {
    const slice = uids.slice(i, i + maxPerChunk);
    const parts: string[] = [];
    let start = slice[0];
    let prev = slice[0];
    for (let j = 1; j < slice.length; j++) {
      const u = slice[j];
      if (u === prev + 1) {
        prev = u;
        continue;
      }
      parts.push(start === prev ? String(start) : `${start}:${prev}`);
      start = prev = u;
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    chunks.push(parts.join(","));
  }
  return chunks;
}

/** Build an envelope RawRecord — envelope raw + threaded folder enum (NEVER the body). */
function toRawRecord(msg: FetchMessageObject, folderEnum: string): RawRecord {
  const raw: GmailEnvelopeRaw = {
    uid: msg.uid,
    envelope: msg.envelope ?? {},
    flags: msg.flags ? Array.from(msg.flags) : [],
    internalDate: toIso(msg.internalDate),
    bodyStructure: msg.bodyStructure,
    threadId: msg.threadId,
    emailId: msg.emailId,
    labels: msg.labels ? Array.from(msg.labels) : [],
    [FOLDER_KEY]: folderEnum,
  };
  return { object: "message", externalId: `${folderEnum}:${msg.uid}`, raw };
}

/**
 * The auth-refusal message — the likeliest stranger failure on this card is a wrong 16-character
 * paste, and it used to be indistinguishable from a network blip ("gmail: sync failed"; #121).
 * OUR OWN WORDS ONLY: imapflow's error carries the server's response text, which is never echoed
 * (it is provider-controlled and can embed protocol strings). The remedy is the G1-proven path:
 * 2-Step Verification first (the app-passwords page does not exist without it — watched live),
 * then the DIRECT URL, because no amount of searching the Security page finds it.
 * Classified TERMINAL in src/sync/retryability.ts (a dead credential needs a human), and must stay
 * under maskError's 500-char cap. EXPORTED as the one seam the classification and pipe tests
 * import — drift here must break those tests red, not silently un-match the terminal vocabulary.
 * The CONTENT is pinned as a literal in gmail.test.ts (importing there would be a tautology).
 */
export const AUTH_REFUSED_MESSAGE =
  "gmail: sign-in refused — Gmail did not accept the address or app password. Turn on " +
  "2-Step Verification first (the app-passwords page does not exist without it), then create a " +
  "fresh app password at myaccount.google.com/apppasswords and reconnect with it.";

/**
 * Did the IMAP server REFUSE the presented credentials — as opposed to any other auth-adjacent
 * failure? `authenticationFailed: true` alone is NOT that signal: it is a CLASS FIELD on
 * imapflow's `AuthenticationFailure` (lib/tools.js:47), which is also thrown for "Already logged
 * out", "Please configure the login", "Login is disabled", "No password configured" and "No
 * matching authentication method" (lib/imap-flow.js:1441,1450,1472,1477,1491) — none of which mean
 * the app password is bad, and telling the user to rotate a WORKING app password would revoke it
 * at Google. A real server rejection goes through commands/login.js:38 / authenticate.js
 * handleAuthError, which ALSO attach `serverResponseCode` (e.g. "AUTHENTICATIONFAILED") and/or a
 * string `response` (the server's refusal text; `getErrorText` yields `false`, not a string, when
 * there was no server response). So the predicate requires the class field PLUS server evidence.
 * Duck-typed by property, never `instanceof`/name (prototypes do not survive every boundary, and
 * the bare class NAME is exactly the over-match).
 */
function isImapAuthRefusal(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  if ((err as { authenticationFailed?: unknown }).authenticationFailed !== true) return false;
  const code = (err as { serverResponseCode?: unknown }).serverResponseCode;
  if (typeof code === "string" && code.toUpperCase() === "AUTHENTICATIONFAILED") return true;
  const response = (err as { response?: unknown }).response;
  return typeof response === "string" && response.length > 0;
}

/** Best-effort logout; never lets a teardown failure escape (and never logs a secret). */
async function safeLogout(client: ImapClient): Promise<void> {
  try {
    await client.logout();
  } catch {
    // best-effort — the short-lived connection is being discarded anyway
  }
}

// ── Connector ────────────────────────────────────────────────────────────────────────

/**
 * The 15 REGISTRY `mail` scalars minus `id` (the runner injects `id`). Shape-identical to the
 * Microsoft connector's MailMessageRow — Gmail leaves `snippet`/`importance` null (IMAP has no
 * snippet; importance is an Outlook-only enrichment).
 */
export interface MailMessageRow {
  source_object_id: string; // "<folderEnum>:<uid>" (UID is per-folder + UIDVALIDITY)
  thread_id: string | null; // X-GM-THRID
  message_id_header: string | null; // ENVELOPE.messageId (RFC 5322 Message-ID)
  from_address: string | null; // ENVELOPE.from[0].address
  from_name: string | null; // ENVELOPE.from[0].name
  sender_address: string | null; // ENVELOPE.sender[0].address when ≠ from, else null
  subject: string | null;
  snippet: string | null; // null in V0 (IMAP has no snippet; a bounded BODY.PEEK is a follow-up)
  sent_at: string | null; // ENVELOPE.date
  received_at: string | null; // INTERNALDATE (primaryTime / default sort)
  is_read: boolean | null; // FLAGS has \Seen
  has_attachments: boolean | null; // derived from BODYSTRUCTURE
  folder: string | null; // neutral enum: inbox | sent
  importance: string | null; // null (Outlook-only enrichment)
}

/** Gmail IMAP mail connector (read-only; envelope-only cache; body on demand). */
export class GmailConnector implements Connector<MailMessageRow> {
  readonly provider = "gmail";
  readonly sector = "mail";
  readonly objectType = "message"; // matches REGISTRY mail.object

  // Poll source (no IDLE). 10 min stays far under Gmail's ~15-concurrent-conn / ~2.5GB-day caps.
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 600,
    // Floor 300s: Gmail IMAP's caps are 15 simultaneous connections and ~2,500MB/day download
    // (support.google.com/mail/answer/7126229 + Workspace "Gmail bandwidth limits") — one short-lived
    // sequential envelope poll per 5 min is well inside both.
    minIntervalSec: 300,
    freshnessToleranceSec: 600,
    supportsIncremental: true,
  };

  // Read-only this wave (send/flag/move would trigger the P5 read|act split first).
  readonly actions: ActionSpec[] = [];

  private readonly makeClient: ImapClientFactory;

  /** `makeClient` is injectable for tests; production uses the real imapflow client. */
  constructor(makeClient: ImapClientFactory = defaultClientFactory) {
    this.makeClient = makeClient;
  }

  /**
   * Walk INBOX + Sent per-folder CONDSTORE/QRESYNC, yielding envelope-metadata RawRecords (+ VANISHED
   * tombstones). ctx.username/ctx.secret authenticate; ctx.cursor is a JSON map
   * { folderEnum: {uidValidity, modseq} } plus the reserved `_census: {at}` daily-sweep clock.
   * Per folder, sequentially:
   *   - open with QRESYNC params when a cursor exists (→ VANISHED EARLIER on open);
   *   - UIDVALIDITY mismatch (or first run) → FULL resync — windowed (ctx.windowDays > 0): UID
   *     SEARCH SINCE (windowStart − 1d pad) then fetch EXACTLY that UID set (range-compacted,
   *     ≤1000 UIDs per sequential fetch command); unwindowed: the historical `1:*` fetch;
   *   - else INCREMENTAL: fetch("1:*", …, changedSince:<storedModseq>) — one pass catches new
   *     messages AND flag changes (\Seen → is_read); out-of-window messages are skipped client-side.
   * DAILY deletion census: the windowed SEARCH doubles as the census. It runs per folder on every
   * windowed full-resync (free) and on incremental runs when ≥24h past `_census.at`. When AND ONLY
   * when every discovered folder's census completed THIS run, missed deletions are swept via the
   * window-scoped reconcileObjectSnapshot (resurrectPresent: a census sighting clears a stale
   * tombstone) and `_census.at` is stamped; a failed/partial/oversized census — or a folder present
   * in the stored cursor but missing from discovery (the folder-vanish guard) — never sweeps and
   * never advances the clock (partial-census mass-tombstone is the hazard).
   * The combined cursor map rides the LAST record (one-record look-behind; O(1) buffer). ONE
   * short-lived connection per run, logout() in finally; no IDLE.
   */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    const username = ctx.username;
    const pass = ctx.secret;
    if (!username || !pass) throw new Error("gmail: missing app-password or username");

    // Window derivation (per run — the window slides forward every poll, matching Outlook).
    // windowDays null/undefined/≤0 ⇒ today's behavior EXACTLY: unbounded 1:*, no SEARCH, no sweep.
    const windowDays = ctx.windowDays;
    const windowed = typeof windowDays === "number" && Number.isFinite(windowDays) && windowDays > 0;
    const runStartedAt = new Date();
    const windowStartMs = windowed ? runStartedAt.getTime() - windowDays * DAY_MS : 0;
    // The 1-day pad absorbs Gmail's documented INTERNALDATE quirks (fixed-Pacific day boundary;
    // migrated-mail date overrides — RFC 3501 SINCE is date-granular on INTERNALDATE).
    const searchSince = new Date(windowStartMs - DAY_MS);

    const client = this.makeClient(buildClientOptions(username, pass));
    // VANISHED UIDs land here keyed by mailbox path (QRESYNC EXPUNGE carries the uid).
    const vanishedByPath = new Map<string, number[]>();

    try {
      await client.connect();
      client.on("expunge", (e: ExpungeEvent) => {
        if (e.vanished && typeof e.uid === "number") {
          const arr = vanishedByPath.get(e.path) ?? [];
          arr.push(e.uid);
          vanishedByPath.set(e.path, arr);
        }
      });

      const folders = await this.discoverFolders(client);
      const { folders: cursorMap, censusAt } = parseCursor(ctx.cursor);
      const nextMap: Record<string, FolderCursor> = { ...cursorMap };
      // One-record look-behind so the final, fully-built cursor map rides the LAST yielded record.
      let pending: RawRecord | null = null;

      // Daily census clock: incremental folders census only when ≥24h past the last completed
      // census (no `_census.at` — every pre-existing cursor — means census due immediately).
      // Full-resync folders ALWAYS census: the windowed backfill search IS the census.
      const censusDue =
        windowed &&
        (censusAt == null || runStartedAt.getTime() - Date.parse(censusAt) >= CENSUS_INTERVAL_MS);
      // The union of "<folderEnum>:<uid>" soids across discovered folders — the sweep's live set.
      const censusSoids = new Set<string>();
      // Flips false when ANY discovered folder skips or fails its census — the sweep runs ONLY on a
      // complete same-run census across every discovered folder (a Sent-less mailbox's discovered
      // set is just INBOX, and censusing it IS complete for that mailbox).
      let censusComplete = windowed;

      // BLOCK fold #1 — folder-vanish sweep guard: a folder key present in the STORED cursor map
      // that is absent from THIS run's discovered set is a census SKIP laundered through discovery
      // (Gmail's per-label "Show in IMAP" toggle; a LIST response missing the SPECIAL-USE
      // attribute). Sweeping without that folder's census would falsely tombstone every in-window
      // row it owns — withhold the sweep AND the `_census.at` stamp. A genuinely Sent-less mailbox
      // (no stored `sent` entry) still sweeps on inbox alone, exactly as before.
      if (windowed) {
        const discovered = new Set(folders.map((f) => f.enum));
        for (const key of Object.keys(cursorMap)) {
          if (!discovered.has(key)) {
            censusComplete = false;
            warnCensusWithheld(key, "vanished");
          }
        }
      }

      for (const folder of folders) {
        const stored = Object.hasOwn(cursorMap, folder.enum) ? cursorMap[folder.enum] : undefined;
        const mbox = stored
          ? await client.mailboxOpen(folder.path, {
              readOnly: true,
              changedSince: stored.modseq,
              uidValidity: BigInt(stored.uidValidity),
            })
          : await client.mailboxOpen(folder.path, { readOnly: true });

        const liveUidValidity = mbox.uidValidity.toString();
        const reset = stored == null || stored.uidValidity !== liveUidValidity;

        // VANISHED → tombstones, but only when UIDVALIDITY is stable (on a reset the old UIDs are
        // meaningless; the server sends no VANISHED for a mismatched UIDVALIDITY anyway).
        if (!reset) {
          for (const uid of vanishedByPath.get(folder.path) ?? []) {
            const del: RawRecord = {
              object: "message",
              deleted: true,
              externalId: `${folder.enum}:${uid}`,
              raw: null,
            };
            if (pending) yield pending;
            pending = del;
          }
        }

        if (reset && windowed) {
          // WINDOWED FULL RESYNC (first run / UIDVALIDITY reset / post-setSyncWindow cursor-null):
          // UID SEARCH SINCE (window − 1d pad), then fetch EXACTLY the returned set — never 1:*.
          // A `false` result means the search itself failed: the backfill can't proceed (throw; the
          // catch masks it secret-free). An EMPTY array is a complete, legitimate census (zero
          // in-window messages — nothing to fetch, the sweep may still run).
          const found = await client.search({ since: searchSince }, { uid: true });
          if (found === false) throw new Error("gmail: sync failed");
          const uids = [...new Set(found)].sort((a, b) => a - b);
          if (uids.length > CENSUS_MAX_UIDS) {
            // BLOCK fold #4 — sanity cap: an implausibly-huge SEARCH result never feeds the sweep.
            // The backfill fetch below still proceeds (the window bounds FETCH; data is never
            // silently dropped) — only this folder's census is refused, so no sweep, no stamp.
            censusComplete = false;
            warnCensusWithheld(folder.enum, "oversized");
          } else {
            for (const uid of uids) censusSoids.add(`${folder.enum}:${uid}`);
          }
          for (const range of compactUidRanges(uids, MAX_UIDS_PER_FETCH)) {
            // Sequential chunks: each fetch generator fully drains before the next IMAP command.
            for await (const msg of client.fetch(range, ENVELOPE_QUERY, { uid: true })) {
              const rec = toRawRecord(msg, folder.enum);
              if (pending) yield pending;
              pending = rec;
            }
          }
        } else if (reset) {
          // UNWINDOWED FULL RESYNC — the historical all-history behavior, byte-identical: one
          // 1:* fetch, no SEARCH (and, run-wide, no sweep: `windowed` is false).
          for await (const msg of client.fetch("1:*", ENVELOPE_QUERY, { uid: true })) {
            const rec = toRawRecord(msg, folder.enum);
            if (pending) yield pending;
            pending = rec;
          }
        } else {
          // INCREMENTAL — the single CHANGEDSINCE command, unchanged (response is proportional to
          // changed messages per RFC 7162). New: skip (don't yield) out-of-window messages — a flag
          // flip on ancient mail no longer pulls it into the cache.
          const iter = client.fetch("1:*", ENVELOPE_QUERY, {
            uid: true,
            changedSince: BigInt(stored.modseq),
          });
          for await (const msg of iter) {
            if (windowed) {
              const ms = msg.internalDate ? new Date(msg.internalDate).getTime() : NaN;
              // Skip only when provably older than windowStart − 1d (same pad as the search);
              // a missing/garbled INTERNALDATE flows (fail-open — never silently drop data).
              if (Number.isFinite(ms) && ms < windowStartMs - DAY_MS) continue;
            }
            const rec = toRawRecord(msg, folder.enum);
            if (pending) yield pending;
            pending = rec;
          }

          // Daily census on the incremental branch — AFTER the fetch generator fully drained
          // (never an IMAP command mid-stream).
          if (windowed) {
            if (censusDue) {
              try {
                const found = await client.search({ since: searchSince }, { uid: true });
                // imapflow resolves `false` on failure — same failure semantics as a throw.
                if (found === false) throw new Error("gmail: census search failed");
                if (found.length > CENSUS_MAX_UIDS) {
                  // BLOCK fold #4 — sanity cap: refuse the census, withhold the sweep and stamp.
                  censusComplete = false;
                  warnCensusWithheld(folder.enum, "oversized");
                } else {
                  for (const uid of found) censusSoids.add(`${folder.enum}:${uid}`);
                }
              } catch {
                // A census failure never fails the run (the new-mail pass already succeeded) —
                // it only withholds the sweep and the clock advance, so the next run re-censuses.
                // BLOCK fold #3: ONE masked warn so a persistently-dead census is grep-able —
                // folder enum only, ZERO error detail (it may embed IMAP/library strings).
                censusComplete = false;
                warnCensusWithheld(folder.enum, "failed");
              }
            } else {
              // <24h since the last completed census: no census this run — and the sweep needs a
              // SAME-RUN census across every folder, so it is withheld too.
              censusComplete = false;
            }
          }
        }

        const newModseq =
          mbox.highestModseq != null ? mbox.highestModseq.toString() : (stored?.modseq ?? "0");
        nextMap[folder.enum] = { uidValidity: liveUidValidity, modseq: newModseq };
      }

      // Round-trip the prior clock unless a fresh census+sweep lands this run.
      let nextCensusAt = censusAt;
      if (windowed && censusComplete) {
        // Sweep missed deletions (the CONDSTORE-reality fix): tombstone in-window rows absent from
        // THIS run's complete census. `from = windowStart + 1d` sits one day INSIDE the padded
        // search bound, so a date-skewed boundary row can never be falsely tombstoned (~2-day blind
        // band at the window edge — accepted; it slides past any given message). This also cleans
        // stale-generation rows after a UIDVALIDITY reset (old-generation soids fail the census).
        // Runs before the final `pending` yield: every earlier record is already upserted with
        // ingested_at ≥ runStartedAt (inside the fence), and a live `pending` — always the product
        // of a censused fetch when the sweep runs — is in censusSoids, so it can never be swept
        // (a pending VANISHED tombstone is a deletion either way).
        // resurrectPresent (BLOCK fold #2): a census sighting is a LIVE sighting — a tombstoned
        // in-window row the census still contains gets deleted_at cleared BEFORE the tombstone
        // pass (ADR 0004; self-healing for UNCHANGED messages a past false sweep tombstoned).
        await reconcileObjectSnapshot(ctx.connectionId, "mail", "message", censusSoids, runStartedAt, {
          column: "received_at",
          from: new Date(windowStartMs + DAY_MS),
          to: runStartedAt,
          resurrectPresent: true,
        });
        // Stamp ONLY after a successful sweep (a sweep failure throws past this — the clock never
        // advances, and the next run re-censuses).
        nextCensusAt = runStartedAt.toISOString();
      }

      if (pending) {
        const cursorOut: Record<string, unknown> = { ...nextMap };
        if (nextCensusAt != null) cursorOut[CENSUS_KEY] = { at: nextCensusAt };
        pending.cursor = JSON.stringify(cursorOut);
        yield pending;
      }
      // Zero-record run: the cursor stays untouched, exactly as before — we never invent a
      // cursor-only record. Deliberate census consequence: a census+sweep completed on an all-quiet
      // run loses its `_census.at` stamp (nothing to ride on), so the next run may re-census. That
      // is accepted — the sweep itself already landed, and a repeat census is one cheap UID SEARCH
      // per folder — and cheaper than fabricating records.
    } catch (err) {
      // An auth refusal names its cause (constant, secret-free — never the server's text). It must
      // be checked BEFORE the generic mask: imapflow's message doesn't start with "gmail:".
      if (isImapAuthRefusal(err)) throw new Error(AUTH_REFUSED_MESSAGE);
      // Keep our own clean guards; mask any OTHER IMAP/library error to a secret-free message.
      if (err instanceof Error && err.message.startsWith("gmail:")) throw err;
      throw new Error("gmail: sync failed");
    } finally {
      await safeLogout(client);
    }
  }

  /** Map an IMAP envelope record → the REGISTRY `mail` scalars (never `id`/`raw`/`labels`). */
  normalize(rec: RawRecord): MailMessageRow {
    const r = rec.raw as GmailEnvelopeRaw;
    const env: MessageEnvelopeObject = r.envelope ?? {};
    const from0 = env.from?.[0];
    const sender0 = env.sender?.[0];
    const fromAddr = from0?.address ?? null;
    const senderAddr = sender0?.address ?? null;
    const folderEnum = typeof r[FOLDER_KEY] === "string" ? r[FOLDER_KEY] : "";
    const folder = Object.hasOwn(FOLDER_ENUM, folderEnum) ? FOLDER_ENUM[folderEnum] : null;
    return {
      source_object_id: `${folderEnum}:${r.uid}`,
      thread_id: r.threadId ?? null, // X-GM-THRID
      message_id_header: env.messageId ?? null,
      from_address: fromAddr,
      from_name: from0?.name ?? null,
      // sender only when it genuinely differs from `from` (delegate/shared), else null.
      sender_address: senderAddr != null && senderAddr !== fromAddr ? senderAddr : null,
      subject: env.subject ?? null,
      snippet: null, // V0: IMAP has no snippet (touching the body is an opt-in follow-up)
      sent_at: toIso(env.date),
      received_at: r.internalDate ?? null, // INTERNALDATE → primaryTime / default sort
      is_read: Array.isArray(r.flags) ? r.flags.includes(SEEN_FLAG) : null,
      has_attachments: hasAttachments(r.bodyStructure),
      folder,
      importance: null, // Outlook-only enrichment
    };
  }

  /** Deterministic strong keys: { gmail_msgid: X-GM-MSGID, message_id: Message-ID header }. */
  strongKeys(rec: RawRecord): Record<string, string> {
    const r = rec.raw as GmailEnvelopeRaw | undefined;
    const out: Record<string, string> = {};
    const msgid = r?.emailId; // X-GM-MSGID
    if (msgid != null && msgid !== "") out.gmail_msgid = String(msgid);
    const header = r?.envelope?.messageId; // RFC 5322 Message-ID
    if (header != null && header !== "") out.message_id = String(header);
    return out;
  }

  /**
   * The fetch_live {id} drill: parse "<folder>:<uid>", open a fresh short-lived client (ctx.username
   * + ctx.secret — hence the context.ts username enabler), FETCH the full RFC822 source by UID, and
   * return it as the raw payload. Stores NOTHING (footprint-limited; ADR 0001). A UID miss — including
   * a changed UIDVALIDITY since the cache write — returns null (truthful "gone"; ADR 0004).
   * logout() in finally.
   */
  async fetchRecordLive(ctx: SyncContext, sourceObjectId: string): Promise<unknown> {
    const username = ctx.username;
    const pass = ctx.secret;
    if (!username || !pass) throw new Error("gmail: missing app-password or username");

    const sep = sourceObjectId.indexOf(":");
    if (sep <= 0) throw new Error("gmail: malformed record id");
    const folderEnum = sourceObjectId.slice(0, sep);
    const uid = Number(sourceObjectId.slice(sep + 1));
    if (!Number.isInteger(uid) || uid <= 0) throw new Error("gmail: malformed record id");
    if (!Object.hasOwn(FOLDER_ENUM, folderEnum)) throw new Error("gmail: unknown folder");

    const client = this.makeClient(buildClientOptions(username, pass));
    try {
      await client.connect();
      let path: string | null;
      if (folderEnum === "inbox") {
        path = "INBOX";
      } else {
        // Re-discover the localized Sent path (never hardcoded).
        const boxes = await client.list();
        const sent = boxes.find((b) => b.specialUse === SPECIAL_USE_SENT);
        path = sent ? sent.path : null;
      }
      if (!path) return null; // can't resolve the folder → truthfully "gone"

      await client.mailboxOpen(path, { readOnly: true });
      const msg = await client.fetchOne(String(uid), BODY_QUERY, { uid: true });
      if (!msg) return null; // UID miss (incl. UIDVALIDITY changed) → source says gone (ADR 0004)
      return {
        uid: msg.uid,
        source: msg.source ? msg.source.toString("utf8") : null,
        envelope: msg.envelope ?? null,
        bodyStructure: msg.bodyStructure ?? null,
      };
    } catch (err) {
      // Same auth-refusal naming as sync(): a dead app password on the live body drill should say
      // so, not hide behind the generic fetch failure.
      if (isImapAuthRefusal(err)) throw new Error(AUTH_REFUSED_MESSAGE);
      if (err instanceof Error && err.message.startsWith("gmail:")) throw err;
      throw new Error("gmail: live record fetch failed");
    } finally {
      await safeLogout(client);
    }
  }

  /** Read-only: no actions on the source side (ADR 0002 — IMAP read path only). */
  async execute(): Promise<ActionResult> {
    throw new Error("GmailConnector has no actions (mail is read-only this wave)");
  }

  /**
   * Discover the synced folders: INBOX (well-known root) + the localized Sent folder, found via the
   * RFC-6154 SPECIAL-USE `\Sent` flag (NEVER hardcode "[Gmail]/Sent Mail"). Sent is optional — if the
   * account exposes none, only INBOX is synced.
   */
  private async discoverFolders(client: ImapClient): Promise<Array<{ path: string; enum: string }>> {
    const boxes = await client.list();
    const out: Array<{ path: string; enum: string }> = [];
    const inbox =
      boxes.find((b) => b.specialUse === SPECIAL_USE_INBOX) ??
      boxes.find((b) => b.path.toUpperCase() === "INBOX");
    out.push({ path: inbox?.path ?? "INBOX", enum: "inbox" });
    const sent = boxes.find((b) => b.specialUse === SPECIAL_USE_SENT);
    if (sent) out.push({ path: sent.path, enum: "sent" });
    return out;
  }
}
