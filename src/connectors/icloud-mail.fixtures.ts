// iCloud Mail IMAP fixtures — production string forms of the IMAP ENVELOPE / FLAGS / BODYSTRUCTURE
// the imapflow `fetch` call yields, plus a small configurable FAKE imapflow client for the
// network-free unit tests and the DB round-trip.
//
// Message shapes mirror what imapflow returns for `{ envelope, flags, internalDate, bodyStructure,
// uid }` — NOTE: no Gmail X-GM extensions (threadId/labels/emailId); standard iCloud IMAP has none.
// An ENVELOPE carries from/sender (name+address), subject, messageId, and a Date `date`; FLAGS is a
// Set ("\\Seen" → read); BODYSTRUCTURE is a MIME tree (an attachment leaf has a non-inline
// disposition). The by-id body result adds `source` (the RFC822 Buffer) — fetched on demand, never
// stored. The fake client supports per-run "rounds" so the DB test can drive initial → VANISHED →
// re-sighting against one registered connector. UID SEARCH (the windowed backfill) is served per
// folder — `searchUids` (default: the uids of `messages`), `searchFails` (resolves false), or
// `searchThrows` (rejects, embedding the ASP to prove masking) — and every search call is recorded on
// the handle ({path, query}). fetch() honors the requested UID range, so exact-set windowed fetches
// are meaningfully asserted.

import type {
  ImapFlowOptions,
  ListResponse,
  MailboxObject,
  FetchMessageObject,
  FetchOptions,
  ExpungeEvent,
  SearchObject,
} from "imapflow";
import type { ImapClient, ImapClientFactory } from "./icloud-mail.js";

// ── Folder identity ─────────────────────────────────────────────────────────────────
export const INBOX_PATH = "INBOX";
// A LOCALIZED Sent path — the connector must DISCOVER it via SPECIAL-USE `\Sent`, never hardcode it.
export const SENT_PATH = "Sent Messages";
export const ARCHIVE_PATH = "Archive"; // a decoy: present in LIST, must NOT be synced

export const UIDVALIDITY_INBOX = 30_000n;
export const UIDVALIDITY_SENT = 40_000n;

// ── Messages (envelope only — no body) ────────────────────────────────────────────────

/** Unread, with a PDF attachment. from === sender (no delegate). uid 501. */
export const INBOX_MSG_1: FetchMessageObject = {
  seq: 1,
  uid: 501,
  flags: new Set<string>(), // unread (no \Seen)
  internalDate: new Date("2026-06-12T09:30:00.000Z"),
  envelope: {
    date: new Date("2026-06-12T09:29:55.000Z"),
    subject: "Family trip itinerary",
    messageId: "<icloud-inbox-0001@mail.me.com>",
    from: [{ name: "Alice Sender", address: "alice@icloud.example.com" }],
    sender: [{ name: "Alice Sender", address: "alice@icloud.example.com" }],
    to: [{ name: "Operator", address: "operator@icloud.com" }],
  },
  bodyStructure: {
    type: "multipart/mixed",
    childNodes: [
      { type: "text/plain" },
      {
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "itinerary.pdf" },
      },
    ],
  },
};

/** Read, no attachment, DELEGATE sender (≠ from). uid 502. */
export const INBOX_MSG_2: FetchMessageObject = {
  seq: 2,
  uid: 502,
  flags: new Set<string>(["\\Seen"]), // read
  internalDate: new Date("2026-06-11T15:05:00.000Z"),
  envelope: {
    date: new Date("2026-06-11T15:04:30.000Z"),
    subject: "Dinner?",
    messageId: "<icloud-inbox-0002@partner.example.org>",
    from: [{ name: "Carol Friend", address: "carol@partner.example.org" }],
    sender: [{ name: "Assistant On Behalf", address: "assistant@partner.example.org" }],
    to: [{ name: "Operator", address: "operator@icloud.com" }],
  },
  bodyStructure: { type: "text/plain" },
};

/** A message in the Sent folder — folder enum must resolve to `sent`. uid 601. */
export const SENT_MSG_1: FetchMessageObject = {
  seq: 1,
  uid: 601,
  flags: new Set<string>(["\\Seen"]),
  internalDate: new Date("2026-06-11T15:20:00.000Z"),
  envelope: {
    date: new Date("2026-06-11T15:20:00.000Z"),
    subject: "RE: Dinner?",
    messageId: "<icloud-sent-0001@mail.me.com>",
    from: [{ name: "Operator", address: "operator@icloud.com" }],
    sender: [{ name: "Operator", address: "operator@icloud.com" }],
    to: [{ name: "Carol Friend", address: "carol@partner.example.org" }],
  },
  bodyStructure: { type: "text/plain" },
};

/**
 * A minimal production-shaped envelope message whose INTERNALDATE sits `daysAgo` days in the past —
 * the recency-window tests (in-window skip, sweep scope) need dates relative to NOW because the
 * connector derives the window from Date.now() per run.
 */
export function msgAt(uid: number, daysAgo: number): FetchMessageObject {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    seq: uid,
    uid,
    flags: new Set<string>(),
    internalDate: d,
    envelope: {
      date: d,
      subject: `synthetic message ${uid}`,
      messageId: `<synthetic-${uid}@icloud.example.com>`,
      from: [{ name: "Synthetic Sender", address: "sender@icloud.example.com" }],
      sender: [{ name: "Synthetic Sender", address: "sender@icloud.example.com" }],
      to: [{ name: "Operator", address: "operator@icloud.com" }],
    },
    bodyStructure: { type: "text/plain" },
  };
}

// ── By-id body result (fetchRecordLive) — includes the RFC822 `source`, never stored ──────
export const BODY_RFC822 =
  "From: Alice Sender <alice@icloud.example.com>\r\n" +
  "To: Operator <operator@icloud.com>\r\n" +
  "Subject: Family trip itinerary\r\n" +
  "Message-ID: <icloud-inbox-0001@mail.me.com>\r\n" +
  "\r\n" +
  "Here is the proposed itinerary for the family trip next month.\r\n";

export const MESSAGE_BODY_RESULT: FetchMessageObject = {
  seq: 1,
  uid: 501,
  source: Buffer.from(BODY_RFC822, "utf8"),
  envelope: INBOX_MSG_1.envelope,
  bodyStructure: INBOX_MSG_1.bodyStructure,
};

// ── A configurable fake imapflow client ─────────────────────────────────────────────────

/** One folder's per-run state for the fake. */
export interface FakeFolder {
  path: string;
  /** RFC-6154 SPECIAL-USE flag, e.g. "\\Inbox" | "\\Sent" | "\\Archive". */
  specialUse?: string;
  uidValidity: bigint;
  highestModseq: bigint;
  /** Messages the `fetch` call yields for this folder this run (filtered by the requested range). */
  messages?: FetchMessageObject[];
  /** UIDs reported as VANISHED (EARLIER) on an incremental open (when UIDVALIDITY matches). */
  vanished?: number[];
  /** UID SEARCH result for this folder this run; default = the uids of `messages`. */
  searchUids?: number[];
  /** search() resolves `false` (imapflow's failure shape) — a failed windowed-backfill search. */
  searchFails?: boolean;
  /** search() REJECTS with an error that EMBEDS the ASP (to prove masking on the search path). */
  searchThrows?: boolean;
}

/** One sync run's folder snapshot. The factory pops the next round per `makeClient` call. */
export interface FakeRound {
  folders: FakeFolder[];
}

export interface FakeImapConfig {
  rounds: FakeRound[];
  /** fetchOne(uid) → this message, or `false` (a UID miss → the connector returns null). */
  bodyByUid?: Record<number, FetchMessageObject | false>;
  /** When true, `connect()` rejects with an error that EMBEDS the ASP (to prove masking). */
  failConnect?: boolean;
}

export interface FakeImapHandle {
  factory: ImapClientFactory;
  /** The options each `new ImapFlow(...)` would have been built with (asserts logger:false etc.). */
  clientOptions: ImapFlowOptions[];
  connects: number;
  logouts: number;
  /** Every mailboxOpen, with whether QRESYNC params (changedSince+uidValidity) rode along. */
  opens: Array<{ path: string; qresync: boolean }>;
  /** Every fetch: the open folder path, the requested RANGE, + the changedSince (undefined ⇒ full). */
  fetches: Array<{ path: string | null; range: string; changedSince?: bigint }>;
  /** Every UID SEARCH: the open folder path + the query (tests assert the SINCE date and the pad). */
  searches: Array<{ path: string | null; query: SearchObject; uid?: boolean }>;
  listCalls: number;
}

/** Does `uid` fall inside an IMAP UID-set range string ("1:*", "101:103,107", "5")? */
function uidInRange(uid: number, range: string): boolean {
  for (const part of range.split(",")) {
    const sep = part.indexOf(":");
    if (sep < 0) {
      if (uid === Number(part)) return true;
    } else {
      const lo = Number(part.slice(0, sep));
      const hiRaw = part.slice(sep + 1);
      if (hiRaw === "*") {
        if (uid >= lo) return true;
      } else if (uid >= lo && uid <= Number(hiRaw)) {
        return true;
      }
    }
  }
  return false;
}

function fakeListResponse(f: FakeFolder): ListResponse {
  return {
    path: f.path,
    pathAsListed: f.path,
    name: f.path.split("/").pop() ?? f.path,
    delimiter: "/",
    parent: [],
    parentPath: "",
    flags: new Set<string>(f.specialUse ? [f.specialUse] : []),
    specialUse: f.specialUse,
    listed: true,
    subscribed: true,
  };
}

function fakeMailbox(f: FakeFolder): MailboxObject {
  return {
    path: f.path,
    delimiter: "/",
    flags: new Set<string>(),
    uidValidity: f.uidValidity,
    uidNext: (f.messages?.length ?? 0) + 1,
    exists: f.messages?.length ?? 0,
    highestModseq: f.highestModseq,
  };
}

/**
 * Build a fake `ImapClientFactory` + a `handle` that records every interaction. Each factory call
 * (one per sync run) returns a client bound to the next configured round; the handle counters
 * aggregate across all clients so a multi-round DB test can assert connect/logout/open totals.
 */
export function makeFakeImap(config: FakeImapConfig): FakeImapHandle {
  const handle: FakeImapHandle = {
    factory: () => {
      throw new Error("factory not wired");
    },
    clientOptions: [],
    connects: 0,
    logouts: 0,
    opens: [],
    fetches: [],
    searches: [],
    listCalls: 0,
  };
  let roundIndex = 0;

  handle.factory = (options: ImapFlowOptions): ImapClient => {
    handle.clientOptions.push(options);
    const round = config.rounds[Math.min(roundIndex, config.rounds.length - 1)];
    roundIndex++;
    const folders = round.folders;
    let expungeListener: ((e: ExpungeEvent) => void) | null = null;
    let current: FakeFolder | null = null;

    const client: ImapClient = {
      async connect() {
        if (config.failConnect) {
          // Deliberately leak the ASP so the test can prove the connector MASKS it.
          throw new Error(`FAKE-IMAP auth refused [pass=${options.auth?.pass ?? ""}]`);
        }
        handle.connects++;
      },
      async logout() {
        handle.logouts++;
      },
      async list() {
        handle.listCalls++;
        return folders.map(fakeListResponse);
      },
      async mailboxOpen(path, openOpts) {
        const f = folders.find((x) => x.path === path);
        if (!f) throw new Error("FAKE-IMAP no such mailbox");
        current = f;
        const qresync = openOpts?.changedSince != null && openOpts?.uidValidity != null;
        handle.opens.push({ path, qresync });
        // VANISHED (EARLIER) only flows when the passed UIDVALIDITY matches the live one (RFC 7162).
        if (qresync && openOpts?.uidValidity === f.uidValidity && expungeListener) {
          for (const uid of f.vanished ?? []) {
            expungeListener({ path: f.path, uid, vanished: true, earlier: true });
          }
        }
        return fakeMailbox(f);
      },
      async search(query: SearchObject, searchOpts?: { uid?: boolean }) {
        const f = current;
        handle.searches.push({ path: f?.path ?? null, query, uid: searchOpts?.uid });
        if (f?.searchThrows) {
          // Deliberately leak the ASP so the test can prove the connector MASKS/swallows it.
          throw new Error(`FAKE-IMAP search failed [pass=${options.auth?.pass ?? ""}]`);
        }
        if (f?.searchFails) return false;
        return f?.searchUids ?? (f?.messages ?? []).map((m) => m.uid);
      },
      fetch(range: string, _query, fetchOpts?: FetchOptions) {
        const f = current;
        handle.fetches.push({ path: f?.path ?? null, range, changedSince: fetchOpts?.changedSince });
        // Production-realistic: yield only the messages whose uid falls inside the requested range
        // ("1:*" matches everything), so exact-UID-set windowed fetches are meaningfully asserted.
        const msgs = (f?.messages ?? []).filter((m) => uidInRange(m.uid, range));
        return (async function* () {
          for (const m of msgs) yield m;
        })();
      },
      async fetchOne(seq) {
        const body = config.bodyByUid?.[Number(seq)];
        return body ?? false;
      },
      on(_event, listener) {
        expungeListener = listener;
        return client;
      },
    };
    return client;
  };

  return handle;
}
