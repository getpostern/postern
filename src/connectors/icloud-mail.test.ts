// iCloud Mail connector unit tests — DB-free, imapflow mocked via the injectable client factory.
// Covers: declared shape (provider "apple", read-only, poll @ 10min floor 5min, incremental);
// normalize (the mail scalars; from/sender split; INTERNALDATE → received_at; \Seen → is_read;
// attachments from BODYSTRUCTURE; folder enum; thread_id/snippet/importance null); per-folder
// CONDSTORE/QRESYNC sync (windowed backfill SEARCH SINCE + 1-day pad → exact-set fetch; incremental
// changedSince advances the {uidValidity,modseq} cursor map; the cursor JSON round-trips); UIDVALIDITY
// change forces a FULL folder resync; QRESYNC VANISHED → RawRecord{deleted:true,externalId:
// "<folder>:<uid>"}; envelope-only footprint (no body in raw); \Sent discovered via SPECIAL-USE (not
// hardcoded) + INBOX+Sent only; strongKeys; read-only execute(); secret-free errors (connect + search
// leaks masked) + logger:false + one connection with logout(); the fetchRecordLive body drill; the
// UIDVALIDITY-reset stale-generation sweep (window-scoped reconcileObjectSnapshot — mocked here, the
// runner module is DB-backed — fires ONLY on a fully-enumerated run); the illegal-seq-(-1) guard; and
// the incremental out-of-window skip.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileObjectSnapshot } from "../sync/runner.js";
import type { RawRecord, SyncContext } from "./types.js";
import { IcloudMailConnector, type MailMessageRow } from "./icloud-mail.js";
import {
  INBOX_MSG_1,
  INBOX_MSG_2,
  SENT_MSG_1,
  MESSAGE_BODY_RESULT,
  INBOX_PATH,
  SENT_PATH,
  ARCHIVE_PATH,
  UIDVALIDITY_INBOX,
  UIDVALIDITY_SENT,
  makeFakeImap,
  msgAt,
  type FakeImapConfig,
} from "./icloud-mail.fixtures.js";

// DB-free: replace the runner module (icloud-mail.ts imports only reconcileObjectSnapshot from it).
vi.mock("../sync/runner.js", () => ({
  reconcileObjectSnapshot: vi.fn(async () => 0),
}));
const reconcileMock = vi.mocked(reconcileObjectSnapshot);

beforeEach(() => {
  reconcileMock.mockClear();
  reconcileMock.mockResolvedValue(0);
});

const PASS = "asp-SECRET-abcd-efgh-ijkl-mnop"; // an app-specific password (never expected in logs/errors)
const USER = "operator@icloud.com";
const DAY_MS = 24 * 60 * 60 * 1000;

async function collect(iter: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    connectionId: "33333333-3333-3333-3333-333333333333",
    secretRef: "sec_x",
    secret: PASS,
    username: USER,
    sector: "mail",
    ...over,
  };
}

/** A first-run (no cursor) two-folder fake: INBOX (2 msgs) + Sent (1 msg), plus an Archive decoy. */
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
          { path: ARCHIVE_PATH, specialUse: "\\Archive", uidValidity: 99_000n, highestModseq: 5n, messages: [] },
        ],
      },
    ],
    ...over,
  };
}

// ── Declared shape ────────────────────────────────────────────────────────────────────
describe("IcloudMailConnector — declared shape", () => {
  const c = new IcloudMailConnector();
  it("is the apple mail connector, read-only, poll @ 10min (floor 5min), incremental", () => {
    expect(c.provider).toBe("apple");
    expect(c.sector).toBe("mail");
    expect(c.objectType).toBe("message");
    expect(c.actions).toEqual([]);
    expect(c.policy).toMatchObject({
      mode: "poll",
      defaultIntervalSec: 600,
      minIntervalSec: 300,
      supportsIncremental: true,
    });
  });

  it("execute() throws (read-only)", async () => {
    await expect(c.execute()).rejects.toThrow(/no actions/i);
  });
});

// ── normalize ───────────────────────────────────────────────────────────────────────
describe("IcloudMailConnector — normalize", () => {
  const c = new IcloudMailConnector();

  function rawFor(msg: typeof INBOX_MSG_1, folderEnum: string): RawRecord {
    return {
      object: "message",
      externalId: `${folderEnum}:${msg.uid}`,
      raw: {
        uid: msg.uid,
        envelope: msg.envelope ?? {},
        flags: msg.flags ? Array.from(msg.flags) : [],
        internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
        bodyStructure: msg.bodyStructure,
        __pci_folder: folderEnum,
      },
    };
  }

  it("maps an unread inbox message with an attachment; thread_id/snippet/importance null", () => {
    const row: MailMessageRow = c.normalize(rawFor(INBOX_MSG_1, "inbox"));
    expect(row.source_object_id).toBe("inbox:501");
    expect(row.from_address).toBe("alice@icloud.example.com");
    expect(row.from_name).toBe("Alice Sender");
    expect(row.sender_address).toBeNull(); // sender === from ⇒ null
    expect(row.subject).toBe("Family trip itinerary");
    expect(row.message_id_header).toBe("<icloud-inbox-0001@mail.me.com>");
    expect(row.is_read).toBe(false);
    expect(row.has_attachments).toBe(true);
    expect(row.folder).toBe("inbox");
    expect(row.received_at).toBe("2026-06-12T09:30:00.000Z");
    expect(row.thread_id).toBeNull();
    expect(row.snippet).toBeNull();
    expect(row.importance).toBeNull();
  });

  it("keeps a delegate sender (≠ from) and maps \\Seen → is_read, folder=sent", () => {
    const inbox2 = c.normalize(rawFor(INBOX_MSG_2, "inbox"));
    expect(inbox2.sender_address).toBe("assistant@partner.example.org");
    expect(inbox2.is_read).toBe(true);
    expect(inbox2.has_attachments).toBe(false);

    const sent = c.normalize(rawFor(SENT_MSG_1, "sent"));
    expect(sent.folder).toBe("sent");
    expect(sent.source_object_id).toBe("sent:601");
  });

  it("a stray folder enum resolves to null (whitelist), never a SQL surprise", () => {
    const row = c.normalize(rawFor(INBOX_MSG_1, "junk"));
    expect(row.folder).toBeNull();
  });

  it("strongKeys yields the RFC 5322 Message-ID", () => {
    const keys = c.strongKeys(rawFor(INBOX_MSG_1, "inbox"));
    expect(keys).toEqual({ message_id: "<icloud-inbox-0001@mail.me.com>" });
  });
});

// ── sync: windowed first-run backfill ───────────────────────────────────────────────
describe("IcloudMailConnector — sync (windowed first-run backfill)", () => {
  it("issues UID SEARCH SINCE (window − 1d pad), fetches the exact set, lands envelope rows only", async () => {
    const fake = makeFakeImap(firstRun());
    const c = new IcloudMailConnector(fake.factory);
    const recs = await collect(c.sync(ctx({ windowDays: 180 })));

    // Two folders synced (INBOX + Sent); Archive decoy skipped (not \Inbox/\Sent).
    const live = recs.filter((r) => !r.deleted);
    expect(live.map((r) => r.externalId).sort()).toEqual(["inbox:501", "inbox:502", "sent:601"]);

    // Envelope-only footprint: raw carries NO body/source.
    for (const r of live) {
      const raw = r.raw as Record<string, unknown>;
      expect(raw).not.toHaveProperty("source");
      expect(raw).not.toHaveProperty("body");
      expect(raw).toHaveProperty("__pci_folder");
    }

    // A UID SEARCH SINCE was issued per synced folder, with the 1-day pad.
    const inboxSearch = fake.searches.find((s) => s.path === INBOX_PATH);
    expect(inboxSearch).toBeDefined();
    const since = (inboxSearch!.query as { since?: Date }).since;
    expect(since).toBeInstanceOf(Date);
    const expectedPadMs = Date.now() - 180 * DAY_MS - DAY_MS;
    expect(Math.abs((since as Date).getTime() - expectedPadMs)).toBeLessThan(60_000);

    // Fetch ranges are the exact compacted UID set, NEVER "1:*".
    const inboxFetch = fake.fetches.find((f) => f.path === INBOX_PATH);
    expect(inboxFetch?.range).not.toBe("1:*");

    // Cursor map persisted on the last record.
    const last = recs[recs.length - 1];
    const map = JSON.parse(last.cursor!) as Record<string, { uidValidity: string; modseq: string }>;
    expect(map.inbox).toEqual({ uidValidity: UIDVALIDITY_INBOX.toString(), modseq: "55" });
    expect(map.sent).toEqual({ uidValidity: UIDVALIDITY_SENT.toString(), modseq: "77" });
    expect(map).not.toHaveProperty("_census"); // iCloud has no census clock

    // Exactly one connection, logged out; logger:false + host/port + qresync on the client options.
    expect(fake.connects).toBe(1);
    expect(fake.logouts).toBe(1);
    expect(fake.clientOptions[0]).toMatchObject({
      host: "imap.mail.me.com",
      port: 993,
      secure: true,
      logger: false,
      qresync: true,
    });

    // A fully-enumerated first run (both folders windowed-full-resync) fires the reset sweep.
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("unwindowed (windowDays null) → 1:* fetch, NO search, NO sweep (back-compat)", async () => {
    const fake = makeFakeImap(firstRun());
    const c = new IcloudMailConnector(fake.factory);
    await collect(c.sync(ctx({ windowDays: null })));
    expect(fake.searches.length).toBe(0);
    expect(fake.fetches.every((f) => f.range === "1:*")).toBe(true);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});

// ── sync: incremental + QRESYNC VANISHED deletion ───────────────────────────────────
describe("IcloudMailConnector — incremental + QRESYNC VANISHED", () => {
  const CURSOR = JSON.stringify({
    inbox: { uidValidity: UIDVALIDITY_INBOX.toString(), modseq: "55" },
    sent: { uidValidity: UIDVALIDITY_SENT.toString(), modseq: "77" },
  });

  it("opens with QRESYNC params, issues CHANGEDSINCE, and tombstones a VANISHED uid", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX,
              highestModseq: 60n,
              messages: [],
              vanished: [501],
            },
            { path: SENT_PATH, specialUse: "\\Sent", uidValidity: UIDVALIDITY_SENT, highestModseq: 77n, messages: [] },
          ],
        },
      ],
    });
    const c = new IcloudMailConnector(fake.factory);
    const recs = await collect(c.sync(ctx({ windowDays: 180, cursor: CURSOR })));

    // The inbox open carried QRESYNC params (changedSince + uidValidity).
    const inboxOpen = fake.opens.find((o) => o.path === INBOX_PATH);
    expect(inboxOpen?.qresync).toBe(true);

    // A CHANGEDSINCE fetch was issued (incremental branch), NOT a windowed SEARCH.
    const inboxFetch = fake.fetches.find((f) => f.path === INBOX_PATH);
    expect(inboxFetch?.changedSince).toBe(55n); // stored modseq
    expect(fake.searches.length).toBe(0); // no full-resync search on a stable UIDVALIDITY

    // VANISHED 501 → a deletion record with the matching "<folder>:<uid>" id.
    const del = recs.find((r) => r.deleted);
    expect(del).toMatchObject({ object: "message", deleted: true, externalId: "inbox:501", raw: null });

    // An incremental (partial-enumeration) run NEVER sweeps.
    expect(reconcileMock).not.toHaveBeenCalled();

    // Cursor advanced (inbox modseq 55 → 60).
    const map = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, { modseq: string }>;
    expect(map.inbox.modseq).toBe("60");
  });

  it("skips an out-of-window incremental message (flag flip on ancient mail)", async () => {
    const ancient = msgAt(701, 400); // 400 days old, well outside a 180-day window
    const fresh = msgAt(702, 5);
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX,
              highestModseq: 90n,
              messages: [ancient, fresh],
            },
          ],
        },
      ],
    });
    const c = new IcloudMailConnector(fake.factory);
    const cursor = JSON.stringify({ inbox: { uidValidity: UIDVALIDITY_INBOX.toString(), modseq: "55" } });
    const recs = await collect(c.sync(ctx({ windowDays: 180, cursor })));
    const ids = recs.filter((r) => !r.deleted).map((r) => r.externalId);
    expect(ids).toContain("inbox:702");
    expect(ids).not.toContain("inbox:701"); // ancient skipped
  });
});

// ── sync: UIDVALIDITY reset ─────────────────────────────────────────────────────────
describe("IcloudMailConnector — UIDVALIDITY reset", () => {
  it("a changed UIDVALIDITY forces a windowed FULL resync (SEARCH, exact-set fetch)", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: 88_888n, // changed from the stored 30000
              highestModseq: 120n,
              messages: [INBOX_MSG_1],
            },
          ],
        },
      ],
    });
    const c = new IcloudMailConnector(fake.factory);
    const cursor = JSON.stringify({ inbox: { uidValidity: UIDVALIDITY_INBOX.toString(), modseq: "55" } });
    const recs = await collect(c.sync(ctx({ windowDays: 180, cursor })));

    // A SEARCH was issued (full-resync branch) and the fetch was the exact set, not 1:*.
    expect(fake.searches.some((s) => s.path === INBOX_PATH)).toBe(true);
    expect(fake.fetches.find((f) => f.path === INBOX_PATH)?.range).not.toBe("1:*");

    // The single discovered folder was fully enumerated → the stale-generation sweep fires.
    expect(reconcileMock).toHaveBeenCalledTimes(1);

    const map = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, { uidValidity: string }>;
    expect(map.inbox.uidValidity).toBe("88888");
  });

  it("a MIXED run (one folder reset, the other incremental) does NOT sweep", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: 88_888n, // reset → windowed full resync
              highestModseq: 120n,
              messages: [INBOX_MSG_1],
            },
            {
              path: SENT_PATH,
              specialUse: "\\Sent",
              uidValidity: UIDVALIDITY_SENT, // unchanged → incremental
              highestModseq: 77n,
              messages: [],
            },
          ],
        },
      ],
    });
    const c = new IcloudMailConnector(fake.factory);
    const cursor = JSON.stringify({
      inbox: { uidValidity: UIDVALIDITY_INBOX.toString(), modseq: "55" },
      sent: { uidValidity: UIDVALIDITY_SENT.toString(), modseq: "77" },
    });
    await collect(c.sync(ctx({ windowDays: 180, cursor })));
    // Sent took the incremental branch ⇒ not a complete enumeration ⇒ no sweep.
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});

// ── Defensive: illegal seq/uid ──────────────────────────────────────────────────────
describe("IcloudMailConnector — defensive parsing", () => {
  it("skips a malformed FETCH carrying an illegal uid (-1)", async () => {
    const bogus = { ...msgAt(-1, 5), uid: -1 } as typeof INBOX_MSG_1;
    const good = msgAt(801, 5);
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX,
              highestModseq: 55n,
              messages: [bogus, good],
              searchUids: [801], // the search only knows the good uid
            },
          ],
        },
      ],
    });
    const c = new IcloudMailConnector(fake.factory);
    const recs = await collect(c.sync(ctx({ windowDays: 180 })));
    const ids = recs.filter((r) => !r.deleted).map((r) => r.externalId);
    expect(ids).toContain("inbox:801");
    expect(ids).not.toContain("inbox:-1");
  });
});

// ── fetchRecordLive ─────────────────────────────────────────────────────────────────
describe("IcloudMailConnector — fetchRecordLive", () => {
  it("returns the RFC822 body for a live uid (stores nothing — pure return)", async () => {
    const fake = makeFakeImap({
      rounds: [{ folders: [{ path: INBOX_PATH, specialUse: "\\Inbox", uidValidity: UIDVALIDITY_INBOX, highestModseq: 55n }] }],
      bodyByUid: { 501: MESSAGE_BODY_RESULT },
    });
    const c = new IcloudMailConnector(fake.factory);
    const body = (await c.fetchRecordLive(ctx(), "inbox:501")) as { source: string; uid: number };
    expect(body.uid).toBe(501);
    expect(body.source).toContain("Subject: Family trip itinerary");
    expect(fake.logouts).toBe(1);
  });

  it("a UID miss returns null (truthful gone)", async () => {
    const fake = makeFakeImap({
      rounds: [{ folders: [{ path: INBOX_PATH, specialUse: "\\Inbox", uidValidity: UIDVALIDITY_INBOX, highestModseq: 55n }] }],
      bodyByUid: { 501: false },
    });
    const c = new IcloudMailConnector(fake.factory);
    expect(await c.fetchRecordLive(ctx(), "inbox:501")).toBeNull();
  });

  it("rejects a malformed id and an unknown folder", async () => {
    const c = new IcloudMailConnector(makeFakeImap({ rounds: [{ folders: [] }] }).factory);
    await expect(c.fetchRecordLive(ctx(), "inbox:notanum")).rejects.toThrow(/malformed record id/);
    await expect(c.fetchRecordLive(ctx(), "junk:1")).rejects.toThrow(/unknown folder/);
  });
});

// ── Secret hygiene (S1) ─────────────────────────────────────────────────────────────
describe("IcloudMailConnector — secret hygiene", () => {
  it("a connect failure that embeds the ASP is masked (secret-free error)", async () => {
    const fake = makeFakeImap({ ...firstRun(), failConnect: true });
    const c = new IcloudMailConnector(fake.factory);
    await expect(collect(c.sync(ctx({ windowDays: 180 })))).rejects.toThrow(/icloud-mail: sync failed/);
    // The thrown message must not contain the ASP.
    try {
      await collect(c.sync(ctx({ windowDays: 180 })));
    } catch (err) {
      expect((err as Error).message).not.toContain(PASS);
    }
  });

  it("a search failure that embeds the ASP is masked", async () => {
    const fake = makeFakeImap({
      rounds: [
        {
          folders: [
            {
              path: INBOX_PATH,
              specialUse: "\\Inbox",
              uidValidity: UIDVALIDITY_INBOX,
              highestModseq: 55n,
              messages: [INBOX_MSG_1],
              searchThrows: true,
            },
          ],
        },
      ],
    });
    const c = new IcloudMailConnector(fake.factory);
    try {
      await collect(c.sync(ctx({ windowDays: 180 })));
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(PASS);
      expect((err as Error).message).toMatch(/icloud-mail:/);
    }
  });

  it("throws secret-free when username/secret are missing", async () => {
    const c = new IcloudMailConnector(makeFakeImap({ rounds: [{ folders: [] }] }).factory);
    await expect(collect(c.sync(ctx({ secret: null })))).rejects.toThrow(/icloud-mail: missing/);
  });
});
