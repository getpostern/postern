// Microsoft connector unit tests — DB-free, network mocked. Covers: declared shape (read-only,
// poll @ 5min, incremental), normalize (the 15 envelope scalars; from/sender split; folder→enum),
// per-folder delta paging (≥2 pages → persist the deltaLink; cursor round-trips as a JSON
// folder→deltaLink map; a second run resumes from the stored deltaLink WITHOUT re-sending $select),
// @removed → RawRecord{deleted:true}, envelope-only footprint (no `body` in raw), the ImmutableId
// Prefer header, strongKeys, 429 retry + secret-free throttle error, and the fetchRecordLive body drill.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RawRecord, SyncContext } from "./types.js";
import {
  MicrosoftConnector,
  type MailMessageRow,
  type CalendarEventRow,
  type ContactRow,
} from "./microsoft.js";
import { RetryableError } from "../sync/errors.js";
import { reconcileObjectSnapshot } from "../sync/runner.js";
import {
  MSG_INBOX_1,
  MSG_INBOX_2,
  MSG_INBOX_3,
  MSG_SENT_1,
  REMOVED_INBOX_1,
  MSG_INBOX_1_READ_FLIP_PARTIAL,
  MSG_INBOX_1_READ,
  MSG_UNSEEN_READ_FLIP_PARTIAL,
  MSG_UNSEEN_FULL,
  MESSAGE_BODY_RESOURCE,
  INBOX_DELTA_PAGE_1,
  INBOX_DELTA_PAGE_2,
  SENT_DELTA_PAGE,
  deltaPageWithNext,
  deltaPageWithDelta,
  CAL_OCCURRENCE_1,
  CAL_EXCEPTION_1,
  CAL_ALLDAY_1,
  CAL_REMOVED_OUT_OF_WINDOW,
  SYNC_STATE_NOT_FOUND_BODY,
  calPageWithNext,
  calPageWithDelta,
  CONTACTS_FOLDER_ID,
  CONTACT_1,
  CONTACT_2,
  CONTACT_REMOVED_1,
  CONTACTS_PROBE_PAGE,
  CONTACTS_PROBE_EMPTY,
  contactPageWithNext,
  contactPageWithDelta,
} from "./microsoft.fixtures.js";

// DB-free: replace the runner module (microsoft.ts imports only reconcileObjectSnapshot from it).
// The mock doubles as the spy proving WHEN the connector sweeps and with WHAT (#26a one-run rule).
vi.mock("../sync/runner.js", () => ({
  reconcileObjectSnapshot: vi.fn(async () => 0),
}));
const reconcileMock = vi.mocked(reconcileObjectSnapshot);

const TOKEN = "SECRET-GRAPH-TOKEN-abc123";
const GRAPH = "https://graph.microsoft.com/v1.0"; // the v1.0 base (host-pin + cursor-URL fixtures)
const DAY_MS = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;
beforeEach(() => {
  reconcileMock.mockClear();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

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
    secret: TOKEN,
    sector: "mail",
    ...over,
  };
}

type Handler = (url: string, init?: RequestInit) => Record<string, unknown> | Response;

/** Install a fetch mock; returns the captured calls (url + init) for assertions. */
function installFetch(handler: Handler): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return calls;
}

/** The two-folder first-sync router: inbox = 2 pages, sentitems = 1 page. */
function firstSyncRouter(url: string): Record<string, unknown> {
  if (url.includes("/mailFolders/inbox/messages/delta")) {
    return url.includes("$skiptoken=INBOX_SKIP_1") ? INBOX_DELTA_PAGE_2 : INBOX_DELTA_PAGE_1;
  }
  if (url.includes("/mailFolders/sentitems/messages/delta")) return SENT_DELTA_PAGE;
  throw new Error(`unexpected url: ${url}`);
}

describe("MicrosoftConnector — declared shape", () => {
  const c = new MicrosoftConnector();
  it("is mail, read-only, poll @ 5min, incremental", () => {
    expect(c.provider).toBe("microsoft");
    expect(c.sector).toBe("mail");
    expect(c.objectType).toBe("message");
    expect(c.actions).toEqual([]);
    expect(c.policy).toEqual({
      mode: "poll",
      defaultIntervalSec: 300,
      minIntervalSec: 300, // ADR 0025 — the cadence floor (= the default; Graph mailbox throttle)
      freshnessToleranceSec: 300,
      supportsIncremental: true,
      // OPT-IN incremental checkpointing (ADR 0016): Microsoft's per-page delta cursor is
      // committed-through, so the runner may persist it mid-stream.
      cursorCommittedThrough: true,
    });
  });
  it("execute() throws (mail is read-only this wave)", async () => {
    await expect(c.execute()).rejects.toThrow(/read-only/);
  });
});

describe("MicrosoftConnector.sync — per-folder delta paging", () => {
  it("follows @odata.nextLink across 2 pages, yields envelope + tombstone records, persists the deltaLink map", async () => {
    const calls = installFetch(firstSyncRouter);
    const recs = await collect(new MicrosoftConnector().sync(ctx()));

    // 4 envelope messages + 1 tombstone, in stream order (inbox pages, then sent).
    expect(recs.map((r) => r.externalId)).toEqual([
      MSG_INBOX_1.id,
      MSG_INBOX_2.id,
      MSG_INBOX_3.id,
      REMOVED_INBOX_1.id,
      MSG_SENT_1.id,
    ]);
    const removed = recs.filter((r) => r.deleted === true);
    expect(removed).toHaveLength(1);
    expect(removed[0].externalId).toBe(MSG_INBOX_1.id);

    // 3 fetches: inbox page 1, inbox page 2 (nextLink), sentitems page 1.
    expect(calls).toHaveLength(3);

    // $select on the INITIAL inbox + sent requests only — never on the $skiptoken follow-up.
    const initialInbox = calls.find(
      (c) => c.url.includes("/mailFolders/inbox/messages/delta") && !c.url.includes("$skiptoken"),
    )!;
    expect(initialInbox.url).toContain("$select=");
    const followUp = calls.find((c) => c.url.includes("$skiptoken=INBOX_SKIP_1"))!;
    expect(followUp.url).not.toContain("$select");

    // The cursor rides the LAST record of the whole run and round-trips as a JSON folder→link map.
    const last = recs[recs.length - 1];
    expect(last.cursor).toBeTypeOf("string");
    const map = JSON.parse(last.cursor!) as Record<string, string>;
    expect(Object.keys(map).sort()).toEqual(["inbox", "sentitems"]);
    expect(map.inbox).toContain("$deltatoken=INBOX_DELTA_R1");
    expect(map.sentitems).toContain("$deltatoken=SENT_DELTA_R1");

    // Incremental checkpointing: a cursor rides the LAST record of EACH page (not only the very
    // last record of the run). inbox page 1's last record (MSG_INBOX_2) carries the in-progress
    // skiptoken; inbox page 2's last record (the tombstone) carries inbox's deltaLink.
    const inbox2 = recs.find((r) => r.externalId === MSG_INBOX_2.id)!;
    expect(inbox2.cursor).toBeTypeOf("string");
    expect((JSON.parse(inbox2.cursor!) as Record<string, string>).inbox).toContain(
      "$skiptoken=INBOX_SKIP_1",
    );
    const tombstone = recs.find((r) => r.deleted === true)!;
    expect(tombstone.cursor).toBeTypeOf("string");
    expect((JSON.parse(tombstone.cursor!) as Record<string, string>).inbox).toContain(
      "$deltatoken=INBOX_DELTA_R1",
    );
    // A NON-last record of a page carries no cursor (MSG_INBOX_1 is first of inbox page 1).
    expect(recs.find((r) => r.externalId === MSG_INBOX_1.id)!.cursor).toBeUndefined();
    expect(recs.find((r) => r.externalId === MSG_INBOX_3.id)!.cursor).toBeUndefined();
  });

  it("a second run resumes from the stored deltaLink and does NOT re-send $select", async () => {
    // Round 1 to obtain the cursor map.
    installFetch(firstSyncRouter);
    const recs1 = await collect(new MicrosoftConnector().sync(ctx()));
    const cursor = recs1[recs1.length - 1].cursor!;
    const storedMap = JSON.parse(cursor) as Record<string, string>;

    // Round 2: each folder must be fetched at its stored deltaLink, $select never re-sent.
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=INBOX_DELTA_R1")) {
        return deltaPageWithDelta("inbox", [], "INBOX_DELTA_R2");
      }
      if (url.includes("$deltatoken=SENT_DELTA_R1")) {
        return deltaPageWithDelta("sentitems", [], "SENT_DELTA_R2");
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const recs2 = await collect(new MicrosoftConnector().sync(ctx({ cursor })));

    // Both folders hit exactly their stored deltaLink; no $select on any call.
    const urls = calls.map((c) => c.url);
    expect(urls).toContain(storedMap.inbox);
    expect(urls).toContain(storedMap.sentitems);
    expect(urls.every((u) => !u.includes("$select"))).toBe(true);
    // No messages this round; the empty delta yields nothing (no record to carry the cursor).
    expect(recs2).toHaveLength(0);
  });

  it("sends the ImmutableId + maxpagesize Prefer header and a bearer token on every call", async () => {
    const calls = installFetch(firstSyncRouter);
    await collect(new MicrosoftConnector().sync(ctx()));
    for (const c of calls) {
      const headers = c.init?.headers as Record<string, string>;
      expect(headers.Prefer).toContain('IdType="ImmutableId"');
      expect(headers.Prefer).toContain("odata.maxpagesize=50");
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("yields ONLY the envelope — no body/attachment content in raw", async () => {
    installFetch(firstSyncRouter);
    const recs = await collect(new MicrosoftConnector().sync(ctx()));
    for (const r of recs.filter((r) => r.deleted !== true)) {
      const raw = r.raw as Record<string, unknown>;
      expect(Object.hasOwn(raw, "body")).toBe(false);
      expect(Object.hasOwn(raw, "attachments")).toBe(false);
      // The folder is threaded for normalize() (synthetic key; does not pollute the queryable cols).
      expect(Object.hasOwn(raw, "__pci_folder")).toBe(true);
    }
  });

  it("throws (no secret) when ctx.secret is missing", async () => {
    await expect(collect(new MicrosoftConnector().sync(ctx({ secret: null })))).rejects.toThrow(
      /missing access token/,
    );
  });
});

describe("MicrosoftConnector.normalize", () => {
  const c = new MicrosoftConnector();

  async function syncedRecords(): Promise<RawRecord[]> {
    installFetch(firstSyncRouter);
    return collect(c.sync(ctx()));
  }

  it("maps an inbox message → the 15 envelope scalars (from/sender split, dates ISO, folder=inbox)", async () => {
    const recs = await syncedRecords();
    const rec = recs.find((r) => r.externalId === MSG_INBOX_1.id)!;
    const row = c.normalize(rec) as MailMessageRow;
    expect(row).toEqual({
      source_object_id: MSG_INBOX_1.id,
      thread_id: "AAQkAGI2Conv0001",
      message_id_header: "<CY4PR01MB-inbox-0001@contoso.example.com>",
      from_address: "alice@contoso.example.com",
      from_name: "Alice Sender",
      sender_address: "alice@contoso.example.com",
      subject: "Q3 planning agenda",
      snippet: "Here is the proposed agenda for the Q3 planning session next week.",
      sent_at: "2026-06-12T09:29:55Z",
      received_at: "2026-06-12T09:30:00Z",
      is_read: false,
      has_attachments: true,
      folder: "inbox",
      importance: "high",
    });
  });

  it("keeps a delegate sender distinct from `from`", async () => {
    const recs = await syncedRecords();
    const row = c.normalize(recs.find((r) => r.externalId === MSG_INBOX_2.id)!) as MailMessageRow;
    expect(row.from_address).toBe("carol@partner.example.org");
    expect(row.sender_address).toBe("assistant@partner.example.org");
    expect(row.is_read).toBe(true);
    expect(row.has_attachments).toBe(false);
  });

  it("maps a Sent Items message → folder=sent", async () => {
    const recs = await syncedRecords();
    const row = c.normalize(recs.find((r) => r.externalId === MSG_SENT_1.id)!) as MailMessageRow;
    expect(row.folder).toBe("sent");
    expect(row.from_address).toBe("operator@contoso.example.com");
  });

  it("never emits a non-REGISTRY key (no id, no raw, no labels, no body)", async () => {
    const recs = await syncedRecords();
    const row = c.normalize(recs.find((r) => r.externalId === MSG_INBOX_1.id)!) as MailMessageRow;
    const keys = Object.keys(row);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("raw");
    expect(keys).not.toContain("labels");
    expect(keys).not.toContain("body");
    expect(keys).toHaveLength(14); // the 15 REGISTRY mail scalars minus `id` (the runner injects id)
  });
});

describe("MicrosoftConnector.strongKeys", () => {
  const c = new MicrosoftConnector();
  it("uses internetMessageId → { message_id_header } when present", () => {
    const rec: RawRecord = { object: "message", externalId: MSG_INBOX_1.id, raw: MSG_INBOX_1 };
    expect(c.strongKeys(rec)).toEqual({
      message_id_header: "<CY4PR01MB-inbox-0001@contoso.example.com>",
    });
  });
  it("falls back to { graph_id } when internetMessageId is absent", () => {
    const raw = { id: "GRAPH-ID-ONLY-7" };
    const rec: RawRecord = { object: "message", externalId: "GRAPH-ID-ONLY-7", raw };
    expect(c.strongKeys(rec)).toEqual({ graph_id: "GRAPH-ID-ONLY-7" });
  });
});

describe("MicrosoftConnector — 429 throttling", () => {
  it("honors Retry-After and retries, then succeeds", async () => {
    let n = 0;
    const calls = installFetch((url) => {
      // First call to inbox is throttled once, then the real router answers.
      if (url.includes("/mailFolders/inbox/messages/delta") && n++ === 0) {
        return new Response("", { status: 429, headers: { "Retry-After": "0" } });
      }
      return firstSyncRouter(url);
    });
    const recs = await collect(new MicrosoftConnector().sync(ctx()));
    expect(recs.length).toBeGreaterThan(0);
    // The throttled inbox call was retried (an extra fetch beyond the 3 successful pages).
    expect(calls.length).toBeGreaterThan(3);
  });

  it("a persistent 429 throws a secret-free error (no token in the message)", async () => {
    installFetch(() => new Response("", { status: 429, headers: { "Retry-After": "0" } }));
    try {
      await collect(new MicrosoftConnector().sync(ctx()));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/throttled/);
      expect(msg).not.toContain(TOKEN);
    }
  });
});

describe("MicrosoftConnector — transient 5xx retry (A) + retryable classification (D)", () => {
  it("retries a 503 then a 504, then succeeds (bounded exponential backoff)", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const calls = installFetch((url) => {
        // The initial inbox delta fails transiently twice (503, then 504), then the router answers.
        if (url.includes("/mailFolders/inbox/messages/delta") && !url.includes("$skiptoken")) {
          if (n === 0) {
            n++;
            return new Response("", { status: 503 });
          }
          if (n === 1) {
            n++;
            return new Response("", { status: 504 });
          }
        }
        return firstSyncRouter(url);
      });
      const p = collect(new MicrosoftConnector().sync(ctx()));
      await vi.runAllTimersAsync(); // flush the backoff sleeps
      const recs = await p;
      expect(recs.length).toBeGreaterThan(0);
      // the two transient responses were retried (extra fetches beyond the 3 successful pages)
      expect(calls.length).toBeGreaterThan(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a RetryableError after MAX_5XX_RETRIES consecutive 504s (status-only, secret-free)", async () => {
    vi.useFakeTimers();
    try {
      const calls = installFetch(() => new Response("", { status: 504 }));
      const p = collect(new MicrosoftConnector().sync(ctx())).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = (await p) as Error;
      expect(err).toBeInstanceOf(RetryableError);
      expect(err.message).toMatch(/504/);
      expect(err.message).not.toContain(TOKEN);
      // initial attempt + MAX_5XX_RETRIES (4) retries = 5 fetches of the inbox initial delta
      expect(calls.filter((c) => c.url.includes("/mailFolders/inbox/messages/delta")).length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retry a 400 and surfaces a TERMINAL (plain, non-Retryable) error", async () => {
    let count = 0;
    installFetch((url) => {
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        count++;
        return new Response("bad request", { status: 400 });
      }
      return firstSyncRouter(url);
    });
    const err = (await collect(new MicrosoftConnector().sync(ctx())).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryableError); // 4xx is terminal
    expect(err.message).toMatch(/400/);
    expect(err.message).not.toContain(TOKEN);
    expect(count).toBe(1); // immediate — no retry on a terminal 4xx
  });

  it("classifies a persistent 429 (after retries) as a RetryableError", async () => {
    vi.useFakeTimers();
    try {
      installFetch(() => new Response("", { status: 429, headers: { "Retry-After": "0" } }));
      const p = collect(new MicrosoftConnector().sync(ctx())).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = (await p) as Error;
      expect(err).toBeInstanceOf(RetryableError);
      expect(err.message).toMatch(/throttled/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a network failure as a RetryableError (secret-free)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    const err = (await collect(new MicrosoftConnector().sync(ctx())).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("MicrosoftConnector.sync — per-page cursor checkpointing (C)", () => {
  /** A 3-page inbox folder (page1 → page2 → final) + a single-page sent folder. */
  function threePageRouter(url: string): Record<string, unknown> {
    if (url.includes("/mailFolders/inbox/messages/delta")) {
      if (url.includes("$skiptoken=SKIP_B")) return deltaPageWithDelta("inbox", [MSG_INBOX_3], "DELTA_FINAL");
      if (url.includes("$skiptoken=SKIP_A")) return deltaPageWithNext("inbox", [MSG_INBOX_2], "SKIP_B");
      return deltaPageWithNext("inbox", [MSG_INBOX_1], "SKIP_A");
    }
    if (url.includes("/mailFolders/sentitems/messages/delta")) return SENT_DELTA_PAGE;
    throw new Error(`unexpected url: ${url}`);
  }

  it("emits a non-null cursor on each page's last record (in-progress nextLink, deltaLink on completion)", async () => {
    installFetch(threePageRouter);
    const recs = await collect(new MicrosoftConnector().sync(ctx()));

    // Each inbox record is the sole (hence last) record of its page → each carries a cursor whose
    // inbox entry is the link to RESUME from after that page is committed.
    const r1 = recs.find((r) => r.externalId === MSG_INBOX_1.id)!;
    const r2 = recs.find((r) => r.externalId === MSG_INBOX_2.id)!;
    const r3 = recs.find((r) => r.externalId === MSG_INBOX_3.id)!;
    expect((JSON.parse(r1.cursor!) as Record<string, string>).inbox).toContain("$skiptoken=SKIP_A");
    expect((JSON.parse(r2.cursor!) as Record<string, string>).inbox).toContain("$skiptoken=SKIP_B");
    expect((JSON.parse(r3.cursor!) as Record<string, string>).inbox).toContain("$deltatoken=DELTA_FINAL");
    // The final run-cursor carries inbox's deltaLink + sent's deltaLink.
    const map = JSON.parse(recs[recs.length - 1].cursor!) as Record<string, string>;
    expect(map.inbox).toContain("$deltatoken=DELTA_FINAL");
    expect(map.sentitems).toContain("$deltatoken=SENT_DELTA_R1");
  });

  it("resumes from a stored in-progress nextLink ($skiptoken) WITHOUT re-issuing $select", async () => {
    const storedMap = {
      inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=SKIP_B`,
      sentitems: `${GRAPH}/me/mailFolders/sentitems/messages/delta?$deltatoken=SENT_OK`,
    };
    const calls = installFetch((url) => {
      if (url.includes("$skiptoken=SKIP_B")) return deltaPageWithDelta("inbox", [MSG_INBOX_3], "DELTA_FINAL");
      if (url.includes("$deltatoken=SENT_OK")) return deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_R2");
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(ctx({ cursor: JSON.stringify(storedMap) })));

    // Resumed mid-folder: only the REMAINING inbox page (INBOX_3) + sent — INBOX_1/INBOX_2 are NOT
    // re-fetched (they were committed before the checkpoint).
    expect(recs.map((r) => r.externalId)).toEqual([MSG_INBOX_3.id, MSG_SENT_1.id]);
    // The stored nextLink was hit directly and $select was never re-issued on any call.
    expect(calls.some((c) => c.url.includes("$skiptoken=SKIP_B"))).toBe(true);
    expect(calls.every((c) => !c.url.includes("$select"))).toBe(true);
  });
});

describe("MicrosoftConnector.sync — 410 resync (expired delta token)", () => {
  it("a 410 on a stored deltaLink (a deltaLink follow-up) drops it and restarts a FRESH delta with $select", async () => {
    // Resume cursor: inbox's stored deltaLink is expired (410); sentitems resumes normally.
    const storedMap = {
      inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=INBOX_EXPIRED`,
      sentitems: `${GRAPH}/me/mailFolders/sentitems/messages/delta?$deltatoken=SENT_OK`,
    };
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=INBOX_EXPIRED")) return new Response("gone", { status: 410 });
      // The fresh inbox delta (carries $select) recovers with a brand-new deltaLink.
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        return deltaPageWithDelta("inbox", [MSG_INBOX_1], "INBOX_FRESH");
      }
      if (url.includes("$deltatoken=SENT_OK")) {
        return deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_R2");
      }
      throw new Error(`unexpected url: ${url}`);
    });

    // Recovers without throwing — the runner only flips status='error' on a throw, so the connection
    // stays healthy.
    const recs = await collect(new MicrosoftConnector().sync(ctx({ cursor: JSON.stringify(storedMap) })));
    expect(recs.map((r) => r.externalId)).toEqual([MSG_INBOX_1.id, MSG_SENT_1.id]);

    // The expired deltaLink was hit (and 410'd), THEN a fresh inbox delta WITH $select was issued.
    expect(calls.some((c) => c.url.includes("$deltatoken=INBOX_EXPIRED"))).toBe(true);
    const freshInbox = calls.find(
      (c) =>
        c.url.includes("/mailFolders/inbox/messages/delta") &&
        c.url.includes("$select=") &&
        !c.url.includes("$deltatoken="),
    );
    expect(freshInbox).toBeDefined();

    // The new cursor map carries the FRESH inbox deltaLink (expired one dropped) + sent's new one.
    const last = recs[recs.length - 1];
    const map = JSON.parse(last.cursor!) as Record<string, string>;
    expect(map.inbox).toContain("$deltatoken=INBOX_FRESH");
    expect(map.inbox).not.toContain("INBOX_EXPIRED");
    expect(map.sentitems).toContain("$deltatoken=SENT_R2");
  });

  it("a 410 on an @odata.nextLink follow-up restarts a fresh delta and recovers", async () => {
    // Cold start (no cursor): inbox page 1 → nextLink; the nextLink 410s; fresh delta recovers.
    let inboxFreshHits = 0;
    const calls = installFetch((url) => {
      if (url.includes("$skiptoken=EXPIRED_SKIP")) return new Response("gone", { status: 410 });
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        // The very first inbox request (initial $select) hands back a nextLink that will 410;
        // after the resync the fresh request lands a final page directly.
        if (url.includes("$select=") && inboxFreshHits++ === 0) {
          return {
            "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=EXPIRED_SKIP`,
            value: [MSG_INBOX_2],
          };
        }
        return deltaPageWithDelta("inbox", [MSG_INBOX_1], "INBOX_FRESH");
      }
      if (url.includes("/mailFolders/sentitems/messages/delta")) {
        return deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_R1");
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const recs = await collect(new MicrosoftConnector().sync(ctx()));
    // No throw; the fresh delta's records + sent are present (the pre-410 page may re-appear — the
    // generic upsert is idempotent, so a resync re-emitting is harmless).
    const ids = recs.map((r) => r.externalId);
    expect(ids).toContain(MSG_INBOX_1.id);
    expect(ids).toContain(MSG_SENT_1.id);
    // The expired skiptoken was hit and 410'd, then a fresh inbox delta was issued.
    expect(calls.some((c) => c.url.includes("$skiptoken=EXPIRED_SKIP"))).toBe(true);
    const last = recs[recs.length - 1];
    const map = JSON.parse(last.cursor!) as Record<string, string>;
    expect(map.inbox).toContain("$deltatoken=INBOX_FRESH");
  });

  it("a 410 that persists THROUGH the fresh restart propagates (not swallowed forever)", async () => {
    // Every inbox delta 410s — the single resync can't recover, so the error surfaces (the runner
    // then marks status='error', as designed for a genuinely unrecoverable source).
    installFetch((url) => {
      if (url.includes("/mailFolders/inbox/messages/delta")) return new Response("gone", { status: 410 });
      if (url.includes("/mailFolders/sentitems/messages/delta")) return SENT_DELTA_PAGE;
      throw new Error(`unexpected url: ${url}`);
    });
    try {
      await collect(new MicrosoftConnector().sync(ctx()));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/410/);
      expect(msg).not.toContain(TOKEN);
    }
  });
});

describe("MicrosoftConnector — bearer host-pin", () => {
  it("never sends the bearer to an @odata.nextLink on a non-graph host (throws, secret-free)", async () => {
    const evil = "https://evil.example.com/me/mailFolders/inbox/messages/delta?$skiptoken=STOLEN";
    const calls = installFetch((url) => {
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        // A server-controlled nextLink pointing off-host — must NOT receive the credential.
        return { "@odata.nextLink": evil, value: [MSG_INBOX_1] };
      }
      if (url.includes("/mailFolders/sentitems/messages/delta")) return SENT_DELTA_PAGE;
      throw new Error(`unexpected url: ${url}`);
    });

    try {
      await collect(new MicrosoftConnector().sync(ctx()));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/non-graph host/);
      expect(msg).not.toContain(TOKEN);
    }

    // The off-host link was NEVER fetched — the host-pin throws before the bearer is attached.
    expect(calls.some((c) => c.url === evil)).toBe(false);
    expect(calls.some((c) => c.url.includes("evil.example.com"))).toBe(false);
    // Every call that DID go out carried the bearer only to the graph host.
    for (const c of calls) {
      expect(new URL(c.url).host).toBe("graph.microsoft.com");
      const headers = c.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("never sends the bearer to a stored deltaLink that points off-host", async () => {
    const evilDelta = "https://attacker.example.net/me/mailFolders/inbox/messages/delta?$deltatoken=X";
    const storedMap = {
      inbox: evilDelta,
      sentitems: `${GRAPH}/me/mailFolders/sentitems/messages/delta?$deltatoken=SENT_OK`,
    };
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=SENT_OK")) return SENT_DELTA_PAGE;
      throw new Error(`unexpected url: ${url}`);
    });
    await expect(
      collect(new MicrosoftConnector().sync(ctx({ cursor: JSON.stringify(storedMap) }))),
    ).rejects.toThrow(/non-graph host/);
    expect(calls.some((c) => c.url.includes("attacker.example.net"))).toBe(false);
  });

  it("refuses an http:// (plaintext) link even on the graph host — scheme is part of the pin", async () => {
    const downgraded = "http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=X";
    const storedMap = {
      inbox: downgraded,
      sentitems: `${GRAPH}/me/mailFolders/sentitems/messages/delta?$deltatoken=SENT_OK`,
    };
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=SENT_OK")) return SENT_DELTA_PAGE;
      throw new Error(`unexpected url: ${url}`);
    });
    await expect(
      collect(new MicrosoftConnector().sync(ctx({ cursor: JSON.stringify(storedMap) }))),
    ).rejects.toThrow(/non-graph host/);
    // The plaintext link was never fetched — no bearer over http.
    expect(calls.some((c) => c.url.startsWith("http://"))).toBe(false);
  });
});

describe("MicrosoftConnector.fetchRecordLive — body on demand", () => {
  const c = new MicrosoftConnector();

  it("issues a by-id GET with the body $select and returns body.content", async () => {
    const calls = installFetch(() => MESSAGE_BODY_RESOURCE);
    const out = (await c.fetchRecordLive(ctx(), MSG_INBOX_1.id)) as {
      body: { content: string };
    };
    expect(out.body.content).toContain("agenda");

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toContain(`/me/messages/${encodeURIComponent(MSG_INBOX_1.id)}`);
    expect(url).toContain("$select=");
    expect(url).toContain("body");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Prefer).toContain('IdType="ImmutableId"');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns null when Graph 404s the id (source says gone)", async () => {
    installFetch(() => new Response("not found", { status: 404 }));
    expect(await c.fetchRecordLive(ctx(), "AAMk-missing")).toBeNull();
  });

  it("throws (no secret) when ctx.secret is missing", async () => {
    await expect(c.fetchRecordLive(ctx({ secret: null }), MSG_INBOX_1.id)).rejects.toThrow(
      /missing access token/,
    );
  });
});

describe("MicrosoftConnector.sync — windowed filtered delta (wave 12a)", () => {
  it("the INITIAL delta per folder carries $filter=receivedDateTime ge <window-start> + $orderby desc when windowDays is set", async () => {
    const calls = installFetch(firstSyncRouter);
    await collect(new MicrosoftConnector().sync(ctx({ windowDays: 180 })));

    // Both fresh (initial) folder requests — neither a $skiptoken nor a stored $deltatoken — carry the
    // filter + orderby, derived from windowDays.
    const initials = calls.filter(
      (c) =>
        c.url.includes("/messages/delta") &&
        !c.url.includes("$skiptoken") &&
        !c.url.includes("$deltatoken"),
    );
    expect(initials.length).toBe(2); // inbox + sentitems initial requests
    for (const c of initials) {
      const decoded = decodeURIComponent(c.url);
      expect(decoded).toContain("$filter=receivedDateTime ge ");
      expect(decoded).toContain("$orderby=receivedDateTime desc");
      // the window start is ~180 days ago (within a minute of now − 180d).
      const m = decoded.match(/receivedDateTime ge ([0-9T:.Z-]+)/);
      expect(m).toBeTruthy();
      const start = new Date(m![1]).getTime();
      const expected = Date.now() - 180 * 24 * 60 * 60 * 1000;
      expect(Math.abs(start - expected)).toBeLessThan(60_000);
    }

    // The server-provided $skiptoken follow-up must NOT re-append the filter (Graph bakes it in).
    const follow = calls.find((c) => c.url.includes("$skiptoken=INBOX_SKIP_1"))!;
    expect(decodeURIComponent(follow.url)).not.toContain("$filter");
  });

  it("windowDays null/undefined ⇒ NO filter (all-history back-compat)", async () => {
    const calls = installFetch(firstSyncRouter);
    await collect(new MicrosoftConnector().sync(ctx())); // no windowDays
    for (const c of calls) {
      expect(decodeURIComponent(c.url)).not.toContain("$filter");
      expect(c.url).not.toContain("$orderby");
    }
  });

  it("an explicit windowDays=null also yields NO filter", async () => {
    const calls = installFetch(firstSyncRouter);
    await collect(new MicrosoftConnector().sync(ctx({ windowDays: null })));
    for (const c of calls) expect(decodeURIComponent(c.url)).not.toContain("$filter");
  });

  it("a stored deltaLink round-trips WITHOUT re-appending the window filter or re-enumerating", async () => {
    const storedMap = {
      inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=INBOX_DELTA_R1`,
      sentitems: `${GRAPH}/me/mailFolders/sentitems/messages/delta?$deltatoken=SENT_DELTA_R1`,
    };
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=INBOX_DELTA_R1")) return deltaPageWithDelta("inbox", [], "INBOX_DELTA_R2");
      if (url.includes("$deltatoken=SENT_DELTA_R1")) return deltaPageWithDelta("sentitems", [], "SENT_DELTA_R2");
      throw new Error(`unexpected url: ${url}`);
    });
    await collect(
      new MicrosoftConnector().sync(ctx({ windowDays: 180, cursor: JSON.stringify(storedMap) })),
    );

    // Exactly the two stored deltaLinks were followed — no fresh enumeration ($select absent), and the
    // filter is NOT re-appended (the deltaLink already carries the window forward).
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toContain("$deltatoken=");
      expect(c.url).not.toContain("$select");
      expect(decodeURIComponent(c.url)).not.toContain("$filter");
    }
  });

  it("a 410 resync of a windowed folder restarts a FRESH delta that re-carries the filter", async () => {
    const storedMap = {
      inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=INBOX_EXPIRED`,
      sentitems: `${GRAPH}/me/mailFolders/sentitems/messages/delta?$deltatoken=SENT_OK`,
    };
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=INBOX_EXPIRED")) return new Response("gone", { status: 410 });
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        return deltaPageWithDelta("inbox", [MSG_INBOX_1], "INBOX_FRESH");
      }
      if (url.includes("$deltatoken=SENT_OK")) return deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_R2");
      throw new Error(`unexpected url: ${url}`);
    });
    await collect(
      new MicrosoftConnector().sync(ctx({ windowDays: 90, cursor: JSON.stringify(storedMap) })),
    );

    // The fresh inbox restart (post-410) carries BOTH $select and the window filter.
    const freshInbox = calls.find(
      (c) => c.url.includes("/mailFolders/inbox/messages/delta") && c.url.includes("$select="),
    )!;
    expect(freshInbox).toBeDefined();
    expect(decodeURIComponent(freshInbox.url)).toContain("$filter=receivedDateTime ge ");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #26a — calendar sector (calendarView delta chains)
// ═══════════════════════════════════════════════════════════════════════════════════

/** ctx for a calendar-sector connection (the runner passes windowDays: null for non-mail sectors). */
function calCtx(over: Partial<SyncContext> = {}): SyncContext {
  return ctx({ sector: "calendar", windowDays: null, ...over });
}

/** Parse an initial calendarView URL's window bounds (searchParams decodes the encoding). */
function windowBoundsOf(url: string): { ws: number; we: number } {
  const u = new URL(url);
  return {
    ws: Date.parse(u.searchParams.get("startDateTime") ?? ""),
    we: Date.parse(u.searchParams.get("endDateTime") ?? ""),
  };
}

/** True for a FRESH (initial) calendarView delta request — window params, no stored token. */
function isCalInitial(url: string): boolean {
  return (
    url.includes("/me/calendarView/delta") &&
    url.includes("startDateTime=") &&
    !url.includes("$skiptoken") &&
    !url.includes("$deltatoken")
  );
}

describe("MicrosoftConnector.syncCalendar — fresh chain (#26a)", () => {
  function freshRouter(url: string): Record<string, unknown> {
    if (url.includes("$skiptoken=CAL_SKIP_1")) {
      return calPageWithDelta([CAL_ALLDAY_1, CAL_REMOVED_OUT_OF_WINDOW], "CAL_DELTA_R1");
    }
    if (isCalInitial(url)) return calPageWithNext([CAL_OCCURRENCE_1, CAL_EXCEPTION_1], "CAL_SKIP_1");
    throw new Error(`unexpected url: ${url}`);
  }

  it("initial request is calendarView/delta with UTC [now−365d, now+365d] bounds; pages via nextLink", async () => {
    const calls = installFetch(freshRouter);
    const recs = await collect(new MicrosoftConnector().sync(calCtx()));

    expect(recs.map((r) => r.externalId)).toEqual([
      CAL_OCCURRENCE_1.id,
      CAL_EXCEPTION_1.id,
      CAL_ALLDAY_1.id,
      CAL_REMOVED_OUT_OF_WINDOW.id,
    ]);
    // Every live record is tagged for the calendar table; the @removed entry is a tombstone.
    for (const r of recs) expect(r.object).toBe("calendar_event");
    expect(recs.filter((r) => r.deleted === true).map((r) => r.externalId)).toEqual([
      CAL_REMOVED_OUT_OF_WINDOW.id,
    ]);

    expect(calls).toHaveLength(2);
    const { ws, we } = windowBoundsOf(calls[0].url);
    expect(Math.abs(ws - (Date.now() - 365 * DAY_MS))).toBeLessThan(60_000);
    expect(Math.abs(we - (Date.now() + 365 * DAY_MS))).toBeLessThan(60_000);
    // calendarView delta supports no $select — full payloads.
    expect(calls[0].url).not.toContain("$select");
    // The follow-up rides the server-provided nextLink verbatim (no re-appended window params).
    expect(calls[1].url).toContain("$skiptoken=CAL_SKIP_1");
    expect(calls[1].url).not.toContain("startDateTime");
  });

  it("the {ws,we,link} cursor rides the LAST record of each page (committed-through)", async () => {
    installFetch(freshRouter);
    const recs = await collect(new MicrosoftConnector().sync(calCtx()));

    // Page 1's last record carries the in-progress skiptoken; page 2's last carries the deltaLink.
    const p1last = recs.find((r) => r.externalId === CAL_EXCEPTION_1.id)!;
    const c1 = JSON.parse(p1last.cursor!) as { ws: string; we: string; link: string };
    expect(c1.link).toContain("$skiptoken=CAL_SKIP_1");
    expect(Number.isFinite(Date.parse(c1.ws))).toBe(true);
    expect(Number.isFinite(Date.parse(c1.we))).toBe(true);

    const last = recs[recs.length - 1];
    const c2 = JSON.parse(last.cursor!) as { ws: string; we: string; link: string };
    expect(c2.link).toContain("$deltatoken=CAL_DELTA_R1");
    expect(c2.ws).toBe(c1.ws); // the window is frozen across the chain
    expect(c2.we).toBe(c1.we);

    // A non-last record of a page carries no cursor.
    expect(recs.find((r) => r.externalId === CAL_OCCURRENCE_1.id)!.cursor).toBeUndefined();
  });

  it("a COMPLETE one-run fresh chain sweeps via reconcileObjectSnapshot, window-scoped to starts_at ∈ [ws, we]", async () => {
    installFetch(freshRouter);
    const recs = await collect(new MicrosoftConnector().sync(calCtx()));
    const { ws, we } = JSON.parse(recs[recs.length - 1].cursor!) as { ws: string; we: string };

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const [connId, sector, object, soids, startedAt, window] = reconcileMock.mock.calls[0];
    expect(connId).toBe(calCtx().connectionId);
    expect(sector).toBe("calendar");
    expect(object).toBe("calendar_event");
    // soids = the LIVE enumeration only — never the @removed id.
    expect([...(soids as Set<string>)].sort()).toEqual(
      [CAL_OCCURRENCE_1.id, CAL_EXCEPTION_1.id, CAL_ALLDAY_1.id].sort(),
    );
    expect(startedAt).toBeInstanceOf(Date);
    expect(window).toEqual({ column: "starts_at", from: new Date(ws), to: new Date(we) });
  });

  it("ignores ctx.windowDays by construction (the ADR-0017 mail window never leaks in)", async () => {
    const calls = installFetch(freshRouter);
    await collect(new MicrosoftConnector().sync(calCtx({ windowDays: 90 })));
    const { ws } = windowBoundsOf(calls[0].url);
    expect(Math.abs(ws - (Date.now() - 365 * DAY_MS))).toBeLessThan(60_000); // NOT now−90d
    expect(decodeURIComponent(calls[0].url)).not.toContain("$filter");
  });

  it("throws (no secret) when ctx.secret is missing", async () => {
    await expect(collect(new MicrosoftConnector().sync(calCtx({ secret: null })))).rejects.toThrow(
      /missing access token/,
    );
  });
});

describe("MicrosoftConnector.syncCalendar — resume, re-anchor, resync (#26a)", () => {
  const farWindow = () => ({
    ws: new Date(Date.now() - 300 * DAY_MS).toISOString(),
    we: new Date(Date.now() + 300 * DAY_MS).toISOString(), // headroom 300d ≥ 180d → resume
  });
  const nearWindow = () => ({
    ws: new Date(Date.now() - 500 * DAY_MS).toISOString(),
    we: new Date(Date.now() + 100 * DAY_MS).toISOString(), // headroom 100d < 180d → re-anchor
  });

  it("resumes an incremental chain from the stored deltaLink and NEVER sweeps (resumed ≠ fresh)", async () => {
    const { ws, we } = farWindow();
    const cursor = JSON.stringify({ ws, we, link: `${GRAPH}/me/calendarView/delta?$deltatoken=CAL_DELTA_R1` });
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=CAL_DELTA_R1")) return calPageWithDelta([CAL_EXCEPTION_1], "CAL_DELTA_R2");
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(calCtx({ cursor })));

    expect(calls).toHaveLength(1); // exactly the stored link — no fresh enumeration
    expect(recs.map((r) => r.externalId)).toEqual([CAL_EXCEPTION_1.id]);
    // The new cursor keeps the SAME frozen window with the fresh deltaLink.
    const c = JSON.parse(recs[0].cursor!) as { ws: string; we: string; link: string };
    expect(c.ws).toBe(ws);
    expect(c.we).toBe(we);
    expect(c.link).toContain("$deltatoken=CAL_DELTA_R2");
    // Completed with a deltaLink, but the chain was NOT started this run → no sweep.
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("a run resumed from a persisted MID-CHAIN nextLink provably does NOT call reconcileObjectSnapshot", async () => {
    const { ws, we } = farWindow();
    const cursor = JSON.stringify({ ws, we, link: `${GRAPH}/me/calendarView/delta?$skiptoken=CAL_MID` });
    installFetch((url) => {
      if (url.includes("$skiptoken=CAL_MID")) return calPageWithDelta([CAL_ALLDAY_1], "CAL_DONE");
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(calCtx({ cursor })));
    expect(recs.map((r) => r.externalId)).toEqual([CAL_ALLDAY_1.id]);
    // It even completed (deltaLink) — but a partial soid set must never feed the sweep.
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("RE-ANCHORS when we − now < 180d: abandons the stored link, fresh chain on a new ±365d window, sweeps", async () => {
    const { ws, we } = nearWindow();
    const cursor = JSON.stringify({ ws, we, link: `${GRAPH}/me/calendarView/delta?$deltatoken=CAL_OLD` });
    const calls = installFetch((url) => {
      if (isCalInitial(url)) return calPageWithDelta([CAL_OCCURRENCE_1], "CAL_FRESH");
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(calCtx({ cursor })));

    // The stale deltaLink was NEVER fetched; the initial request carries a re-anchored window.
    expect(calls.some((c) => c.url.includes("CAL_OLD"))).toBe(false);
    const bounds = windowBoundsOf(calls[0].url);
    expect(Math.abs(bounds.we - (Date.now() + 365 * DAY_MS))).toBeLessThan(60_000);

    const c = JSON.parse(recs[0].cursor!) as { ws: string; we: string };
    expect(c.we).not.toBe(we); // the cursor now carries the NEW window
    expect(reconcileMock).toHaveBeenCalledTimes(1); // fresh chain completed this run → sweep
  });

  it("a garbled cursor starts a fresh chain", async () => {
    const calls = installFetch((url) => {
      if (isCalInitial(url)) return calPageWithDelta([CAL_OCCURRENCE_1], "CAL_FRESH");
      throw new Error(`unexpected url: ${url}`);
    });
    await collect(new MicrosoftConnector().sync(calCtx({ cursor: "not-json{{" })));
    expect(isCalInitial(calls[0].url)).toBe(true);
  });

  it("410-with-Location mid-chain restarts ONE fresh chain (a new initial call — the Location URL itself is never fetched)", async () => {
    let initials = 0;
    const restartUrl = `${GRAPH}/me/calendarView/delta?$deltatoken=RESTART_HINT`;
    const calls = installFetch((url) => {
      if (url.includes("$skiptoken=CAL_SKIP_X")) {
        return new Response("gone", { status: 410, headers: { Location: restartUrl } });
      }
      if (isCalInitial(url)) {
        initials++;
        if (initials === 1) return calPageWithNext([CAL_OCCURRENCE_1], "CAL_SKIP_X");
        return calPageWithDelta([CAL_ALLDAY_1], "CAL_FRESH2");
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(calCtx()));

    expect(initials).toBe(2); // dead chain's initial + the restart's initial
    expect(calls.some((c) => c.url.includes("RESTART_HINT"))).toBe(false); // Location = semantics, not a fetch target
    const ids = recs.map((r) => r.externalId);
    expect(ids).toContain(CAL_OCCURRENCE_1.id); // dead chain's records (idempotent upsert absorbs replays)
    expect(ids).toContain(CAL_ALLDAY_1.id);

    // The RESTARTED chain sweeps with ONLY its own soids (the dead chain's partial set was discarded).
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const soids = reconcileMock.mock.calls[0][3] as Set<string>;
    expect([...soids]).toEqual([CAL_ALLDAY_1.id]);
  });

  it("a 40x syncStateNotFound restarts a fresh chain (same as 410)", async () => {
    const { ws, we } = farWindow();
    const cursor = JSON.stringify({ ws, we, link: `${GRAPH}/me/calendarView/delta?$deltatoken=CAL_EXPIRED` });
    installFetch((url) => {
      if (url.includes("$deltatoken=CAL_EXPIRED")) {
        return new Response(JSON.stringify(SYNC_STATE_NOT_FOUND_BODY), { status: 400 });
      }
      if (isCalInitial(url)) return calPageWithDelta([CAL_OCCURRENCE_1], "CAL_FRESH3");
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(calCtx({ cursor })));
    expect(recs.map((r) => r.externalId)).toEqual([CAL_OCCURRENCE_1.id]);
    expect(reconcileMock).toHaveBeenCalledTimes(1); // the restart is a complete one-run fresh chain
  });

  it("a 410 that persists THROUGH the fresh restart propagates (not swallowed forever), secret-free", async () => {
    installFetch(() => new Response("gone", { status: 410 }));
    try {
      await collect(new MicrosoftConnector().sync(calCtx()));
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/410/);
      expect(msg).not.toContain(TOKEN);
    }
    expect(reconcileMock).not.toHaveBeenCalled(); // a failed chain NEVER sweeps
  });

  it("a plain 400 (not syncStateNotFound) stays TERMINAL — no restart loop", async () => {
    let count = 0;
    installFetch((url) => {
      if (isCalInitial(url)) {
        count++;
        return new Response(JSON.stringify({ error: { code: "invalidRequest" } }), { status: 400 });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    await expect(collect(new MicrosoftConnector().sync(calCtx()))).rejects.toThrow(/400/);
    expect(count).toBe(1);
  });
});

describe("MicrosoftConnector.normalize — calendar (#26a)", () => {
  const c = new MicrosoftConnector();
  const rec = (raw: unknown): RawRecord => ({
    object: "calendar_event",
    externalId: String((raw as { id: string }).id),
    raw,
  });

  it("maps an OCCURRENCE per the spec table (UTC instants, master linkage, accepted response)", () => {
    const row = c.normalize(rec(CAL_OCCURRENCE_1)) as CalendarEventRow;
    expect(row).toEqual({
      source_object_id: CAL_OCCURRENCE_1.id,
      summary: "Weekly sync",
      description: "Agenda: status round + blockers.",
      location: "Teams",
      starts_at: "2026-07-15T16:00:00.000Z", // bare 7-fraction Graph UTC → clean ISO instant
      ends_at: "2026-07-15T16:30:00.000Z",
      start_tz: "Pacific Standard Time", // originalStartTimeZone as-given (Windows zone name)
      all_day: false,
      status: "confirmed",
      organizer_email: "alice@contoso.example.com",
      owner_response: "accepted",
      is_recurring: true,
      recurrence_master_id: "AAMkAGI2-Cal-Master-0001",
      original_start: null,
      original_start_tz: "Pacific Standard Time",
      html_link: "https://outlook.live.com/calendar/item/AAMkAGI2-Cal-Occurrence-0001",
      updated_at: "2026-07-01T09:00:01.1234567Z",
    });
  });

  it("maps an EXCEPTION: originalStart survives, tentativelyAccepted → tentative", () => {
    const row = c.normalize(rec(CAL_EXCEPTION_1)) as CalendarEventRow;
    expect(row.original_start).toBe("2026-07-22T16:00:00Z");
    expect(row.owner_response).toBe("tentative");
    expect(row.is_recurring).toBe(true);
    expect(row.recurrence_master_id).toBe("AAMkAGI2-Cal-Master-0001");
    expect(row.starts_at).toBe("2026-07-22T17:00:00.000Z");
  });

  it("maps an ALL-DAY event: all_day=true, midnight bounds, EXCLUSIVE end as Graph gives it, organizer → accepted", () => {
    const row = c.normalize(rec(CAL_ALLDAY_1)) as CalendarEventRow;
    expect(row.all_day).toBe(true);
    expect(row.starts_at).toBe("2026-07-20T00:00:00.000Z");
    expect(row.ends_at).toBe("2026-07-21T00:00:00.000Z"); // exclusive — NOT collapsed to the same day
    expect(row.owner_response).toBe("accepted"); // organizer → accepted
    expect(row.is_recurring).toBe(false);
    expect(row.recurrence_master_id).toBeNull();
  });

  it("owner_response map: declined→declined; none/notResponded/absent→needsAction", () => {
    const variant = (response?: string) =>
      (c.normalize(
        rec({ ...CAL_OCCURRENCE_1, responseStatus: response == null ? undefined : { response } }),
      ) as CalendarEventRow).owner_response;
    expect(variant("declined")).toBe("declined");
    expect(variant("none")).toBe("needsAction");
    expect(variant("notResponded")).toBe("needsAction");
    expect(variant(undefined)).toBe("needsAction");
  });

  it("isCancelled → status 'cancelled' (Graph has no event-level tentative)", () => {
    const row = c.normalize(rec({ ...CAL_OCCURRENCE_1, isCancelled: true })) as CalendarEventRow;
    expect(row.status).toBe("cancelled");
  });

  it("never emits a non-REGISTRY key (no id, no raw, no attendees)", () => {
    const row = c.normalize(rec(CAL_OCCURRENCE_1)) as CalendarEventRow;
    const keys = Object.keys(row);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("raw");
    expect(keys).not.toContain("attendees");
    expect(keys).toHaveLength(17); // the 18 REGISTRY calendar fields minus `id`
  });
});

describe("MicrosoftConnector.strongKeys — calendar + contacts (#26a)", () => {
  const c = new MicrosoftConnector();
  it("calendar_event → { graph_event_id, ical_uid }", () => {
    const rec: RawRecord = { object: "calendar_event", externalId: CAL_OCCURRENCE_1.id, raw: CAL_OCCURRENCE_1 };
    expect(c.strongKeys(rec)).toEqual({
      graph_event_id: CAL_OCCURRENCE_1.id,
      ical_uid: CAL_OCCURRENCE_1.iCalUId,
    });
  });
  it("calendar_event without iCalUId → { graph_event_id } only", () => {
    const raw = { ...CAL_OCCURRENCE_1, iCalUId: undefined };
    expect(c.strongKeys({ object: "calendar_event", externalId: raw.id, raw })).toEqual({
      graph_event_id: CAL_OCCURRENCE_1.id,
    });
  });
  it("contact → { graph_contact_id, email }", () => {
    const rec: RawRecord = { object: "contact", externalId: CONTACT_1.id, raw: CONTACT_1 };
    expect(c.strongKeys(rec)).toEqual({
      graph_contact_id: CONTACT_1.id,
      email: "carol@partner.example.org",
    });
  });
  it("contact without an email → { graph_contact_id } only", () => {
    const raw = { ...CONTACT_1, emailAddresses: [] };
    expect(c.strongKeys({ object: "contact", externalId: raw.id, raw })).toEqual({
      graph_contact_id: CONTACT_1.id,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #26a — contacts sector (folder-scoped delta)
// ═══════════════════════════════════════════════════════════════════════════════════

function ctCtx(over: Partial<SyncContext> = {}): SyncContext {
  return ctx({ sector: "contacts", windowDays: null, ...over });
}

const isProbe = (url: string) => url.includes("/me/contacts?");
const isContactsInitial = (url: string) =>
  url.includes(`/me/contactFolders/${CONTACTS_FOLDER_ID}/contacts/delta`) && url.includes("$select=");

describe("MicrosoftConnector.syncContacts (#26a)", () => {
  function freshRouter(url: string): Record<string, unknown> {
    if (isProbe(url)) return CONTACTS_PROBE_PAGE;
    if (url.includes("$skiptoken=CT_SKIP_1")) {
      return contactPageWithDelta([CONTACT_2, CONTACT_REMOVED_1], "CT_DELTA_R1");
    }
    if (isContactsInitial(url)) return contactPageWithNext([CONTACT_1], "CT_SKIP_1");
    throw new Error(`unexpected url: ${url}`);
  }

  it("probes the default folder from parentFolderId, then walks the folder-scoped delta ($select on the initial request ONLY)", async () => {
    const calls = installFetch(freshRouter);
    const recs = await collect(new MicrosoftConnector().sync(ctCtx()));

    // Probe first — exactly the documented shape.
    expect(calls[0].url).toBe(`${GRAPH}/me/contacts?$top=1&$select=parentFolderId`);
    // Initial delta: folder-scoped + $select; the skiptoken follow-up never re-sends $select.
    expect(calls[1].url).toContain(`/me/contactFolders/${CONTACTS_FOLDER_ID}/contacts/delta`);
    expect(calls[1].url).toContain("$select=id,displayName,givenName,surname,emailAddresses");
    expect(calls[2].url).toContain("$skiptoken=CT_SKIP_1");
    expect(calls[2].url).not.toContain("$select");

    expect(recs.map((r) => r.externalId)).toEqual([CONTACT_1.id, CONTACT_2.id, CONTACT_REMOVED_1.id]);
    for (const r of recs) expect(r.object).toBe("contact");
    expect(recs[2].deleted).toBe(true); // @removed → tombstone

    // The {folderId, link} cursor rides the last record of each page.
    const c1 = JSON.parse(recs[0].cursor!) as { folderId: string; link: string };
    expect(c1.folderId).toBe(CONTACTS_FOLDER_ID);
    expect(c1.link).toContain("$skiptoken=CT_SKIP_1");
    const c2 = JSON.parse(recs[2].cursor!) as { folderId: string; link: string };
    expect(c2.link).toContain("$deltatoken=CT_DELTA_R1");
  });

  it("a COMPLETE one-run fresh chain sweeps the whole folder (NO window arg)", async () => {
    installFetch(freshRouter);
    await collect(new MicrosoftConnector().sync(ctCtx()));
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const [connId, sector, object, soids, startedAt, window] = reconcileMock.mock.calls[0];
    expect(connId).toBe(ctCtx().connectionId);
    expect(sector).toBe("contacts");
    expect(object).toBe("contact");
    expect([...(soids as Set<string>)].sort()).toEqual([CONTACT_1.id, CONTACT_2.id].sort());
    expect(startedAt).toBeInstanceOf(Date);
    expect(window).toBeUndefined(); // full-folder enumeration — no window scope
  });

  it("EMPTY mailbox: the probe finds no contact → zero records, NO cursor, no delta call (clean retry next poll)", async () => {
    const calls = installFetch((url) => {
      if (isProbe(url)) return CONTACTS_PROBE_EMPTY;
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(ctCtx()));
    expect(recs).toHaveLength(0);
    expect(calls).toHaveLength(1); // the probe only — no delta ever issued
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("resumes from the stored deltaLink: NO probe, NO $select, and NO sweep", async () => {
    const cursor = JSON.stringify({
      folderId: CONTACTS_FOLDER_ID,
      link: `${GRAPH}/me/contactFolders/${CONTACTS_FOLDER_ID}/contacts/delta?$deltatoken=CT_DELTA_R1`,
    });
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=CT_DELTA_R1")) return contactPageWithDelta([CONTACT_1], "CT_DELTA_R2");
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(ctCtx({ cursor })));

    expect(calls).toHaveLength(1); // exactly the stored link — no probe, no fresh enumeration
    expect(calls[0].url).not.toContain("$select");
    expect(recs.map((r) => r.externalId)).toEqual([CONTACT_1.id]);
    expect(reconcileMock).not.toHaveBeenCalled(); // delta increment ≠ a complete enumeration
  });

  it("410 on the stored link → fresh chain REUSING the stored folderId (no re-probe), $select re-sent, sweep runs", async () => {
    const cursor = JSON.stringify({
      folderId: CONTACTS_FOLDER_ID,
      link: `${GRAPH}/me/contactFolders/${CONTACTS_FOLDER_ID}/contacts/delta?$deltatoken=CT_EXPIRED`,
    });
    const calls = installFetch((url) => {
      if (url.includes("$deltatoken=CT_EXPIRED")) return new Response("gone", { status: 410 });
      if (isContactsInitial(url)) return contactPageWithDelta([CONTACT_1], "CT_FRESH");
      if (isProbe(url)) throw new Error("must not re-probe — folder ids do not expire");
      throw new Error(`unexpected url: ${url}`);
    });
    const recs = await collect(new MicrosoftConnector().sync(ctCtx({ cursor })));

    expect(calls.some((c) => isProbe(c.url))).toBe(false);
    expect(recs.map((r) => r.externalId)).toEqual([CONTACT_1.id]);
    expect(reconcileMock).toHaveBeenCalledTimes(1); // the restart is a complete one-run fresh chain
    expect([...(reconcileMock.mock.calls[0][3] as Set<string>)]).toEqual([CONTACT_1.id]);
  });

  it("throws (no secret) when ctx.secret is missing", async () => {
    await expect(collect(new MicrosoftConnector().sync(ctCtx({ secret: null })))).rejects.toThrow(
      /missing access token/,
    );
  });
});

describe("MicrosoftConnector.normalize — contacts (#26a)", () => {
  const c = new MicrosoftConnector();
  const rec = (raw: unknown): RawRecord => ({
    object: "contact",
    externalId: String((raw as { id: string }).id),
    raw,
  });

  it("maps a full contact per the spec table; mobile phone keeps its leading + (best-effort E.164)", () => {
    const row = c.normalize(rec(CONTACT_1)) as ContactRow;
    expect(row).toEqual({
      source_object_id: CONTACT_1.id,
      display_name: "Carol Friend",
      given_name: "Carol",
      family_name: "Friend",
      primary_email: "carol@partner.example.org",
      primary_phone: "+14255550100", // "+1 (425) 555-0100" cleaned — formatting stripped, + kept
      company: "Partner Org",
      job_title: "Head of Partnerships",
      updated_at: "2026-07-01T10:00:00Z",
    });
  });

  it("no mobile → businessPhones[0]; NO country inference (no + is ever invented)", () => {
    const row = c.normalize(rec(CONTACT_2)) as ContactRow;
    expect(row.primary_phone).toBe("4255550199"); // "(425) 555-0199" — digits only, no fabricated +
    expect(row.job_title).toBeNull();
  });

  it("no mobile + no business → homePhones[0]; nothing at all → null", () => {
    const homeOnly = { ...CONTACT_2, businessPhones: [], mobilePhone: null };
    expect((c.normalize(rec(homeOnly)) as ContactRow).primary_phone).toBe("4255550122"); // "425.555.0122"
    const none = { ...CONTACT_2, businessPhones: [], homePhones: [], mobilePhone: null };
    expect((c.normalize(rec(none)) as ContactRow).primary_phone).toBeNull();
  });

  it("never emits a non-REGISTRY key (no id, no raw)", () => {
    const row = c.normalize(rec(CONTACT_1)) as ContactRow;
    const keys = Object.keys(row);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("raw");
    expect(keys).toHaveLength(9); // the 10 REGISTRY contacts fields minus `id`
  });
});

describe("MicrosoftConnector.fetchRecordLive — per-sector routing (#26a)", () => {
  const c = new MicrosoftConnector();

  it("calendar sector → GET /me/events/{id}", async () => {
    const calls = installFetch(() => CAL_OCCURRENCE_1);
    const out = await c.fetchRecordLive(calCtx(), CAL_OCCURRENCE_1.id);
    expect((out as { id: string }).id).toBe(CAL_OCCURRENCE_1.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${GRAPH}/me/events/${encodeURIComponent(CAL_OCCURRENCE_1.id)}`);
  });

  it("contacts sector → GET /me/contacts/{id}", async () => {
    const calls = installFetch(() => CONTACT_1);
    const out = await c.fetchRecordLive(ctCtx(), CONTACT_1.id);
    expect((out as { id: string }).id).toBe(CONTACT_1.id);
    expect(calls[0].url).toBe(`${GRAPH}/me/contacts/${encodeURIComponent(CONTACT_1.id)}`);
  });

  it("mail sector (default) is unchanged → GET /me/messages/{id}?$select=...,body", async () => {
    const calls = installFetch(() => MESSAGE_BODY_RESOURCE);
    await c.fetchRecordLive(ctx(), MSG_INBOX_1.id);
    expect(calls[0].url).toContain(`/me/messages/${encodeURIComponent(MSG_INBOX_1.id)}`);
    expect(calls[0].url).toContain("$select=");
    expect(calls[0].url).toContain("body");
  });

  it("a 404 on a calendar drill returns null (source says gone)", async () => {
    installFetch(() => new Response("not found", { status: 404 }));
    expect(await c.fetchRecordLive(calCtx(), "AAMk-missing")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #138 — delta UPDATE partials must never become content-hollow stored rows.
//
// Graph's contract for an updated item (delta-query-overview, "Resource representation in the delta
// query response"): "Updated instances are represented by their id with AT LEAST the updated
// properties, but other properties might be included." normalizeMail is TOTAL (absent → null) and the
// runner's upsert replaces every non-key column with `excluded.<col>`, so applying such an entry
// blanks a cached message or inserts an empty one. The connector re-reads the envelope by id first.
// ═══════════════════════════════════════════════════════════════════════════════════

describe("MicrosoftConnector.sync — delta UPDATE partials (#138)", () => {
  const c = new MicrosoftConnector();

  /** Router: inbox serves `entries` once (deltaLink); sentitems is empty; by-id re-reads via `byId`. */
  function partialRouter(
    entries: ReadonlyArray<unknown>,
    byId: (id: string) => Record<string, unknown> | Response,
  ): Handler {
    return (url: string) => {
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        return deltaPageWithDelta("inbox", entries, "INBOX_AFTER_PARTIAL");
      }
      if (url.includes("/mailFolders/sentitems/messages/delta")) {
        return deltaPageWithDelta("sentitems", [], "SENT_AFTER_PARTIAL");
      }
      if (url.includes("/me/messages/")) {
        const id = decodeURIComponent(
          url.slice(url.indexOf("/me/messages/") + "/me/messages/".length).split("?")[0],
        );
        return byId(id);
      }
      throw new Error(`unexpected url: ${url}`);
    };
  }

  it("a {id,isRead} partial is RE-READ by id — the yielded record carries the full envelope", async () => {
    const calls = installFetch(
      partialRouter([MSG_INBOX_1_READ_FLIP_PARTIAL], () => MSG_INBOX_1_READ),
    );
    const recs = await collect(c.sync(ctx()));

    expect(recs).toHaveLength(1);
    const raw = recs[0].raw as Record<string, unknown>;
    // The content the partial did NOT carry is present — filled from the source, not synthesized.
    expect(raw.subject).toBe(MSG_INBOX_1.subject);
    expect(raw.bodyPreview).toBe(MSG_INBOX_1.bodyPreview);
    expect(raw.receivedDateTime).toBe(MSG_INBOX_1.receivedDateTime);
    expect(raw.internetMessageId).toBe(MSG_INBOX_1.internetMessageId);
    // …and the UPDATE the partial reported won: isRead flipped to true.
    expect(raw.isRead).toBe(true);
    // Folder attribution still comes from the delta (the by-id resource has no well-known name).
    expect(raw.__pci_folder).toBe("inbox");

    // The re-read is an ENVELOPE select — the body footprint contract (ADR 0001) is unchanged.
    const reread = calls.find((k) => k.url.includes("/me/messages/"));
    expect(reread).toBeDefined();
    const selected = (new URL(reread?.url ?? "").searchParams.get("$select") ?? "").split(",");
    expect(selected).toContain("bodyPreview"); // the envelope preview, as always
    expect(selected).not.toContain("body"); // …and NEVER the body (ADR 0001 footprint)
  });

  it("normalizes to a row with content, not 14 nulls (the #138 row shape)", async () => {
    installFetch(partialRouter([MSG_INBOX_1_READ_FLIP_PARTIAL], () => MSG_INBOX_1_READ));
    const recs = await collect(c.sync(ctx()));
    const row = c.normalize(recs[0]) as MailMessageRow;
    expect(row.source_object_id).toBe(MSG_INBOX_1.id);
    expect(row.subject).toBe(MSG_INBOX_1.subject);
    expect(row.from_address).toBe("alice@contoso.example.com");
    expect(row.received_at).toBe(MSG_INBOX_1.receivedDateTime);
    expect(row.is_read).toBe(true);
    expect(row.folder).toBe("inbox");
  });

  it("a partial for an UNSEEN message lands complete (never an empty row)", async () => {
    installFetch(partialRouter([MSG_UNSEEN_READ_FLIP_PARTIAL], () => MSG_UNSEEN_FULL));
    const recs = await collect(c.sync(ctx()));
    expect(recs).toHaveLength(1);
    const row = c.normalize(recs[0]) as MailMessageRow;
    expect(row.source_object_id).toBe(MSG_UNSEEN_FULL.id);
    expect(row.subject).toBe("Renewal notice");
    expect(row.received_at).toBe(MSG_UNSEEN_FULL.receivedDateTime);
    expect(row.snippet).toBe(MSG_UNSEEN_FULL.bodyPreview);
  });

  it("a COMPLETE delta entry is applied as-is — no extra Graph request", async () => {
    const calls = installFetch(partialRouter([MSG_INBOX_1], () => MESSAGE_BODY_RESOURCE));
    const recs = await collect(c.sync(ctx()));
    expect(recs).toHaveLength(1);
    expect(recs[0].raw).toMatchObject({ id: MSG_INBOX_1.id, subject: MSG_INBOX_1.subject });
    expect(calls.some((k) => k.url.includes("/me/messages/"))).toBe(false); // fast path
  });

  it("a 404 on the re-read TOMBSTONES (source says gone) — never a blank row", async () => {
    installFetch(
      partialRouter([MSG_UNSEEN_READ_FLIP_PARTIAL], () => new Response("gone", { status: 404 })),
    );
    const recs = await collect(c.sync(ctx()));
    expect(recs).toHaveLength(1);
    expect(recs[0].deleted).toBe(true);
    expect(recs[0].externalId).toBe(MSG_UNSEEN_READ_FLIP_PARTIAL.id);
    expect(recs[0].raw).toBeNull();
  });

  it("a transient 5xx on the re-read is RETRYABLE and yields nothing from that page", async () => {
    process.env.PCI_RETRY_5XX_BASE_MS = "1";
    try {
      installFetch(
        partialRouter(
          [MSG_INBOX_1_READ_FLIP_PARTIAL],
          () => new Response("bad gateway", { status: 502 }),
        ),
      );
      await expect(collect(c.sync(ctx()))).rejects.toBeInstanceOf(RetryableError);
    } finally {
      delete process.env.PCI_RETRY_5XX_BASE_MS;
    }
  });

  it("a terminal non-2xx on the re-read throws a secret-free error", async () => {
    installFetch(
      partialRouter([MSG_INBOX_1_READ_FLIP_PARTIAL], () => new Response("forbidden", { status: 403 })),
    );
    await expect(collect(c.sync(ctx()))).rejects.toThrow(/403/);
    installFetch(
      partialRouter([MSG_INBOX_1_READ_FLIP_PARTIAL], () => new Response("forbidden", { status: 403 })),
    );
    await collect(c.sync(ctx())).catch((err: unknown) => {
      expect(String((err as Error).message)).not.toContain(TOKEN);
    });
  });

  it("the re-read is host-pinned: the bearer never leaves graph.microsoft.com", async () => {
    const calls = installFetch(
      partialRouter([MSG_INBOX_1_READ_FLIP_PARTIAL], () => MSG_INBOX_1_READ),
    );
    await collect(c.sync(ctx()));
    for (const k of calls) expect(new URL(k.url).host).toBe("graph.microsoft.com");
  });

  it("the per-run re-read budget is bounded: a partial flood ends in RetryableError, not thousands of GETs", async () => {
    // Every inbox page is a full page of partials WITH a nextLink, so paging never ends on its own.
    let served = 0;
    const calls = installFetch((url: string) => {
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        const page = Array.from({ length: 50 }, (_, i) => ({
          ...MSG_UNSEEN_READ_FLIP_PARTIAL,
          id: `FLOOD-${served * 50 + i}`,
        }));
        served++;
        return deltaPageWithNext("inbox", page, `FLOOD_SKIP_${served}`);
      }
      if (url.includes("/me/messages/")) {
        const id = decodeURIComponent(
          url.slice(url.indexOf("/me/messages/") + "/me/messages/".length).split("?")[0],
        );
        return { ...MSG_UNSEEN_FULL, id };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    await expect(collect(c.sync(ctx()))).rejects.toBeInstanceOf(RetryableError);
    const rereads = calls.filter((k) => k.url.includes("/me/messages/")).length;
    // Bounded far short of what MAX_PAGES_PER_FOLDER alone would allow (1000 pages × 50 = 50k).
    expect(rereads).toBeGreaterThan(0);
    expect(rereads).toBeLessThan(1000);
    // …and a page always COMPLETES before the budget trips, so the checkpoint always advances.
    expect(rereads % 50).toBe(0);
  });

  it("@removed entries are never re-read — a tombstone carries no content by design", async () => {
    const calls = installFetch(partialRouter([REMOVED_INBOX_1], () => MSG_INBOX_1_READ));
    const recs = await collect(c.sync(ctx()));
    expect(recs).toHaveLength(1);
    expect(recs[0].deleted).toBe(true);
    expect(calls.some((k) => k.url.includes("/me/messages/"))).toBe(false);
  });
});

describe("MicrosoftConnector.normalize — the fail-closed hollow-row guard (#138)", () => {
  const c = new MicrosoftConnector();

  it("REFUSES to normalize a content-hollow payload (loud error, not 14 nulls)", () => {
    const rec: RawRecord = {
      object: "message",
      externalId: MSG_INBOX_1.id,
      raw: { ...MSG_INBOX_1_READ_FLIP_PARTIAL, __pci_folder: "inbox" },
    };
    expect(() => c.normalize(rec)).toThrow(/content-hollow/);
  });

  it("accepts a sparse-but-real message (one content field is enough)", () => {
    const rec: RawRecord = {
      object: "message",
      externalId: "AAMk-sparse",
      raw: { id: "AAMk-sparse", receivedDateTime: "2026-06-01T00:00:00Z", __pci_folder: "inbox" },
    };
    const row = c.normalize(rec) as MailMessageRow;
    expect(row.received_at).toBe("2026-06-01T00:00:00Z");
    expect(row.subject).toBeNull(); // faithful: the source reported none
  });

  it("an empty subject is CONTENT, not absence (presence beats truthiness)", () => {
    const rec: RawRecord = {
      object: "message",
      externalId: "AAMk-nosubject",
      raw: {
        id: "AAMk-nosubject",
        subject: "",
        conversationId: "CONV-nosubject",
        __pci_folder: "inbox",
      },
    };
    const row = c.normalize(rec) as MailMessageRow;
    expect(row.subject).toBe("");
    expect(row.thread_id).toBe("CONV-nosubject");
  });
});
