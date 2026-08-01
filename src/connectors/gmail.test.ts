// Gmail connector unit tests — DB-free, imapflow mocked via the injectable client factory. Covers:
// declared shape (read-only, poll @ 10min, incremental); normalize (the 15 envelope scalars;
// from/sender split; INTERNALDATE → received_at; \Seen → is_read; attachments from BODYSTRUCTURE;
// folder enum; snippet/importance null); per-folder CONDSTORE sync (incremental changedSince yields
// envelopes + advances the {uidValidity,modseq} cursor map; the combined cursor JSON round-trips);
// UIDVALIDITY change forces a FULL folder resync; QRESYNC VANISHED → RawRecord{deleted:true,
// externalId:"<folder>:<uid>"}; envelope-only footprint (no body in raw); \Sent discovered via
// SPECIAL-USE (not hardcoded) + INBOX+Sent only; strongKeys; read-only execute(); secret-free
// errors + logger:false + one connection with logout(); and the fetchRecordLive body drill.
//
// RECENCY WINDOW (ADR 0017 fast-follow): the windowed backfill (UID SEARCH SINCE with the 1-day pad
// → exact-set range-compacted ≤1000-UID chunked fetches, never 1:*), the null-window back-compat
// pin (no search, 1:*, no sweep), the incremental in-window skip, and the DAILY census+sweep
// (reserved `_census` cursor key; window-scoped reconcileObjectSnapshot — mocked here, the runner
// module is DB-backed; partial/failed census never sweeps and never advances the clock).
//
// BLOCK fold (2026-07-11): the folder-vanish sweep guard (a stored-cursor folder absent from
// discovery withholds the sweep), resurrectPresent:true on the sweep call, the ONE masked census
// warn (folder enum only, zero error detail), and the > 200,000-UID census sanity cap.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileObjectSnapshot } from "../sync/runner.js";
import type { RawRecord, SyncContext } from "./types.js";
import { GmailConnector, type MailMessageRow } from "./gmail.js";
import {
  INBOX_MSG_1,
  INBOX_MSG_2,
  SENT_MSG_1,
  MESSAGE_BODY_RESULT,
  INBOX_PATH,
  SENT_PATH,
  SPAM_PATH,
  UIDVALIDITY_INBOX,
  UIDVALIDITY_SENT,
  makeFakeImap,
  msgAt,
  type FakeImapConfig,
  type FakeFolder,
} from "./gmail.fixtures.js";

// DB-free: replace the runner module (gmail.ts imports only reconcileObjectSnapshot from it).
vi.mock("../sync/runner.js", () => ({
  reconcileObjectSnapshot: vi.fn(async () => 0),
}));
const reconcileMock = vi.mocked(reconcileObjectSnapshot);

// The BLOCK-fold census warn (folder enum only, ZERO error detail) — spied so tests assert the
// masked shape and the suite's output stays clean.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  reconcileMock.mockClear();
  reconcileMock.mockResolvedValue(0);
  warnSpy.mockClear();
});

const PASS = "app-pw-SECRET-abcd-efgh-ijkl"; // a Gmail app-password (never expected in logs/errors)
const USER = "operator@example.com";

async function collect(it: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    connectionId: "22222222-2222-2222-2222-222222222222",
    secretRef: "sec_x",
    secret: PASS,
    username: USER,
    sector: "mail",
    ...over,
  };
}

/** A first-run (no cursor) two-folder fake: INBOX (2 msgs) + Sent (1 msg), plus a Spam decoy. */
function firstRun(over: Partial<FakeImapConfig> = {}): FakeImapConfig {
  return {
    rounds: [
      {
        folders: [
          {
            path: INBOX_PATH,
            specialUse: "\\Inbox",
            uidValidity: UIDVALIDITY_INBOX,
            highestModseq: 55n,
            messages: [INBOX_MSG_1, INBOX_MSG_2],
          },
          {
            path: SENT_PATH,
            specialUse: "\\Sent",
            uidValidity: UIDVALIDITY_SENT,
            highestModseq: 77n,
            messages: [SENT_MSG_1],
          },
          { path: SPAM_PATH, specialUse: "\\Junk", uidValidity: 0n, highestModseq: 0n },
        ],
      },
    ],
    ...over,
  };
}

describe("GmailConnector — declared shape", () => {
  const c = new GmailConnector();
  it("is mail, read-only, poll @ 10min, incremental", () => {
    expect(c.provider).toBe("gmail");
    expect(c.sector).toBe("mail");
    expect(c.objectType).toBe("message");
    expect(c.actions).toEqual([]);
    expect(c.policy).toEqual({
      mode: "poll",
      defaultIntervalSec: 600,
      minIntervalSec: 300, // ADR 0025 — the cadence floor (IMAP connection/bandwidth caps)
      freshnessToleranceSec: 600,
      supportsIncremental: true,
    });
  });
  it("execute() throws (mail is read-only this wave)", async () => {
    await expect(c.execute()).rejects.toThrow(/read-only/);
  });
});

describe("GmailConnector.sync — folder discovery + first-run full fetch", () => {
  it("opens INBOX + the SPECIAL-USE Sent path only (no hardcoding, no Spam), full fetch on first run", async () => {
    const fake = makeFakeImap(firstRun());
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx()));

    // Three envelope records in stream order: inbox (2) then sent (1). No tombstones on a first run.
    expect(recs.map((r) => r.externalId)).toEqual(["inbox:101", "inbox:102", "sent:201"]);
    expect(recs.every((r) => r.deleted !== true)).toBe(true);

    // Exactly INBOX + the localized Sent path were opened — the Spam decoy was ignored.
    expect(fake.opens.map((o) => o.path)).toEqual([INBOX_PATH, SENT_PATH]);
    expect(fake.opens.some((o) => o.path === SPAM_PATH)).toBe(false);
    // First run ⇒ no stored cursor ⇒ no QRESYNC params ⇒ a FULL fetch (changedSince undefined).
    expect(fake.opens.every((o) => o.qresync === false)).toBe(true);
    expect(fake.fetches.every((f) => f.changedSince === undefined)).toBe(true);

    // One short-lived connection, logged out.
    expect(fake.clientOptions).toHaveLength(1);
    expect(fake.connects).toBe(1);
    expect(fake.logouts).toBe(1);
  });

  it("sets logger:false + qresync:true + TLS auth (the app-password never reaches a logger)", async () => {
    const fake = makeFakeImap(firstRun());
    await collect(new GmailConnector(fake.factory).sync(ctx()));
    const opts = fake.clientOptions[0];
    expect(opts.logger).toBe(false);
    expect(opts.qresync).toBe(true);
    expect(opts.host).toBe("imap.gmail.com");
    expect(opts.port).toBe(993);
    expect(opts.secure).toBe(true);
    expect(opts.auth).toEqual({ user: USER, pass: PASS });
  });

  it("the combined per-folder {uidValidity,modseq} cursor map rides the LAST record and round-trips", async () => {
    const fake = makeFakeImap(firstRun());
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx()));
    const last = recs[recs.length - 1];
    expect(last.cursor).toBeTypeOf("string");
    const map = JSON.parse(last.cursor!) as Record<string, { uidValidity: string; modseq: string }>;
    expect(map.inbox).toEqual({ uidValidity: "10000", modseq: "55" });
    expect(map.sent).toEqual({ uidValidity: "20000", modseq: "77" });
    // Only the last record carries a cursor.
    expect(recs.slice(0, -1).every((r) => r.cursor == null)).toBe(true);
  });

  it("yields ONLY the envelope — no body content in raw", async () => {
    const fake = makeFakeImap(firstRun());
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx()));
    for (const r of recs) {
      const raw = r.raw as Record<string, unknown>;
      expect(Object.hasOwn(raw, "body")).toBe(false);
      expect(Object.hasOwn(raw, "source")).toBe(false);
      expect(Object.hasOwn(raw, "__pci_folder")).toBe(true); // synthetic folder thread (not a column)
    }
  });

  it("throws a secret-free error when the app-password or username is missing", async () => {
    const fake = makeFakeImap(firstRun());
    await expect(collect(new GmailConnector(fake.factory).sync(ctx({ secret: null })))).rejects.toThrow(
      /missing app-password or username/,
    );
    await expect(
      collect(new GmailConnector(fake.factory).sync(ctx({ username: null }))),
    ).rejects.toThrow(/missing app-password or username/);
  });
});

describe("GmailConnector.sync — incremental CONDSTORE", () => {
  /** A stored cursor for INBOX (modseq 55, uidValidity 10000) → incremental open. */
  const storedCursor = JSON.stringify({ inbox: { uidValidity: "10000", modseq: "55" } });

  it("opens with QRESYNC params, fetches changedSince, and advances the folder modseq", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX, // unchanged ⇒ incremental, not reset
              highestModseq: 90n,
              messages: [INBOX_MSG_2], // one changed message
            },
          ],
        },
      ],
    });
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ cursor: storedCursor })));

    expect(recs.map((r) => r.externalId)).toEqual(["inbox:102"]);
    // QRESYNC params rode the open; the fetch carried changedSince = the stored modseq (55).
    expect(fake.opens[0].qresync).toBe(true);
    expect(fake.fetches[0].changedSince).toBe(55n);
    // The folder modseq advanced to the live highestModseq.
    const map = JSON.parse(recs[recs.length - 1].cursor!) as Record<
      string,
      { uidValidity: string; modseq: string }
    >;
    expect(map.inbox).toEqual({ uidValidity: "10000", modseq: "90" });
  });

  it("a UIDVALIDITY change forces a FULL folder resync (no changedSince) and resets the cursor", async () => {
    const staleCursor = JSON.stringify({ inbox: { uidValidity: "9999", modseq: "55" } });
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX, // 10000 ≠ stored 9999 ⇒ reset
              highestModseq: 120n,
              messages: [INBOX_MSG_1, INBOX_MSG_2],
            },
          ],
        },
      ],
    });
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ cursor: staleCursor })));

    expect(recs.map((r) => r.externalId)).toEqual(["inbox:101", "inbox:102"]);
    // Reset ⇒ a FULL fetch: changedSince must be absent even though a (stale) cursor existed.
    expect(fake.fetches[0].changedSince).toBeUndefined();
    const map = JSON.parse(recs[recs.length - 1].cursor!) as Record<
      string,
      { uidValidity: string; modseq: string }
    >;
    expect(map.inbox).toEqual({ uidValidity: "10000", modseq: "120" });
  });

  it("QRESYNC VANISHED UIDs become RawRecord{deleted:true, externalId:'<folder>:<uid>'}", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX, // matches stored ⇒ VANISHED flows
              highestModseq: 95n,
              messages: [], // no content changes this run
              vanished: [101, 102],
            },
          ],
        },
      ],
    });
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ cursor: storedCursor })));

    const deleted = recs.filter((r) => r.deleted === true);
    expect(deleted.map((r) => r.externalId)).toEqual(["inbox:101", "inbox:102"]);
    expect(deleted.every((r) => r.raw === null)).toBe(true);
    // The cursor still advances and rides the last (deletion) record.
    const map = JSON.parse(recs[recs.length - 1].cursor!) as Record<
      string,
      { uidValidity: string; modseq: string }
    >;
    expect(map.inbox).toEqual({ uidValidity: "10000", modseq: "95" });
  });

  it("a no-change run yields nothing (cursor unchanged is acceptable)", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX,
              highestModseq: 55n,
              messages: [],
            },
          ],
        },
      ],
    });
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ cursor: storedCursor })));
    expect(recs).toHaveLength(0);
    expect(fake.logouts).toBe(1); // still logged out
  });
});

describe("GmailConnector.normalize", () => {
  const c = new GmailConnector();

  async function firstRunRecords(): Promise<RawRecord[]> {
    const fake = makeFakeImap(firstRun());
    return collect(new GmailConnector(fake.factory).sync(ctx()));
  }

  it("maps an inbox message → the 14 scalars (from=sender, INTERNALDATE→received_at, \\Seen, attachments, folder)", async () => {
    const recs = await firstRunRecords();
    const row = c.normalize(recs.find((r) => r.externalId === "inbox:101")!) as MailMessageRow;
    expect(row).toEqual({
      source_object_id: "inbox:101",
      thread_id: "GM-THRID-2000001",
      message_id_header: "<CY4PR01MB-inbox-0001@contoso.example.com>",
      from_address: "alice@contoso.example.com",
      from_name: "Alice Sender",
      sender_address: null, // sender === from ⇒ null
      subject: "Q3 planning agenda",
      snippet: null, // V0: IMAP has no snippet
      sent_at: "2026-06-12T09:29:55.000Z",
      received_at: "2026-06-12T09:30:00.000Z", // INTERNALDATE
      is_read: false, // no \Seen
      has_attachments: true, // BODYSTRUCTURE has an attachment-disposition leaf
      folder: "inbox",
      importance: null, // Outlook-only
    });
  });

  it("keeps a delegate sender distinct from `from` and reads \\Seen as is_read", async () => {
    const recs = await firstRunRecords();
    const row = c.normalize(recs.find((r) => r.externalId === "inbox:102")!) as MailMessageRow;
    expect(row.from_address).toBe("carol@partner.example.org");
    expect(row.sender_address).toBe("assistant@partner.example.org");
    expect(row.is_read).toBe(true);
    expect(row.has_attachments).toBe(false); // text/plain only
  });

  it("maps a Sent message → folder=sent", async () => {
    const recs = await firstRunRecords();
    const row = c.normalize(recs.find((r) => r.externalId === "sent:201")!) as MailMessageRow;
    expect(row.folder).toBe("sent");
    expect(row.from_address).toBe("operator@example.com");
  });

  it("never emits a non-REGISTRY key (no id, no raw, no labels, no body); exactly 14 keys", async () => {
    const recs = await firstRunRecords();
    const row = c.normalize(recs.find((r) => r.externalId === "inbox:101")!) as MailMessageRow;
    const keys = Object.keys(row);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("raw");
    expect(keys).not.toContain("labels");
    expect(keys).not.toContain("body");
    expect(keys).toHaveLength(14); // the 15 REGISTRY mail scalars minus `id` (the runner injects id)
  });
});

describe("GmailConnector.strongKeys", () => {
  const c = new GmailConnector();
  it("returns { gmail_msgid: X-GM-MSGID, message_id: Message-ID header }", async () => {
    const fake = makeFakeImap(firstRun());
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx()));
    const rec = recs.find((r) => r.externalId === "inbox:101")!;
    expect(c.strongKeys(rec)).toEqual({
      gmail_msgid: "GM-MSGID-1000001",
      message_id: "<CY4PR01MB-inbox-0001@contoso.example.com>",
    });
  });
});

describe("GmailConnector — secret-free errors", () => {
  it("a connect failure throws a secret-free error (no app-password in the message)", async () => {
    const fake = makeFakeImap({ ...firstRun(), failConnect: true });
    try {
      await collect(new GmailConnector(fake.factory).sync(ctx()));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toBe("gmail: sync failed");
      expect(msg).not.toContain(PASS);
    }
    // Even a failed run logs out (best-effort teardown).
    expect(fake.logouts).toBe(1);
  });
});

// ── #121: an IMAP auth refusal names itself; everything else keeps the generic path ─────────────
//
// The dead-end this pins: a wrong 16-character paste — the likeliest stranger failure on this card
// — collapsed into `gmail: sync failed`, indistinguishable from a network blip. The refusal now
// carries the G1-proven remedy (2SV first, then the DIRECT app-passwords URL), in OUR words only:
// imapflow's error carries the server's response text and it is never echoed.
describe("GmailConnector — an auth refusal names the app-password cause (#121)", () => {
  const REFUSED_MSG =
    "gmail: sign-in refused — Gmail did not accept the address or app password. Turn on " +
    "2-Step Verification first (the app-passwords page does not exist without it), then create a " +
    "fresh app password at myaccount.google.com/apppasswords and reconnect with it.";

  it("an imapflow auth refusal on sync → the exact named-cause message, never the server's text, never the password", async () => {
    const fake = makeFakeImap({ ...firstRun(), failConnectAuth: true });
    try {
      await collect(new GmailConnector(fake.factory).sync(ctx()));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toBe(REFUSED_MSG);
      // The load-bearing facts: 2SV precondition + the direct URL (searching Security finds nothing).
      expect(msg).toContain("2-Step Verification");
      expect(msg).toContain("myaccount.google.com/apppasswords");
      // Never the password, never the server's own words (provider-controlled).
      expect(msg).not.toContain(PASS);
      expect(msg).not.toContain("Invalid credentials");
      // maskError truncates persisted errors at 500 chars — the remedy must survive intact.
      expect(msg.length).toBeLessThanOrEqual(500);
    }
    // Even a refused run logs out (best-effort teardown).
    expect(fake.logouts).toBe(1);
  });

  it("BOTH DIRECTIONS: a non-auth connect failure still takes the generic path", async () => {
    const fake = makeFakeImap({ ...firstRun(), failConnect: true });
    await expect(collect(new GmailConnector(fake.factory).sync(ctx()))).rejects.toThrow(
      /^gmail: sync failed$/,
    );
  });

  it("BOTH DIRECTIONS: a NON-CREDENTIAL AuthenticationFailure ('Login is disabled') takes the generic path — never the rotate message", async () => {
    // `authenticationFailed: true` is a CLASS FIELD on imapflow's AuthenticationFailure, thrown
    // for six auth-adjacent conditions that are NOT a rejected password (imap-flow.js:1441-1491).
    // The rotate message on a working app password would send the user to REVOKE it at Google.
    // The real rejection (login.js) carries serverResponseCode/response — the class field alone
    // must not fire.
    //
    // MUTATION: loosen isImapAuthRefusal back to `authenticationFailed === true` alone → red.
    const fake = makeFakeImap({ ...firstRun(), failConnectAuthClassOnly: true });
    await expect(collect(new GmailConnector(fake.factory).sync(ctx()))).rejects.toThrow(
      /^gmail: sync failed$/,
    );
  });

  it("BOTH DIRECTIONS: a failed backfill search still takes the generic path, not the auth message", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX,
              highestModseq: 55n,
              messages: [],
              searchThrows: true,
            },
          ],
        },
      ],
    });
    await expect(
      collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 }))),
    ).rejects.toThrow(/^gmail: sync failed$/);
  });

  it("the same refusal on the live body drill names itself too", async () => {
    const fake = makeFakeImap({
      rounds: [{ folders: [{ path: INBOX_PATH, uidValidity: UIDVALIDITY_INBOX, highestModseq: 1n }] }],
      failConnectAuth: true,
    });
    await expect(
      new GmailConnector(fake.factory).fetchRecordLive(ctx(), "inbox:101"),
    ).rejects.toThrow(/^gmail: sign-in refused/);
  });
});

describe("GmailConnector.fetchRecordLive — body on demand", () => {
  const c = new GmailConnector();

  it("opens INBOX, FETCHes the UID source, and returns the RFC822 body (stores nothing)", async () => {
    const fake = makeFakeImap({
      rounds: [{ folders: [{ path: INBOX_PATH, uidValidity: UIDVALIDITY_INBOX, highestModseq: 1n }] }],
      bodyByUid: { 101: MESSAGE_BODY_RESULT },
    });
    const out = (await new GmailConnector(fake.factory).fetchRecordLive(ctx(), "inbox:101")) as {
      uid: number;
      source: string;
    };
    expect(out.uid).toBe(101);
    expect(out.source).toContain("agenda");
    expect(fake.opens.map((o) => o.path)).toEqual([INBOX_PATH]);
    expect(fake.logouts).toBe(1);
  });

  it("discovers the localized Sent path via SPECIAL-USE for a sent: drill", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            { path: INBOX_PATH, specialUse: "\\Inbox", uidValidity: UIDVALIDITY_INBOX, highestModseq: 1n },
            { path: SENT_PATH, specialUse: "\\Sent", uidValidity: UIDVALIDITY_SENT, highestModseq: 1n },
          ],
        },
      ],
      bodyByUid: { 201: MESSAGE_BODY_RESULT },
    });
    await new GmailConnector(fake.factory).fetchRecordLive(ctx(), "sent:201");
    expect(fake.listCalls).toBe(1); // discovered, not hardcoded
    expect(fake.opens.map((o) => o.path)).toEqual([SENT_PATH]);
  });

  it("returns null on a UID miss (incl. UIDVALIDITY changed since the cache write)", async () => {
    const fake = makeFakeImap({
      rounds: [{ folders: [{ path: INBOX_PATH, uidValidity: UIDVALIDITY_INBOX, highestModseq: 1n }] }],
      bodyByUid: { 101: false }, // the UID no longer resolves
    });
    expect(await new GmailConnector(fake.factory).fetchRecordLive(ctx(), "inbox:101")).toBeNull();
  });

  it("throws a secret-free error when the app-password or username is missing", async () => {
    await expect(c.fetchRecordLive(ctx({ secret: null }), "inbox:101")).rejects.toThrow(
      /missing app-password or username/,
    );
    await expect(c.fetchRecordLive(ctx({ username: null }), "inbox:101")).rejects.toThrow(
      /missing app-password or username/,
    );
  });

  it("rejects a malformed record id", async () => {
    const fake = makeFakeImap({ rounds: [{ folders: [] }] });
    await expect(new GmailConnector(fake.factory).fetchRecordLive(ctx(), "not-an-id")).rejects.toThrow(
      /malformed record id/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Recency window (ADR 0017 fast-follow): windowed backfill, in-window incremental skip,
// daily census + window-scoped sweep, `_census` cursor clock.
// ─────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const TOL_MS = 30_000; // the connector derives the window from Date.now() per run

/** The SINCE date a recorded search query carried, as epoch ms. */
function sinceMs(q: unknown): number {
  const s = (q as { since: Date | string }).since;
  return s instanceof Date ? s.getTime() : Date.parse(s);
}

/** A single-folder INBOX fake round (no Sent in LIST — also the Sent-less mailbox shape). */
function inboxOnly(over: Partial<FakeFolder> = {}): FakeImapConfig {
  return {
    rounds: [
      {
        folders: [
          {
            path: INBOX_PATH,
            specialUse: "\\Inbox",
            uidValidity: UIDVALIDITY_INBOX,
            highestModseq: 90n,
            ...over,
          },
        ],
      },
    ],
  };
}

describe("GmailConnector.sync — windowed backfill (UID SEARCH SINCE)", () => {
  it("issues UID SEARCH SINCE with the 1-day pad per folder and fetches EXACTLY the returned set — never 1:*", async () => {
    const fake = makeFakeImap(firstRun());
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));

    // Records flow exactly as the unwindowed first run (everything is in-window).
    expect(recs.map((r) => r.externalId)).toEqual(["inbox:101", "inbox:102", "sent:201"]);

    // One UID SEARCH per synced folder (the Spam decoy still ignored), uid:true.
    expect(fake.searches.map((s) => s.path)).toEqual([INBOX_PATH, SENT_PATH]);
    expect(fake.searches.every((s) => s.uid === true)).toBe(true);
    // SINCE = now − (windowDays + 1)d — the 1-day pad for Gmail's INTERNALDATE quirks.
    for (const s of fake.searches) {
      expect(Math.abs(sinceMs(s.query) - (Date.now() - 181 * DAY_MS))).toBeLessThan(TOL_MS);
    }

    // The fetch targets are EXACTLY the searched UID sets, range-compacted — never 1:*.
    expect(fake.fetches.map((f) => f.range)).toEqual(["101:102", "201"]);
    expect(fake.fetches.some((f) => f.range === "1:*")).toBe(false);
    // Still one short-lived connection, logged out.
    expect(fake.connects).toBe(1);
    expect(fake.logouts).toBe(1);
  });

  it("range-compacts a non-contiguous UID set", async () => {
    const fake = makeFakeImap(inboxOnly({ searchUids: [5, 6, 7, 9, 42], messages: [] }));
    await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));
    expect(fake.fetches.map((f) => f.range)).toEqual(["5:7,9,42"]);
  });

  it("chunks >1000 UIDs into sequential ≤1000-UID fetch commands", async () => {
    const uids = Array.from({ length: 1500 }, (_, i) => i + 1);
    const fake = makeFakeImap(inboxOnly({ searchUids: uids, messages: [] }));
    await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));
    expect(fake.fetches.map((f) => f.range)).toEqual(["1:1000", "1001:1500"]);
  });

  it("an empty SEARCH result fetches nothing and is a COMPLETE census (the sweep still runs)", async () => {
    const fake = makeFakeImap(inboxOnly({ searchUids: [], messages: [] }));
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));
    expect(recs).toHaveLength(0);
    expect(fake.fetches).toHaveLength(0);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect((reconcileMock.mock.calls[0][3] as Set<string>).size).toBe(0);
  });

  it("windowDays null/undefined/0/negative issues NO search, fetches 1:*, and never sweeps (back-compat pin)", async () => {
    for (const w of [null, undefined, 0, -5]) {
      const fake = makeFakeImap(firstRun());
      const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: w })));
      expect(recs.map((r) => r.externalId)).toEqual(["inbox:101", "inbox:102", "sent:201"]);
      expect(fake.searches).toHaveLength(0);
      expect(fake.fetches.every((f) => f.range === "1:*")).toBe(true);
      // The cursor carries the folder map only — no `_census` key without a window.
      const cur = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, unknown>;
      expect(Object.keys(cur).sort()).toEqual(["inbox", "sent"]);
    }
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});

describe("GmailConnector.sync — incremental in-window skip", () => {
  /** A stored INBOX cursor with a FRESH census clock (<24h) so no census search muddies the run. */
  function freshCensusCursor(): string {
    return JSON.stringify({
      inbox: { uidValidity: "10000", modseq: "55" },
      _census: { at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    });
  }

  it("skips a CHANGEDSINCE result older than windowStart − 1d; an in-window one flows; single command", async () => {
    const inWin = msgAt(301, 10);
    const outWin = msgAt(302, 200); // 200d ago < windowStart − 1d for a 180d window
    const fake = makeFakeImap(inboxOnly({ messages: [inWin, outWin] }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor: freshCensusCursor() })),
    );

    expect(recs.map((r) => r.externalId)).toEqual(["inbox:301"]);
    // The single-command shape is preserved: ONE 1:* CHANGEDSINCE fetch, no second round-trip.
    expect(fake.fetches).toHaveLength(1);
    expect(fake.fetches[0].range).toBe("1:*");
    expect(fake.fetches[0].changedSince).toBe(55n);
    expect(fake.searches).toHaveLength(0); // census <24h fresh → no search either
  });

  it("a message inside the 1-day pad (windowStart − 12h) still flows", async () => {
    const padMsg = msgAt(303, 180.5);
    const fake = makeFakeImap(inboxOnly({ messages: [padMsg] }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor: freshCensusCursor() })),
    );
    expect(recs.map((r) => r.externalId)).toEqual(["inbox:303"]);
  });

  it("a message with a missing INTERNALDATE flows (fail-open — never silently drop data)", async () => {
    const noDate = { ...msgAt(304, 10), internalDate: undefined } as unknown as typeof INBOX_MSG_1;
    const fake = makeFakeImap(inboxOnly({ messages: [noDate] }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor: freshCensusCursor() })),
    );
    expect(recs.map((r) => r.externalId)).toEqual(["inbox:304"]);
  });
});

describe("GmailConnector.sync — daily census + window-scoped sweep", () => {
  const CONN = "22222222-2222-2222-2222-222222222222";
  /** A stored INBOX cursor with the census clock `agoMs` in the past (omit for no `_census`). */
  function inboxCursor(censusAgoMs?: number): string {
    const map: Record<string, unknown> = { inbox: { uidValidity: "10000", modseq: "55" } };
    if (censusAgoMs != null) map._census = { at: new Date(Date.now() - censusAgoMs).toISOString() };
    return JSON.stringify(map);
  }

  it("a windowed full resync sweeps window-scoped to received_at ∈ [windowStart+1d, runStart] and stamps _census.at", async () => {
    const fake = makeFakeImap(firstRun());
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const [connId, sector, object, soids, startedAt, window] = reconcileMock.mock.calls[0];
    expect(connId).toBe(CONN);
    expect(sector).toBe("mail");
    expect(object).toBe("message");
    expect([...(soids as Set<string>)].sort()).toEqual(["inbox:101", "inbox:102", "sent:201"]);
    expect(startedAt).toBeInstanceOf(Date);
    // from = windowStart + 1d (one day INSIDE the padded search bound); to ≈ runStartedAt.
    expect(window!.column).toBe("received_at");
    expect(Math.abs(window!.from.getTime() - (Date.now() - 179 * DAY_MS))).toBeLessThan(TOL_MS);
    expect(Math.abs(window!.to.getTime() - Date.now())).toBeLessThan(TOL_MS);
    expect(window!.to.getTime()).toBe((startedAt as Date).getTime());
    // BLOCK fold #2: the sweep is self-healing — a census sighting resurrects a stale tombstone.
    expect(window!.resurrectPresent).toBe(true);

    // The stamped clock rides the LAST record's cursor (and only the last record).
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as { _census?: { at: string } };
    expect(Math.abs(Date.parse(cur._census!.at) - Date.now())).toBeLessThan(TOL_MS);
    expect(recs.slice(0, -1).every((r) => r.cursor == null)).toBe(true);
  });

  it("a Sent-less mailbox sweeps on the inbox census alone (discovered set IS complete)", async () => {
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(310, 5)] }));
    await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect([...(reconcileMock.mock.calls[0][3] as Set<string>)]).toEqual(["inbox:310"]);
  });

  it("incremental <24h after _census.at: NO census search, NO sweep, _census round-trips undisturbed", async () => {
    const cursor = inboxCursor(60 * 60 * 1000); // 1h ago
    const before = (JSON.parse(cursor) as { _census: { at: string } })._census.at;
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(311, 5)] }));
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor })));

    expect(fake.searches).toHaveLength(0);
    expect(reconcileMock).not.toHaveBeenCalled();
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as {
      inbox: { uidValidity: string; modseq: string };
      _census: { at: string };
    };
    expect(cur._census.at).toBe(before); // the clock rode through unchanged
    expect(cur.inbox).toEqual({ uidValidity: "10000", modseq: "90" }); // folder entry undisturbed
  });

  it("incremental ≥24h after _census.at: census search + sweep, the clock advances", async () => {
    const cursor = inboxCursor(25 * 60 * 60 * 1000); // 25h ago
    const before = (JSON.parse(cursor) as { _census: { at: string } })._census.at;
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(312, 5)], searchUids: [312, 313] }));
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor })));

    expect(fake.searches.map((s) => s.path)).toEqual([INBOX_PATH]);
    expect(Math.abs(sinceMs(fake.searches[0].query) - (Date.now() - 181 * DAY_MS))).toBeLessThan(TOL_MS);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect([...(reconcileMock.mock.calls[0][3] as Set<string>)].sort()).toEqual(["inbox:312", "inbox:313"]);
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as { _census: { at: string } };
    expect(Date.parse(cur._census.at)).toBeGreaterThan(Date.parse(before));
  });

  it("a pre-existing cursor WITHOUT _census censuses on its next run", async () => {
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(314, 5)] }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor: inboxCursor() })),
    );
    expect(fake.searches).toHaveLength(1);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as { _census?: { at: string } };
    expect(cur._census).toBeDefined();
  });

  it("garbage _census is tolerated (census due) and the reserved key is never a folder", async () => {
    // A folder-cursor-SHAPED _census must neither be opened as a mailbox nor survive as a folder entry.
    const cursor = JSON.stringify({
      inbox: { uidValidity: "10000", modseq: "55" },
      _census: { uidValidity: "1", modseq: "2" },
    });
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(315, 5)] }));
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor })));

    expect(fake.opens.map((o) => o.path)).toEqual([INBOX_PATH]); // never "_census"
    expect(fake.searches).toHaveLength(1); // garbage clock ⇒ census due
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, unknown>;
    expect(Object.keys(cur).sort()).toEqual(["_census", "inbox"]);
    expect((cur._census as { at?: string }).at).toBeTypeOf("string"); // re-stamped as a real clock
  });

  it("a folder census returning false → provably NO sweep and the clock does NOT advance", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX,
              highestModseq: 90n,
              messages: [msgAt(316, 5)],
            },
            {
              path: SENT_PATH,
              specialUse: "\\Sent",
              uidValidity: UIDVALIDITY_SENT,
              highestModseq: 91n,
              messages: [],
              searchFails: true, // Sent's census fails → partial census
            },
          ],
        },
      ],
    });
    const cursor = JSON.stringify({
      inbox: { uidValidity: "10000", modseq: "55" },
      sent: { uidValidity: "20000", modseq: "77" },
    }); // no _census → census due
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor })));

    expect(fake.searches).toHaveLength(2); // both censuses attempted
    expect(reconcileMock).not.toHaveBeenCalled(); // partial census must never sweep
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, unknown>;
    expect(Object.hasOwn(cur, "_census")).toBe(false); // the clock did not advance (was absent)
    // BLOCK fold #3: ONE masked warn for the failed folder — the enum only, zero error detail.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "gmail: census failed for folder 'sent' — sweep withheld this run",
    );
  });

  it("a THROWN census search is swallowed: the run completes, the sweep is withheld", async () => {
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(317, 5)], searchThrows: true }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor: inboxCursor() })),
    );
    expect(recs.map((r) => r.externalId)).toEqual(["inbox:317"]); // new-mail sync still landed
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(fake.logouts).toBe(1);
    // BLOCK fold #3: the swallowed failure is grep-able — ONE masked warn, and the thrown error's
    // embedded password provably never reaches it (folder enum only, zero error detail).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "gmail: census failed for folder 'inbox' — sweep withheld this run",
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(PASS);
  });

  it("the full-resync branch censuses+sweeps regardless of a fresh clock (UIDVALIDITY reset)", async () => {
    const cursor = JSON.stringify({
      inbox: { uidValidity: "9999", modseq: "5" }, // stale generation ⇒ reset
      _census: { at: new Date().toISOString() }, // clock is FRESH — must not suppress the census
    });
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(318, 3)] }));
    await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor })));
    expect(fake.searches).toHaveLength(1); // the backfill search IS the census
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("VANISHED still flows on a windowed incremental run", async () => {
    const fake = makeFakeImap(inboxOnly({ messages: [], vanished: [101] }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(
        ctx({ windowDays: 180, cursor: inboxCursor(60 * 60 * 1000) }),
      ),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].deleted).toBe(true);
    expect(recs[0].externalId).toBe("inbox:101");
    // The cursor (folder map + the round-tripped clock) rides the deletion record.
    const cur = JSON.parse(recs[0].cursor!) as Record<string, unknown>;
    expect(Object.keys(cur).sort()).toEqual(["_census", "inbox"]);
  });

  it("a zero-record census run sweeps but cannot stamp (cursor unchanged — re-census next run accepted)", async () => {
    // BLOCK-fold #5 accepted residual (recorded, not fixed): on an all-quiet mailbox the stamp
    // cannot persist (the cursor rides yielded records only), so the daily throttle degrades to
    // census-per-run until any record yields. Cost: one UID SEARCH + a no-op sweep per run — now
    // guarded by the folder-vanish rule (#1) and self-healing via resurrectPresent (#2). The
    // "~2×/day" blast-radius line reads as "~2×/day on ACTIVE mailboxes" accordingly.
    const fake = makeFakeImap(inboxOnly({ messages: [], searchUids: [401] }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor: inboxCursor() })),
    );
    expect(recs).toHaveLength(0); // no record to carry a cursor — existing no-record behavior
    expect(reconcileMock).toHaveBeenCalledTimes(1); // the sweep itself still landed
  });

  it("a folder present in the STORED cursor but absent from discovery provably withholds the sweep (folder-vanish guard)", async () => {
    // Gmail's per-label "Show in IMAP" toggle (or a LIST missing the SPECIAL-USE attribute) makes
    // a previously-synced folder vanish from discovery — a census SKIP laundered through discovery.
    const cursor = JSON.stringify({
      inbox: { uidValidity: "10000", modseq: "55" },
      sent: { uidValidity: "20000", modseq: "77" },
    }); // no _census → census due
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(320, 5)] })); // LIST has ONLY inbox
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor })));

    expect(recs.map((r) => r.externalId)).toEqual(["inbox:320"]); // the inbox sync still landed
    expect(reconcileMock).not.toHaveBeenCalled(); // the vanished 'sent' folder withholds the sweep
    expect(warnSpy).toHaveBeenCalledWith(
      "gmail: folder 'sent' vanished from discovery — sweep withheld this run",
    ); // the withheld sweep is observable (masked, folder enum only — security re-review LOW)
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, unknown>;
    expect(Object.hasOwn(cur, "_census")).toBe(false); // and the clock does NOT advance
    expect(Object.hasOwn(cur, "sent")).toBe(true); // the vanished folder's cursor entry rides along
  });

  it("a census SEARCH returning > 200,000 UIDs is refused: masked warn, NO sweep, NO stamp (sanity cap)", async () => {
    const oversized = Array.from({ length: 200_001 }, (_, i) => i + 1);
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(321, 5)], searchUids: oversized }));
    const recs = await collect(
      new GmailConnector(fake.factory).sync(ctx({ windowDays: 180, cursor: inboxCursor() })),
    );

    expect(recs.map((r) => r.externalId)).toEqual(["inbox:321"]); // the run still succeeds
    expect(reconcileMock).not.toHaveBeenCalled(); // the oversized census never drives a sweep
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "gmail: census oversized for folder 'inbox' — sweep withheld this run",
    );
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, unknown>;
    expect(Object.hasOwn(cur, "_census")).toBe(false); // no stamp
  });

  it("an oversized SEARCH on the full-resync branch still backfills but refuses the census (no sweep)", async () => {
    const oversized = Array.from({ length: 200_001 }, (_, i) => i + 1);
    const fake = makeFakeImap(inboxOnly({ messages: [msgAt(322, 5)], searchUids: oversized }));
    const recs = await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 }))); // no cursor ⇒ reset

    // The backfill fetched the searched set (201 sequential ≤1000-UID chunks) — data never dropped.
    expect(fake.fetches).toHaveLength(201);
    expect(recs.map((r) => r.externalId)).toEqual(["inbox:322"]);
    expect(reconcileMock).not.toHaveBeenCalled(); // but the census was refused → no sweep
    expect(warnSpy).toHaveBeenCalledWith(
      "gmail: census oversized for folder 'inbox' — sweep withheld this run",
    );
    const cur = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, unknown>;
    expect(Object.hasOwn(cur, "_census")).toBe(false); // no stamp
  });

  it("a sweep failure fails the run MASKED (secret-free) and never advances the clock", async () => {
    reconcileMock.mockRejectedValueOnce(new Error(`db exploded [pass=${PASS}]`));
    const fake = makeFakeImap(firstRun());
    try {
      await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toBe("gmail: sync failed");
      expect(msg).not.toContain(PASS);
    }
    expect(fake.logouts).toBe(1);
  });

  it("a search failure on the full-resync branch fails the run MASKED (secret-free)", async () => {
    const fake = makeFakeImap(inboxOnly({ messages: [], searchThrows: true })); // no cursor ⇒ reset branch
    try {
      await collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 })));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toBe("gmail: sync failed");
      expect(msg).not.toContain(PASS);
    }
    expect(fake.logouts).toBe(1);
  });

  it("a `false` search on the full-resync branch fails the run MASKED (cannot backfill without the set)", async () => {
    const fake = makeFakeImap(inboxOnly({ messages: [], searchFails: true }));
    await expect(
      collect(new GmailConnector(fake.factory).sync(ctx({ windowDays: 180 }))),
    ).rejects.toThrow(/^gmail: sync failed$/);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
