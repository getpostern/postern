// Gmail IMAP fixtures — production string forms of the IMAP ENVELOPE / FLAGS / BODYSTRUCTURE the
// imapflow `fetch` call yields, plus a small configurable FAKE imapflow client for the network-free
// unit tests and the DB round-trip.
//
// Message shapes mirror what imapflow returns for `{ envelope, flags, internalDate, bodyStructure,
// threadId, labels, uid }`: an ENVELOPE with from/sender (name+address), subject, messageId, and a
// Date `date`; FLAGS as a Set ("\\Seen" → read); a BODYSTRUCTURE MIME tree (an attachment leaf has a
// non-inline disposition); X-GM-THRID as `threadId`, X-GM-MSGID as `emailId`, X-GM-LABELS as `labels`
// (store-only). The by-id body result adds `source` (the RFC822 Buffer) — fetched on demand, never
// stored. The fake client supports per-run "rounds" so the DB test can drive initial → VANISHED →
// re-sighting against one registered connector. UID SEARCH (the windowed backfill / daily census) is
// served per folder — `searchUids` (default: the uids of `messages`), `searchFails` (resolves false),
// or `searchThrows` (rejects, embedding the password to prove masking) — and every search call is
// recorded on the handle ({path, query}) so tests assert the issued SINCE date and its 1-day pad.
// fetch() honors the requested UID range, so exact-set windowed fetches are meaningfully asserted.

import type {
  ImapFlowOptions,
  ListResponse,
  MailboxObject,
  FetchMessageObject,
  FetchOptions,
  ExpungeEvent,
  SearchObject,
} from "imapflow";
import type { ImapClient, ImapClientFactory } from "./gmail.js";

// ── Folder identity ─────────────────────────────────────────────────────────────────
export const INBOX_PATH = "INBOX";
// A LOCALIZED Sent path — the connector must DISCOVER it via SPECIAL-USE `\Sent`, never hardcode it.
export const SENT_PATH = "[Gmail]/Sent Mail";
export const SPAM_PATH = "[Gmail]/Spam"; // a decoy: present in LIST, must NOT be synced

export const UIDVALIDITY_INBOX = 10_000n;
export const UIDVALIDITY_SENT = 20_000n;

// ── Messages (envelope only — no body) ────────────────────────────────────────────────

/** Unread, with a PDF attachment. from === sender (no delegate). uid 101. */
export const INBOX_MSG_1: FetchMessageObject = {
  seq: 1,
  uid: 101,
  emailId: "GM-MSGID-1000001", // X-GM-MSGID
  threadId: "GM-THRID-2000001", // X-GM-THRID
  flags: new Set<string>(), // unread (no \Seen)
  labels: new Set<string>(["\\Inbox", "Work"]), // X-GM-LABELS (store-only)
  internalDate: new Date("2026-06-12T09:30:00.000Z"),
  envelope: {
    date: new Date("2026-06-12T09:29:55.000Z"),
    subject: "Q3 planning agenda",
    messageId: "<CY4PR01MB-inbox-0001@contoso.example.com>",
    from: [{ name: "Alice Sender", address: "alice@contoso.example.com" }],
    sender: [{ name: "Alice Sender", address: "alice@contoso.example.com" }],
    to: [{ name: "Operator", address: "operator@example.com" }],
  },
  bodyStructure: {
    type: "multipart/mixed",
    childNodes: [
      { type: "text/plain" },
      {
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "agenda.pdf" },
      },
    ],
  },
};

/** Read, no attachment, DELEGATE sender (≠ from). uid 102. */
export const INBOX_MSG_2: FetchMessageObject = {
  seq: 2,
  uid: 102,
  emailId: "GM-MSGID-1000002",
  threadId: "GM-THRID-2000002",
  flags: new Set<string>(["\\Seen"]), // read
  labels: new Set<string>(["\\Inbox"]),
  internalDate: new Date("2026-06-11T15:05:00.000Z"),
  envelope: {
    date: new Date("2026-06-11T15:04:30.000Z"),
    subject: "Lunch?",
    messageId: "<CY4PR01MB-inbox-0002@partner.example.org>",
    from: [{ name: "Carol Friend", address: "carol@partner.example.org" }],
    sender: [{ name: "Assistant On Behalf", address: "assistant@partner.example.org" }],
    to: [{ name: "Operator", address: "operator@example.com" }],
  },
  bodyStructure: { type: "text/plain" },
};

/** A message in the Sent folder — folder enum must resolve to `sent`. uid 201. */
export const SENT_MSG_1: FetchMessageObject = {
  seq: 1,
  uid: 201,
  emailId: "GM-MSGID-1000201",
  threadId: "GM-THRID-2000002",
  flags: new Set<string>(["\\Seen"]),
  labels: new Set<string>(["\\Sent"]),
  internalDate: new Date("2026-06-11T15:20:00.000Z"),
  envelope: {
    date: new Date("2026-06-11T15:20:00.000Z"),
    subject: "RE: Lunch?",
    messageId: "<CY4PR01MB-sent-0001@gmail.com>",
    from: [{ name: "Operator", address: "operator@example.com" }],
    sender: [{ name: "Operator", address: "operator@example.com" }],
    to: [{ name: "Carol Friend", address: "carol@partner.example.org" }],
  },
  bodyStructure: { type: "text/plain" },
};

/**
 * A minimal production-shaped envelope message whose INTERNALDATE sits `daysAgo` days in the past —
 * the recency-window tests (in-window skip, sweep scope, grow/shrink) need dates relative to NOW
 * because the connector derives the window from Date.now() per run.
 */
export function msgAt(uid: number, daysAgo: number): FetchMessageObject {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    seq: uid,
    uid,
    emailId: `GM-MSGID-${uid}`,
    threadId: `GM-THRID-${uid}`,
    flags: new Set<string>(),
    labels: new Set<string>(["\\Inbox"]),
    internalDate: d,
    envelope: {
      date: d,
      subject: `synthetic message ${uid}`,
      messageId: `<synthetic-${uid}@example.com>`,
      from: [{ name: "Synthetic Sender", address: "sender@example.com" }],
      sender: [{ name: "Synthetic Sender", address: "sender@example.com" }],
      to: [{ name: "Operator", address: "operator@example.com" }],
    },
    bodyStructure: { type: "text/plain" },
  };
}

// ── By-id body result (fetchRecordLive) — includes the RFC822 `source`, never stored ──────
export const BODY_RFC822 =
  "From: Alice Sender <alice@contoso.example.com>\r\n" +
  "To: Operator <operator@example.com>\r\n" +
  "Subject: Q3 planning agenda\r\n" +
  "Message-ID: <CY4PR01MB-inbox-0001@contoso.example.com>\r\n" +
  "\r\n" +
  "Here is the proposed agenda for the Q3 planning session next week.\r\n";

export const MESSAGE_BODY_RESULT: FetchMessageObject = {
  seq: 1,
  uid: 101,
  source: Buffer.from(BODY_RFC822, "utf8"),
  envelope: INBOX_MSG_1.envelope,
  bodyStructure: INBOX_MSG_1.bodyStructure,
};

// ── A configurable fake imapflow client ─────────────────────────────────────────────────

/** One folder's per-run state for the fake. */
export interface FakeFolder {
  path: string;
  /** RFC-6154 SPECIAL-USE flag, e.g. "\\Inbox" | "\\Sent" | "\\Junk". */
  specialUse?: string;
  uidValidity: bigint;
  highestModseq: bigint;
  /** Messages the `fetch` call yields for this folder this run (filtered by the requested range). */
  messages?: FetchMessageObject[];
  /** UIDs reported as VANISHED (EARLIER) on an incremental open (when UIDVALIDITY matches). */
  vanished?: number[];
  /** UID SEARCH result for this folder this run; default = the uids of `messages`. */
  searchUids?: number[];
  /** search() resolves `false` (imapflow's failure shape) — a failed census/backfill search. */
  searchFails?: boolean;
  /** search() REJECTS with an error that EMBEDS the password (to prove masking on the search path). */
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
  /** When true, `connect()` rejects with an error that EMBEDS the password (to prove masking). */
  failConnect?: boolean;
  /**
   * When true, `connect()` rejects with imapflow's REAL auth-refusal shape
   * (`authenticationFailed: true` + `serverResponseCode` + the server's `response` text — per
   * node_modules/imapflow/lib/commands/login.js), with the password embedded in the response text
   * so a test can prove the connector names the cause WITHOUT echoing the server's words.
   */
  failConnectAuth?: boolean;
  /**
   * When true, `connect()` rejects with imapflow's bare `AuthenticationFailure` CLASS-FIELD shape
   * (`authenticationFailed: true`, NO serverResponseCode, NO response — lib/imap-flow.js:1472
   * "Login is disabled" et al.). NOT a credential rejection: the connector must take the generic
   * path, never the rotate-your-app-password message.
   */
  failConnectAuthClassOnly?: boolean;
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
          // Deliberately leak the password so the test can prove the connector MASKS it.
          throw new Error(`FAKE-IMAP auth refused [pass=${options.auth?.pass ?? ""}]`);
        }
        if (config.failConnectAuth) {
          // imapflow's real refusal shape (login.js): message + authenticationFailed +
          // serverResponseCode + response. The password rides the response text on purpose —
          // the connector must name the cause in its OWN words, never echo these.
          const err = new Error("Command failed") as Error & {
            authenticationFailed: boolean;
            serverResponseCode: string;
            response: string;
          };
          err.authenticationFailed = true;
          err.serverResponseCode = "AUTHENTICATIONFAILED";
          err.response = `Invalid credentials (Failure) [pass=${options.auth?.pass ?? ""}]`;
          throw err;
        }
        if (config.failConnectAuthClassOnly) {
          // The bare class-field shape (imap-flow.js "Login is disabled" et al.) — auth-adjacent,
          // NOT a credential rejection; no serverResponseCode, no response.
          const err = new Error("Login is disabled") as Error & { authenticationFailed: boolean };
          err.authenticationFailed = true;
          throw err;
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
          // Deliberately leak the password so the test can prove the connector MASKS/swallows it.
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
