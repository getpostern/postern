// iCloud (Apple Mail) connector — read-only mail over IMAP (imapflow) with an APPLE ID + an
// APP-SPECIFIC PASSWORD (ASP; static_token custody — iCloud IMAP has no OAuth for self-host). Per
// folder the connector caches the RFC-5322 ENVELOPE only (ADR 0001) — sender/subject/dates/flags —
// never the body or attachment content. The body is fetched on demand by `folder:uid` via
// fetchRecordLive (stores NOTHING).
//
// DELETION DETECTION — QRESYNC (better than the Gmail census). iCloud advertises CONDSTORE **and**
// QRESYNC (unlike Gmail, which lacks QRESYNC and forces a daily UID census), so a
// `SELECT ... (QRESYNC (uidvalidity highestmodseq))` open yields both MODSEQ flag-deltas AND
// `VANISHED (EARLIER)` expunge deltas. VANISHED UIDs become ADR-0004 tombstones directly — no census
// clock, no periodic full-UID diff. A later live sighting resurrects (the runner's upsert always
// writes deleted_at = null). The ONE place a census is still needed is a UIDVALIDITY reset (the whole
// generation's UIDs are invalidated): the windowed full-resync SEARCH is a COMPLETE windowed
// enumeration, so — only on a run where EVERY discovered folder took that complete branch — the stale
// generation is swept via the window-scoped reconcileObjectSnapshot (resurrectPresent: a census
// sighting clears a stale tombstone). A mixed run (any incremental/unwindowed folder) NEVER sweeps —
// an incremental fetch is not a complete enumeration, so sweeping would falsely mass-tombstone.
//
// RECENCY WINDOW (ADR 0017): when ctx.windowDays is set (runner: mail-sector default 180 — the runner
// gates "apple" into MAIL_PROVIDERS), the full-resync branch bounds the backfill with a server-side
// `UID SEARCH SINCE (windowStart − 1d)` and fetches EXACTLY the returned UID set (range-compacted,
// ≤1000 UIDs per sequential fetch command); the incremental CHANGEDSINCE path stays one command and
// drops out-of-window records client-side. The window bounds FETCH, not retention: out-of-window rows
// are never tombstoned or pruned and stay reachable on demand via fetchRecordLive. windowDays null/≤0
// ⇒ the historical unbounded `1:*` behaviour exactly (no SEARCH, no sweep).
//
// DEFENSIVE against documented iCloud IMAP quirks (recon): we do NOT hard-require the
// `* ENABLED CONDSTORE QRESYNC` echo — imapflow negotiates QRESYNC and we rely on observed BEHAVIOUR
// (VANISHED events + highestModseq), never on parsing that untagged response; a malformed FETCH
// carrying an illegal sequence number (-1) with no real UID is skipped (we key on UID, never seq);
// LANGUAGE responses are ignored (imapflow handles them; nothing here parses them).
//
// SECURITY: ctx.secret is the app-specific password and ctx.username the Apple ID — both are
// CREDENTIALS. `logger:false` is REQUIRED (imapflow logs via pino otherwise — the ASP/body must never
// hit logs). Every connect/fetch failure throws a clean, secret-free Error (no ASP, Apple ID, folder
// body, or original IMAP message echoed). All diagnostics go to stderr; we emit none.

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
const IMAP_HOST = "imap.mail.me.com";
const IMAP_PORT = 993;

// Fixed synced set: INBOX + Sent, matching the Gmail/Outlook connectors. INBOX is the well-known root
// path; the Sent path is DISCOVERED via the RFC-6154 SPECIAL-USE flag (iCloud localizes "Sent
// Messages" — never hardcode it).
const SPECIAL_USE_INBOX = "\\Inbox";
const SPECIAL_USE_SENT = "\\Sent";

// Neutral REGISTRY `folder` enum — normalize() maps the threaded enum through this whitelist
// (Object.hasOwn lookup) so a stray key resolves to null, never a SQL surprise.
const FOLDER_ENUM: Record<string, string> = { inbox: "inbox", sent: "sent" };

// Synthetic key threaded into the stored envelope `raw` so normalize() — a pure function of a single
// record — knows the folder enum (UID is per-folder; the message itself carries no folder). Mirrors
// the Gmail `__pci_folder` pattern: ADDS a key, original fields stay.
const FOLDER_KEY = "__pci_folder";

// Envelope-metadata fetch (ADR 0001 — never the body). NOTE: no Gmail X-GM-EXT-1 fields (threadId /
// labels / emailId) — those are a Gmail extension; standard iCloud IMAP has none.
const ENVELOPE_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  bodyStructure: true,
};

// The by-id body drill (fetchRecordLive) — the full RFC822 source, fetched live, stored NOWHERE.
const BODY_QUERY: FetchQueryObject = {
  uid: true,
  source: true,
  envelope: true,
  bodyStructure: true,
};

const SEEN_FLAG = "\\Seen";

const DAY_MS = 24 * 60 * 60 * 1000;

// Max UIDs per windowed-backfill fetch command. Chunks are SEQUENTIAL — no IMAP command is ever
// issued while a fetch generator is mid-stream (documented imapflow deadlock); each chunk's generator
// fully drains before the next command.
const MAX_UIDS_PER_FETCH = 1000;

// ── Injectable client seam (duplicated from gmail.ts — do NOT refactor gmail.ts; small duplication
// is accepted per the spec so this connector stays self-contained). ─────────────────────────────

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
   * UID SEARCH over the open mailbox (the imapflow subset; the windowed backfill issues
   * `{since}, {uid:true}` → ascending UID array). imapflow resolves `false` on failure — the connector
   * treats that as a failed search (the backfill run fails, masked secret-free).
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

/** Build the imapflow connection options. `logger:false` is REQUIRED (no pino → no secret in logs);
 * `qresync:true` negotiates CONDSTORE+QRESYNC (VANISHED deletion detection). */
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
interface IcloudEnvelopeRaw {
  uid: number;
  envelope: MessageEnvelopeObject;
  flags: string[];
  internalDate: string | null; // ISO; the INTERNALDATE → received_at (primaryTime)
  bodyStructure?: MessageStructureObject; // MIME tree (structure metadata; no content) → has_attachments
  [FOLDER_KEY]: string; // neutral folder enum
}

/** A folder's persisted CONDSTORE/QRESYNC state (BigInts carried as strings — JSON can't hold BigInt). */
interface FolderCursor {
  uidValidity: string;
  modseq: string;
}

// ── Helpers (module-private; small duplication of gmail's pure helpers, spec-accepted) ────────

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

/** True when a FETCH response carries a usable positive-integer UID (guards the iCloud illegal
 * sequence-number `-1` quirk — a malformed untagged FETCH with no real UID is skipped). */
function hasUsableUid(msg: FetchMessageObject): boolean {
  return typeof msg.uid === "number" && Number.isInteger(msg.uid) && msg.uid > 0;
}

/**
 * Parse the per-folder CONDSTORE cursor map; a missing/garbled cursor starts fresh (full resync).
 * (No reserved keys — iCloud has no daily census clock; VANISHED is the deletion path.)
 */
function parseCursor(cursor: string | undefined): Record<string, FolderCursor> {
  const out: Record<string, FolderCursor> = {};
  if (!cursor) return out;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v != null && typeof v === "object" && !Array.isArray(v)) {
          const o = v as Record<string, unknown>;
          if (typeof o.uidValidity === "string" && typeof o.modseq === "string") {
            out[k] = { uidValidity: o.uidValidity, modseq: o.modseq };
          }
        }
      }
    }
  } catch {
    // garbled cursor → fall through to a fresh delta (full resync)
  }
  return out;
}

/**
 * Compact an ascending, deduped UID array into IMAP UID-set range strings ("101:103,107"), with at
 * most `maxPerChunk` UIDs per chunk — the windowed backfill fetches EXACTLY the searched set, never
 * `1:*`, and never more than MAX_UIDS_PER_FETCH UIDs in one fetch command. Empty input → no chunks.
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
  const raw: IcloudEnvelopeRaw = {
    uid: msg.uid,
    envelope: msg.envelope ?? {},
    flags: msg.flags ? Array.from(msg.flags) : [],
    internalDate: toIso(msg.internalDate),
    bodyStructure: msg.bodyStructure,
    [FOLDER_KEY]: folderEnum,
  };
  return { object: "message", externalId: `${folderEnum}:${msg.uid}`, raw };
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
 * The REGISTRY `mail` scalars minus `id` (the runner injects `id`). Shape-identical to the Gmail /
 * Microsoft rows — iCloud leaves `thread_id`/`snippet`/`importance` null (standard IMAP has no
 * thread id or snippet; importance is an Outlook-only enrichment).
 */
export interface MailMessageRow {
  source_object_id: string; // "<folderEnum>:<uid>" (UID is per-folder + UIDVALIDITY)
  thread_id: string | null; // null (standard IMAP has no thread id)
  message_id_header: string | null; // ENVELOPE.messageId (RFC 5322 Message-ID)
  from_address: string | null; // ENVELOPE.from[0].address
  from_name: string | null; // ENVELOPE.from[0].name
  sender_address: string | null; // ENVELOPE.sender[0].address when ≠ from, else null
  subject: string | null;
  snippet: string | null; // null in V0 (IMAP has no snippet)
  sent_at: string | null; // ENVELOPE.date
  received_at: string | null; // INTERNALDATE (primaryTime / default sort)
  is_read: boolean | null; // FLAGS has \Seen
  has_attachments: boolean | null; // derived from BODYSTRUCTURE
  folder: string | null; // neutral enum: inbox | sent
  importance: string | null; // null (Outlook-only enrichment)
}

/** iCloud (Apple) IMAP mail connector (read-only; envelope-only cache; body on demand). */
export class IcloudMailConnector implements Connector<MailMessageRow> {
  readonly provider = "apple";
  readonly sector = "mail";
  readonly objectType = "message"; // matches REGISTRY mail.object

  // Poll source (no IDLE). iCloud publishes no documented IMAP rate limits — a conservative 10-min
  // default with a 5-min floor keeps a short-lived sequential envelope poll well inside any reality.
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 600,
    minIntervalSec: 300,
    freshnessToleranceSec: 600,
    supportsIncremental: true,
  };

  // Read-only this wave (send/flag/move would trigger the read|act split first).
  readonly actions: ActionSpec[] = [];

  private readonly makeClient: ImapClientFactory;

  /** `makeClient` is injectable for tests; production uses the real imapflow client. */
  constructor(makeClient: ImapClientFactory = defaultClientFactory) {
    this.makeClient = makeClient;
  }

  /**
   * Walk INBOX + Sent per-folder CONDSTORE/QRESYNC, yielding envelope-metadata RawRecords (+ VANISHED
   * tombstones). ctx.username/ctx.secret authenticate; ctx.cursor is a JSON map
   * { folderEnum: {uidValidity, modseq} }.
   * Per folder, sequentially:
   *   - open with QRESYNC params when a cursor exists (→ VANISHED EARLIER on open);
   *   - UIDVALIDITY mismatch (or first run) → FULL resync — windowed (ctx.windowDays > 0): UID SEARCH
   *     SINCE (windowStart − 1d pad) then fetch EXACTLY that UID set (range-compacted, ≤1000 UIDs per
   *     sequential fetch command); unwindowed: the historical `1:*` fetch;
   *   - else INCREMENTAL: fetch("1:*", …, changedSince:<storedModseq>) — one pass catches new messages
   *     AND flag changes (\Seen → is_read); out-of-window messages are skipped client-side.
   * UIDVALIDITY-reset stale-generation cleanup: ONLY on a run where EVERY discovered folder took the
   * windowed full-resync branch (a complete windowed enumeration across the connection), the stale
   * generation is swept via the window-scoped reconcileObjectSnapshot (resurrectPresent: a census
   * sighting clears a stale tombstone). A mixed run (any incremental/unwindowed folder, or a folder
   * present in the stored cursor but missing from discovery) NEVER sweeps — an incremental fetch is
   * not a complete enumeration, and a mass-tombstone off a partial enumeration is the hazard.
   * The cursor map rides the LAST record (one-record look-behind; O(1) buffer). ONE short-lived
   * connection per run, logout() in finally; no IDLE.
   */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    const username = ctx.username;
    const pass = ctx.secret;
    if (!username || !pass) throw new Error("icloud-mail: missing app-specific password or username");

    // Window derivation (per run — the window slides forward every poll).
    // windowDays null/undefined/≤0 ⇒ historical behaviour EXACTLY: unbounded 1:*, no SEARCH, no sweep.
    const windowDays = ctx.windowDays;
    const windowed = typeof windowDays === "number" && Number.isFinite(windowDays) && windowDays > 0;
    const runStartedAt = new Date();
    const windowStartMs = windowed ? runStartedAt.getTime() - windowDays * DAY_MS : 0;
    // The 1-day pad absorbs INTERNALDATE date-granularity (RFC 3501 SINCE is date-granular).
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
      const cursorMap = parseCursor(ctx.cursor);
      const nextMap: Record<string, FolderCursor> = { ...cursorMap };
      // One-record look-behind so the final, fully-built cursor map rides the LAST yielded record.
      let pending: RawRecord | null = null;

      // UIDVALIDITY-reset cleanup accounting. The sweep runs ONLY on a run where every discovered
      // folder produced a COMPLETE windowed enumeration (every folder took the windowed full-resync
      // branch) — otherwise a partial enumeration could mass-tombstone real rows.
      const censusSoids = new Set<string>();
      let completeEnumeration = windowed; // false the moment any folder is incremental/unwindowed

      // Folder-vanish guard: a folder present in the STORED cursor that is absent from THIS run's
      // discovered set means we have no enumeration for it — sweeping would falsely tombstone its
      // rows. Withhold the sweep.
      if (windowed) {
        const discovered = new Set(folders.map((f) => f.enum));
        for (const key of Object.keys(cursorMap)) {
          if (!discovered.has(key)) completeEnumeration = false;
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
          // WINDOWED FULL RESYNC (first run / UIDVALIDITY reset): UID SEARCH SINCE (window − 1d pad),
          // then fetch EXACTLY the returned set — never 1:*. A `false` result means the search itself
          // failed: the backfill can't proceed (throw; the catch masks it secret-free). An EMPTY
          // array is a complete, legitimate enumeration (zero in-window messages).
          const found = await client.search({ since: searchSince }, { uid: true });
          if (found === false) throw new Error("icloud-mail: sync failed");
          const uids = [...new Set(found)].sort((a, b) => a - b);
          for (const uid of uids) censusSoids.add(`${folder.enum}:${uid}`);
          for (const range of compactUidRanges(uids, MAX_UIDS_PER_FETCH)) {
            // Sequential chunks: each fetch generator fully drains before the next IMAP command.
            for await (const msg of client.fetch(range, ENVELOPE_QUERY, { uid: true })) {
              if (!hasUsableUid(msg)) continue; // iCloud illegal-seq -1 guard
              const rec = toRawRecord(msg, folder.enum);
              if (pending) yield pending;
              pending = rec;
            }
          }
        } else if (reset) {
          // UNWINDOWED FULL RESYNC — the historical all-history behaviour: one 1:* fetch, no SEARCH.
          // No complete windowed enumeration ⇒ no sweep this run.
          completeEnumeration = false;
          for await (const msg of client.fetch("1:*", ENVELOPE_QUERY, { uid: true })) {
            if (!hasUsableUid(msg)) continue;
            const rec = toRawRecord(msg, folder.enum);
            if (pending) yield pending;
            pending = rec;
          }
        } else {
          // INCREMENTAL — the single CHANGEDSINCE command (response proportional to changed messages
          // per RFC 7162). Not a complete enumeration ⇒ no sweep this run. Skip (don't yield)
          // out-of-window messages — a flag flip on ancient mail no longer pulls it into the cache.
          completeEnumeration = false;
          const iter = client.fetch("1:*", ENVELOPE_QUERY, {
            uid: true,
            changedSince: BigInt(stored.modseq),
          });
          for await (const msg of iter) {
            if (!hasUsableUid(msg)) continue;
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
        }

        const newModseq =
          mbox.highestModseq != null ? mbox.highestModseq.toString() : (stored?.modseq ?? "0");
        nextMap[folder.enum] = { uidValidity: liveUidValidity, modseq: newModseq };
      }

      // UIDVALIDITY-reset stale-generation sweep — only on a fully-enumerated run (every discovered
      // folder took the windowed full-resync branch). Runs before the final `pending` yield: every
      // earlier record is already upserted with ingested_at ≥ runStartedAt (inside the fence), and a
      // live `pending` is in censusSoids (its fetch was censused), so it can never be swept.
      // `from = windowStart + 1d` sits one day INSIDE the padded search bound, so a date-skewed
      // boundary row can never be falsely tombstoned. resurrectPresent clears a stale tombstone on a
      // census sighting (ADR 0004 self-healing).
      if (windowed && completeEnumeration) {
        await reconcileObjectSnapshot(
          ctx.connectionId,
          "mail",
          "message",
          censusSoids,
          runStartedAt,
          {
            column: "received_at",
            from: new Date(windowStartMs + DAY_MS),
            to: runStartedAt,
            resurrectPresent: true,
          },
        );
      }

      if (pending) {
        pending.cursor = JSON.stringify(nextMap);
        yield pending;
      }
      // Zero-record run: the cursor stays untouched — we never invent a cursor-only record.
    } catch (err) {
      // Keep our own clean guards; mask any IMAP/library error to a secret-free message.
      if (err instanceof Error && err.message.startsWith("icloud-mail:")) throw err;
      throw new Error("icloud-mail: sync failed");
    } finally {
      await safeLogout(client);
    }
  }

  /** Map an IMAP envelope record → the REGISTRY `mail` scalars (never `id`/`raw`). */
  normalize(rec: RawRecord): MailMessageRow {
    const r = rec.raw as IcloudEnvelopeRaw;
    const env: MessageEnvelopeObject = r.envelope ?? {};
    const from0 = env.from?.[0];
    const sender0 = env.sender?.[0];
    const fromAddr = from0?.address ?? null;
    const senderAddr = sender0?.address ?? null;
    const folderEnum = typeof r[FOLDER_KEY] === "string" ? r[FOLDER_KEY] : "";
    const folder = Object.hasOwn(FOLDER_ENUM, folderEnum) ? FOLDER_ENUM[folderEnum] : null;
    return {
      source_object_id: `${folderEnum}:${r.uid}`,
      thread_id: null, // standard IMAP has no thread id
      message_id_header: env.messageId ?? null,
      from_address: fromAddr,
      from_name: from0?.name ?? null,
      // sender only when it genuinely differs from `from` (delegate/shared), else null.
      sender_address: senderAddr != null && senderAddr !== fromAddr ? senderAddr : null,
      subject: env.subject ?? null,
      snippet: null, // V0: IMAP has no snippet
      sent_at: toIso(env.date),
      received_at: r.internalDate ?? null, // INTERNALDATE → primaryTime / default sort
      is_read: Array.isArray(r.flags) ? r.flags.includes(SEEN_FLAG) : null,
      has_attachments: hasAttachments(r.bodyStructure),
      folder,
      importance: null, // Outlook-only enrichment
    };
  }

  /** Deterministic strong keys: { message_id: RFC 5322 Message-ID header }. */
  strongKeys(rec: RawRecord): Record<string, string> {
    const r = rec.raw as IcloudEnvelopeRaw | undefined;
    const out: Record<string, string> = {};
    const header = r?.envelope?.messageId; // RFC 5322 Message-ID
    if (header != null && header !== "") out.message_id = String(header);
    return out;
  }

  /**
   * The fetch_live {id} drill: parse "<folder>:<uid>", open a fresh short-lived client (ctx.username +
   * ctx.secret), FETCH the full RFC822 source by UID, and return it as the raw payload. Stores NOTHING
   * (footprint-limited; ADR 0001). A UID miss — including a changed UIDVALIDITY since the cache write —
   * returns null (truthful "gone"; ADR 0004). logout() in finally.
   */
  async fetchRecordLive(ctx: SyncContext, sourceObjectId: string): Promise<unknown> {
    const username = ctx.username;
    const pass = ctx.secret;
    if (!username || !pass) throw new Error("icloud-mail: missing app-specific password or username");

    const sep = sourceObjectId.indexOf(":");
    if (sep <= 0) throw new Error("icloud-mail: malformed record id");
    const folderEnum = sourceObjectId.slice(0, sep);
    const uid = Number(sourceObjectId.slice(sep + 1));
    if (!Number.isInteger(uid) || uid <= 0) throw new Error("icloud-mail: malformed record id");
    if (!Object.hasOwn(FOLDER_ENUM, folderEnum)) throw new Error("icloud-mail: unknown folder");

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
      if (err instanceof Error && err.message.startsWith("icloud-mail:")) throw err;
      throw new Error("icloud-mail: live record fetch failed");
    } finally {
      await safeLogout(client);
    }
  }

  /** Read-only: no actions on the source side (IMAP read path only). */
  async execute(): Promise<ActionResult> {
    throw new Error("IcloudMailConnector has no actions (mail is read-only this wave)");
  }

  /**
   * Discover the synced folders: INBOX (well-known root) + the localized Sent folder, found via the
   * RFC-6154 SPECIAL-USE `\Sent` flag (NEVER hardcode "Sent Messages"). Sent is optional — if the
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
