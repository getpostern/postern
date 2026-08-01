// Gmail connector DB round-trip — gated on DATABASE_URL so CI stays green when absent.
//
// Drives the generic runner (syncConnection) end-to-end against mail_messages with imapflow mocked
// via the injectable client factory, proving: (1) the per-folder CONDSTORE sync lands ENVELOPE rows
// only — no body/source in `raw`; the localized Sent path maps to the neutral enum; the per-folder
// {uidValidity,modseq} cursor map persists; (2) a QRESYNC VANISHED uid tombstones the row (deleted_at
// stamped, row kept) per ADR 0004; (3) a later live sighting resurrects it (deleted_at cleared);
// (4) fetchRecordLive serves the RFC822 body on demand and stores NOTHING (row count/columns
// unchanged).
//
// RECENCY WINDOW (ADR 0017 fast-follow) — two extra suites: (5) the daily census sweep tombstones an
// in-window row missed by dead QRESYNC (out-of-window rows untouched; a UIDVALIDITY reset's windowed
// re-backfill cleans stale-generation rows; Sent-less mailbox sweeps on the inbox census alone);
// (6) setSyncWindow grow → cursor-null → a WIDER windowed SEARCH backfill (idempotent, no dupes);
// shrink → narrower SEARCH; already-cached older rows KEPT both ways.
//
// BLOCK fold (2026-07-11) — two more suites: (7) the reviewer's empirical folder-vanish repro
// through the REAL syncConnection (Sent vanishes from LIST with a census due → NO sweep, sent rows
// stay live; Sent reappears → the census+sweep works again and a tombstoned-but-live row RECOVERS
// via resurrectPresent); (8) reconcileObjectSnapshot's resurrectPresent against the REAL
// mail_messages table (census-present tombstoned in-window rows resurrect; out-of-window stay
// tombstoned; `union:%` never resurrected; option-absent behavior unchanged).
//
// The credential is sealed with a dummy app-password + a username (the Gmail address) and is a
// static_token custody (no refresh_ref / expires_at), so resolveAccessToken opens it as-is.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SyncContext } from "./types.js";
import { GmailConnector } from "./gmail.js";
import {
  INBOX_MSG_1,
  SENT_MSG_1,
  MESSAGE_BODY_RESULT,
  INBOX_PATH,
  SENT_PATH,
  UIDVALIDITY_INBOX,
  UIDVALIDITY_SENT,
  makeFakeImap,
  msgAt,
  type FakeRound,
} from "./gmail.fixtures.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A dedicated throwaway user so this round-trip can't race another suite's gmail credential
// (test files run in parallel; unique(user_id, provider) would otherwise contend).
const TEST_USER = "00000000-0000-0000-0000-0000000007b1";
const APP_PASSWORD = "dummy-gmail-app-password";
const GMAIL_ADDR = "operator@example.com";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOL_MS = 30_000;

/** Seed one user + gmail credential + mail connector; returns ids for cleanup. */
async function seedGmailConnection(
  userId: string,
  label: string,
  syncWindowDays: number | null = null,
): Promise<{ connectionId: string; credentialId: string; secretRef: string }> {
  const { pool } = await import("../db.js");
  const { seal } = await import("../secrets/index.js");
  await pool.query(`insert into users (id, label) values ($1, $2) on conflict (id) do nothing`, [
    userId,
    label,
  ]);
  const secretRef = await seal({ userId, provider: "gmail", purpose: "access" }, APP_PASSWORD);
  const cred = await pool.query(
    `insert into provider_credentials (user_id, provider, custody, secret_ref, username, status)
     values ($1, 'gmail', 'static_token', $2, $3, 'active') returning id`,
    [userId, secretRef, GMAIL_ADDR],
  );
  const credentialId = cred.rows[0].id as string;
  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status, sync_window_days)
     values ($1, $2, 'mail', 'gmail', 'active', $3) returning id`,
    [userId, credentialId, syncWindowDays],
  );
  return { connectionId: conn.rows[0].id as string, credentialId, secretRef };
}

/** FK-cascade cleanup for one seeded connection (never ends the shared pool). */
async function cleanupGmailConnection(
  userId: string,
  credentialId: string,
  secretRef: string,
): Promise<void> {
  const { pool } = await import("../db.js");
  await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
  await pool.query(`delete from secrets where ref = $1`, [secretRef]);
  await pool.query(`delete from users where id = $1`, [userId]);
}

// The shared pool is ended ONCE after every describe in this file (describes run sequentially).
afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

/** INBOX always carries SPECIAL-USE \Inbox; Sent carries \Sent (so discovery is exercised). */
function inbox(over: Partial<FakeRound["folders"][number]>): FakeRound["folders"][number] {
  return {
    path: INBOX_PATH,
    specialUse: "\\Inbox",
    uidValidity: UIDVALIDITY_INBOX,
    highestModseq: 55n,
    ...over,
  };
}
function sent(over: Partial<FakeRound["folders"][number]>): FakeRound["folders"][number] {
  return {
    path: SENT_PATH,
    specialUse: "\\Sent",
    uidValidity: UIDVALIDITY_SENT,
    highestModseq: 77n,
    ...over,
  };
}

// Three sync rounds against ONE registered connector: initial → VANISHED → re-sighting.
const ROUNDS: FakeRound[] = [
  { folders: [inbox({ highestModseq: 55n, messages: [INBOX_MSG_1] }), sent({ messages: [SENT_MSG_1] })] },
  { folders: [inbox({ highestModseq: 60n, messages: [], vanished: [101] }), sent({ messages: [] })] },
  { folders: [inbox({ highestModseq: 65n, messages: [INBOX_MSG_1] }), sent({ messages: [] })] },
];

describe.skipIf(!HAS_DB)("Gmail DB round-trip (imapflow mocked)", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { registerConnector } = await import("../sync/index.js");
    // Seal a dummy app-password at purpose 'access'; static_token custody → opened as-is.
    const seeded = await seedGmailConnection(TEST_USER, "gmail-db-test");
    connectionId = seeded.connectionId;
    credentialId = seeded.credentialId;
    secretRef = seeded.secretRef;

    // ONE connector instance drives all three rounds (the fake pops the next round per sync run).
    registerConnector(new GmailConnector(makeFakeImap({ rounds: ROUNDS }).factory));
  });

  afterAll(async () => {
    // FK cascade: credential -> connectors -> mail_messages. (The pool ends in the file-level afterAll.)
    await cleanupGmailConnection(TEST_USER, credentialId, secretRef);
  });

  it("round 1: lands envelope rows only (no body/source), folder enums, cursor map persists", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2); // 1 inbox + 1 sent
    expect(res.deleted).toBe(0);

    const count = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(count.rows[0].n).toBe(2);

    // The inbox envelope: scalar columns mapped; raw carries NO body/source (envelope-only footprint).
    const inboxRow = await pool.query(
      `select from_address, from_name, sender_address, subject, snippet, thread_id,
              message_id_header, is_read, has_attachments, folder, importance,
              received_at is not null as has_received, deleted_at,
              (raw ? 'source') as has_source, (raw ? 'body') as has_body,
              (raw ? '__pci_folder') as has_folder_key
         from mail_messages where connection_id = $1 and source_object_id = 'inbox:101'`,
      [connectionId],
    );
    const r = inboxRow.rows[0];
    expect(r.from_address).toBe("alice@contoso.example.com");
    expect(r.from_name).toBe("Alice Sender");
    expect(r.sender_address).toBeNull(); // sender === from ⇒ null
    expect(r.subject).toBe("Q3 planning agenda");
    expect(r.snippet).toBeNull(); // V0: IMAP has no snippet
    expect(r.thread_id).toBe("GM-THRID-2000001");
    expect(r.message_id_header).toBe("<CY4PR01MB-inbox-0001@contoso.example.com>");
    expect(r.is_read).toBe(false);
    expect(r.has_attachments).toBe(true);
    expect(r.folder).toBe("inbox");
    expect(r.importance).toBeNull();
    expect(r.has_received).toBe(true);
    expect(r.deleted_at).toBeNull();
    expect(r.has_source).toBe(false); // ADR 0001: the body/source is NEVER stored
    expect(r.has_body).toBe(false);
    expect(r.has_folder_key).toBe(true); // synthetic folder thread (not a queryable column)

    // The sent envelope maps to folder=sent (discovered via SPECIAL-USE, localized path).
    const sentRow = await pool.query(
      `select folder from mail_messages where connection_id = $1 and source_object_id = 'sent:201'`,
      [connectionId],
    );
    expect(sentRow.rows[0].folder).toBe("sent");

    // The cursor persisted as a per-folder {uidValidity,modseq} JSON map.
    const cur = await pool.query(`select cursor, last_synced_at, status from connectors where id = $1`, [
      connectionId,
    ]);
    expect(cur.rows[0].status).toBe("active");
    expect(cur.rows[0].last_synced_at).not.toBeNull();
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, { uidValidity: string; modseq: string }>;
    expect(map.inbox).toEqual({ uidValidity: "10000", modseq: "55" });
    expect(map.sent).toEqual({ uidValidity: "20000", modseq: "77" });
    // The runner threads the mail default window (180d) → the backfill search doubled as the census
    // and the sweep stamped the reserved `_census.at` clock alongside the folder entries.
    const census = (map as Record<string, unknown>)._census as { at: string };
    expect(Math.abs(Date.parse(census.at) - Date.now())).toBeLessThan(TOL_MS);
  });

  it("round 2: a QRESYNC VANISHED uid tombstones the row (deleted_at stamped, row kept)", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);

    const row = await pool.query(
      `select deleted_at from mail_messages where connection_id = $1 and source_object_id = 'inbox:101'`,
      [connectionId],
    );
    expect(row.rows[0].deleted_at).not.toBeNull(); // tombstoned, not hard-deleted

    // Row count unchanged (tombstone, not delete); the sent message stays live.
    const total = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(total.rows[0].n).toBe(2);

    // The inbox cursor advanced (modseq 55 → 60).
    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, { uidValidity: string; modseq: string }>;
    expect(map.inbox).toEqual({ uidValidity: "10000", modseq: "60" });
  });

  it("round 3: a later live sighting resurrects the tombstoned row", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1); // the re-sighted inbox message

    const row = await pool.query(
      `select deleted_at from mail_messages where connection_id = $1 and source_object_id = 'inbox:101'`,
      [connectionId],
    );
    expect(row.rows[0].deleted_at).toBeNull(); // resurrected (ADR 0004 #3)
  });

  it("fetchRecordLive serves the RFC822 body on demand and stores NOTHING", async () => {
    const { pool } = await import("../db.js");

    const before = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );

    const fetchFake = makeFakeImap({
      rounds: [{ folders: [inbox({ highestModseq: 65n })] }],
      bodyByUid: { 101: MESSAGE_BODY_RESULT },
    });
    const ctx: SyncContext = {
      userId: TEST_USER,
      connectionId,
      secretRef,
      secret: APP_PASSWORD,
      username: GMAIL_ADDR,
    };
    const out = (await new GmailConnector(fetchFake.factory).fetchRecordLive(ctx, "inbox:101")) as {
      source: string;
    };
    expect(out.source).toContain("agenda");

    // Nothing stored: the row count is unchanged, and no cached row carries a body/source.
    const after = await pool.query(
      `select count(*)::int as n,
              bool_or(raw ? 'source') as any_source,
              bool_or(raw ? 'body') as any_body
         from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].any_source).toBe(false);
    expect(after.rows[0].any_body).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Recency window (ADR 0017 fast-follow) — deletion sweep e2e, driven through the REAL
// syncConnection. A Sent-less mailbox (LIST has only INBOX): the sweep proceeds on the
// inbox census alone.
// ─────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("Gmail recency window — daily census sweep (Sent-less mailbox)", () => {
  const USER2 = "00000000-0000-0000-0000-0000000007b2";
  let connectionId = "";
  let credentialId = "";
  let secretRef = "";

  // Dates relative to NOW (the connector derives the window per run). Default window = 180d.
  const MSG_A = msgAt(101, 5); // in-window; vanishes silently before round 2 (dead QRESYNC)
  const MSG_B = msgAt(102, 10); // in-window; survives round 2, stale generation by round 3
  const MSG_NEW = msgAt(7, 3); // the new generation's only message (round 3)

  const ROUNDS2: FakeRound[] = [
    // r1: first run → windowed backfill (search = [101, 102]) + free census + sweep + stamp.
    { folders: [inbox({ messages: [MSG_A, MSG_B] })] },
    // r2: incremental (clock rewound 25h by the test) — 101 is GONE from the census with NO VANISHED
    // (the dead-QRESYNC reality). 102 arrives as a flag change so the run yields a record for the
    // advanced `_census.at` cursor to ride (a zero-record run deliberately can't persist the stamp).
    { folders: [inbox({ highestModseq: 60n, messages: [MSG_B], searchUids: [102] })] },
    // r3: UIDVALIDITY reset → windowed re-backfill; the census covers only the new generation.
    { folders: [inbox({ uidValidity: 30_000n, highestModseq: 5n, messages: [MSG_NEW] })] },
  ];

  beforeAll(async () => {
    const { registerConnector } = await import("../sync/index.js");
    const seeded = await seedGmailConnection(USER2, "gmail-window-sweep-test");
    connectionId = seeded.connectionId;
    credentialId = seeded.credentialId;
    secretRef = seeded.secretRef;
    registerConnector(new GmailConnector(makeFakeImap({ rounds: ROUNDS2 }).factory));
  });

  afterAll(async () => {
    await cleanupGmailConnection(USER2, credentialId, secretRef);
  });

  it("round 1: windowed backfill lands the in-window rows and stamps _census.at", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2);

    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map = JSON.parse(cur.rows[0].cursor) as { _census?: { at: string } };
    expect(map._census?.at).toBeTypeOf("string");

    // Plant an OUT-OF-WINDOW row (as if cached under an older, wider window): the sweep must
    // never touch it — the window bounds fetch, not retention (ADR 0017).
    await pool.query(
      `insert into mail_messages (connection_id, user_id, source_object_id, subject, received_at, folder, raw)
       values ($1, $2, 'inbox:999', 'ancient but kept', now() - interval '400 days', 'inbox', '{}'::jsonb)`,
      [connectionId, USER2],
    );
  });

  it("round 2 (clock rewound 25h): the census sweeps the silent deletion; out-of-window row untouched", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    // Rewind the census clock so the incremental run re-censuses (we can't wait 24h in a test).
    const cur0 = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map0 = JSON.parse(cur0.rows[0].cursor) as Record<string, unknown>;
    map0._census = { at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    await pool.query(`update connectors set cursor = $2 where id = $1`, [
      connectionId,
      JSON.stringify(map0),
    ]);

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);

    const rows = await pool.query(
      `select source_object_id, deleted_at from mail_messages where connection_id = $1 order by source_object_id`,
      [connectionId],
    );
    const byId = new Map(rows.rows.map((r) => [r.source_object_id as string, r.deleted_at]));
    expect(byId.get("inbox:101")).not.toBeNull(); // missed deletion → swept tombstone
    expect(byId.get("inbox:102")).toBeNull(); // still in the census → live
    expect(byId.get("inbox:999")).toBeNull(); // OUT of window → NEVER touched
    expect(rows.rows).toHaveLength(3); // tombstoned, not deleted

    // The clock advanced past the rewound stamp.
    const cur1 = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map1 = JSON.parse(cur1.rows[0].cursor) as { _census: { at: string } };
    expect(Math.abs(Date.parse(map1._census.at) - Date.now())).toBeLessThan(TOL_MS);
  });

  it("round 3: a UIDVALIDITY reset's windowed re-backfill sweeps stale-generation in-window rows", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1); // the new generation's message

    const rows = await pool.query(
      `select source_object_id, deleted_at from mail_messages where connection_id = $1`,
      [connectionId],
    );
    const byId = new Map(rows.rows.map((r) => [r.source_object_id as string, r.deleted_at]));
    expect(byId.get("inbox:7")).toBeNull(); // new generation → live
    expect(byId.get("inbox:102")).not.toBeNull(); // stale generation, in-window → swept
    expect(byId.get("inbox:999")).toBeNull(); // out-of-window → still untouched
    expect(byId.get("inbox:101")).not.toBeNull(); // keeps its earlier tombstone
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Recency window — setSyncWindow grow/shrink end-to-end (ADR 0017's cursor-null contract):
// grow → wider SEARCH backfill (idempotent, no dupes); shrink → narrower SEARCH; cached
// older rows KEPT both ways.
// ─────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("Gmail recency window — setSyncWindow grow/shrink e2e", () => {
  const USER3 = "00000000-0000-0000-0000-0000000007b3";
  let connectionId = "";
  let credentialId = "";
  let secretRef = "";
  let handle: ReturnType<typeof makeFakeImap>;

  const MSG_10D = msgAt(501, 10);
  const MSG_60D = msgAt(502, 60);
  const MSG_300D = msgAt(503, 300);
  const ALL = [MSG_10D, MSG_60D, MSG_300D];

  const ROUNDS3: FakeRound[] = [
    // r1 (window 90): the "server" reports only the in-window uids.
    { folders: [inbox({ messages: ALL, searchUids: [501, 502] })] },
    // r2 (grown to 365): the wider search now also returns the 300d-old message.
    { folders: [inbox({ messages: ALL, searchUids: [501, 502, 503] })] },
    // r3 (shrunk to 30): only the 10d-old message is inside the narrow window.
    { folders: [inbox({ messages: ALL, searchUids: [501] })] },
  ];

  beforeAll(async () => {
    const { registerConnector } = await import("../sync/index.js");
    const seeded = await seedGmailConnection(USER3, "gmail-window-grow-shrink-test", 90);
    connectionId = seeded.connectionId;
    credentialId = seeded.credentialId;
    secretRef = seeded.secretRef;
    handle = makeFakeImap({ rounds: ROUNDS3 });
    registerConnector(new GmailConnector(handle.factory));
  });

  afterAll(async () => {
    await cleanupGmailConnection(USER3, credentialId, secretRef);
  });

  it("window 90: the backfill SEARCH carries the 90d+pad bound and lands only in-window rows", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2);

    const since = (handle.searches[0].query as { since: Date }).since;
    expect(Math.abs(since.getTime() - (Date.now() - 91 * DAY_MS))).toBeLessThan(TOL_MS);

    const n = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1 and deleted_at is null`,
      [connectionId],
    );
    expect(n.rows[0].n).toBe(2);
  });

  it("GROW to 365: setSyncWindow nulls the cursor; the wider SEARCH backfills with NO dupes", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const { setSyncWindow } = await import("../core/lifecycle.js");

    await setSyncWindow(
      { userId: USER3, agentId: "operator", grantedSectors: new Set(["mail"]) },
      connectionId,
      365,
    );
    const cur = await pool.query(`select cursor, sync_window_days from connectors where id = $1`, [
      connectionId,
    ]);
    expect(cur.rows[0].cursor).toBeNull(); // ADR 0017: a window change funnels into the full-resync branch
    expect(cur.rows[0].sync_window_days).toBe(365);

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);

    const since = (handle.searches[1].query as { since: Date }).since;
    expect(Math.abs(since.getTime() - (Date.now() - 366 * DAY_MS))).toBeLessThan(TOL_MS);

    // 3 live rows, exactly one per uid (idempotent upserts absorbed the re-fetched 501/502).
    const rows = await pool.query(
      `select source_object_id from mail_messages where connection_id = $1 and deleted_at is null
        order by source_object_id`,
      [connectionId],
    );
    expect(rows.rows.map((r) => r.source_object_id)).toEqual(["inbox:501", "inbox:502", "inbox:503"]);
  });

  it("SHRINK to 30: the narrower SEARCH re-pulls the narrow range; cached OLDER rows are KEPT", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const { setSyncWindow } = await import("../core/lifecycle.js");

    await setSyncWindow(
      { userId: USER3, agentId: "operator", grantedSectors: new Set(["mail"]) },
      connectionId,
      30,
    );

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);

    const since = (handle.searches[2].query as { since: Date }).since;
    expect(Math.abs(since.getTime() - (Date.now() - 31 * DAY_MS))).toBeLessThan(TOL_MS);

    // Shrink is non-destructive: the 60d and 300d rows sit OUTSIDE the new sweep scope and stay live.
    const rows = await pool.query(
      `select source_object_id from mail_messages where connection_id = $1 and deleted_at is null
        order by source_object_id`,
      [connectionId],
    );
    expect(rows.rows.map((r) => r.source_object_id)).toEqual(["inbox:501", "inbox:502", "inbox:503"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// BLOCK fold #1 — the reviewer's empirical folder-vanish repro, through the REAL
// syncConnection: round 1 caches INBOX+Sent; round 2's LIST omits Sent (Gmail's per-label
// "Show in IMAP" toggle) with a census due → the guard withholds the sweep, sent rows stay
// live, the clock does not advance; round 3 Sent reappears → the census+sweep works again
// and (BLOCK fold #2) a tombstoned-but-live row RECOVERS via resurrectPresent.
// ─────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("Gmail folder-vanish sweep guard e2e (BLOCK fold #1 + #2)", () => {
  const USER4 = "00000000-0000-0000-0000-0000000007b4";
  let connectionId = "";
  let credentialId = "";
  let secretRef = "";

  // Dates relative to NOW; default window = 180d. UIDs are per-folder (inbox 6xx, sent 7xx).
  const IN_MSG_1 = msgAt(601, 5);
  const SENT_MSG = msgAt(701, 6);
  const IN_MSG_2 = msgAt(602, 4); // round 2's changed message (a record for the cursor to ride)
  const IN_MSG_3 = msgAt(603, 3); // round 3's changed message

  const ROUNDS4: FakeRound[] = [
    // r1: INBOX + Sent both discovered — windowed backfill (the search doubles as the census),
    // sweep, `_census.at` stamped.
    { folders: [inbox({ messages: [IN_MSG_1] }), sent({ messages: [SENT_MSG] })] },
    // r2: LIST OMITS Sent entirely. The census is due (the test rewinds the clock 25h): the inbox
    // census completes, but the STORED `sent` cursor key is absent from discovery — without the
    // guard the sweep would run on the inbox-only census union and falsely tombstone sent:701.
    { folders: [inbox({ highestModseq: 60n, messages: [IN_MSG_2], searchUids: [601, 602] })] },
    // r3: Sent reappears (same UIDVALIDITY ⇒ incremental). Census due again; both folders census
    // → the sweep runs, and the manually-tombstoned sent:701 (still IN the census — a live
    // sighting) is RESURRECTED by resurrectPresent through the real runner path.
    {
      folders: [
        inbox({ highestModseq: 65n, messages: [IN_MSG_3], searchUids: [601, 602, 603] }),
        sent({ highestModseq: 80n, messages: [], searchUids: [701] }),
      ],
    },
  ];

  beforeAll(async () => {
    const { registerConnector } = await import("../sync/index.js");
    const seeded = await seedGmailConnection(USER4, "gmail-folder-vanish-test");
    connectionId = seeded.connectionId;
    credentialId = seeded.credentialId;
    secretRef = seeded.secretRef;
    registerConnector(new GmailConnector(makeFakeImap({ rounds: ROUNDS4 }).factory));
  });

  afterAll(async () => {
    await cleanupGmailConnection(USER4, credentialId, secretRef);
  });

  /** Rewind the persisted `_census.at` clock so the next incremental run re-censuses. */
  async function rewindCensusClock(agoMs: number): Promise<string> {
    const { pool } = await import("../db.js");
    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, unknown>;
    const at = new Date(Date.now() - agoMs).toISOString();
    map._census = { at };
    await pool.query(`update connectors set cursor = $2 where id = $1`, [
      connectionId,
      JSON.stringify(map),
    ]);
    return at;
  }

  it("round 1: INBOX + Sent cached; census+sweep completed and stamped", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2); // inbox:601 + sent:701

    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, unknown>;
    expect(Object.keys(map).sort()).toEqual(["_census", "inbox", "sent"]);
  });

  it("round 2: LIST omits Sent with a census due → NO sweep, sent rows stay LIVE, clock unadvanced", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const rewoundAt = await rewindCensusClock(25 * 60 * 60 * 1000);

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);

    // The repro's crux: sent:701 is ABSENT from this run's census union ({inbox:601, inbox:602})
    // and squarely in-window — an unguarded sweep would have tombstoned it. It must stay live.
    const rows = await pool.query(
      `select source_object_id, deleted_at from mail_messages where connection_id = $1
        order by source_object_id`,
      [connectionId],
    );
    const byId = new Map(rows.rows.map((r) => [r.source_object_id as string, r.deleted_at]));
    expect(byId.get("sent:701")).toBeNull(); // NOT falsely tombstoned — the guard held
    expect(byId.get("inbox:601")).toBeNull();
    expect(byId.get("inbox:602")).toBeNull(); // the round-2 record landed

    // No stamp either: the clock still reads the rewound value (the withheld sweep never advances it).
    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, { at?: string }> & {
      _census: { at: string };
    };
    expect(map._census.at).toBe(rewoundAt);
    // The vanished folder's cursor entry rode along untouched (Sent resumes incrementally on return).
    expect(Object.hasOwn(map, "sent")).toBe(true);
  });

  it("round 3: Sent reappears → census+sweep work again and a tombstoned-but-live row RECOVERS", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    // Simulate the pre-fix damage the guard now prevents: sent:701 falsely tombstoned while the
    // source still has it. The reappeared folder's census must resurrect it (a live sighting).
    await pool.query(
      `update mail_messages set deleted_at = now()
        where connection_id = $1 and source_object_id = 'sent:701'`,
      [connectionId],
    );
    await rewindCensusClock(25 * 60 * 60 * 1000);

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);

    const rows = await pool.query(
      `select source_object_id, deleted_at from mail_messages where connection_id = $1
        order by source_object_id`,
      [connectionId],
    );
    const byId = new Map(rows.rows.map((r) => [r.source_object_id as string, r.deleted_at]));
    expect(byId.get("sent:701")).toBeNull(); // RESURRECTED by the census sighting (fold #2)
    expect(byId.get("inbox:601")).toBeNull(); // censused → live
    expect(byId.get("inbox:602")).toBeNull();
    expect(byId.get("inbox:603")).toBeNull(); // the round-3 record landed

    // The completed census+sweep stamped a fresh clock.
    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map = JSON.parse(cur.rows[0].cursor) as { _census: { at: string } };
    expect(Math.abs(Date.parse(map._census.at) - Date.now())).toBeLessThan(TOL_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// BLOCK fold #2 — reconcileObjectSnapshot's resurrectPresent against the REAL mail_messages
// table: census-present tombstoned rows resurrect ONLY in-window; out-of-window tombstoned
// rows stay tombstoned; `union:%` synthetics are never resurrected; the option-absent default
// leaves tombstones untouched (existing-caller behavior unchanged). The absent-from-census
// tombstone pass still works alongside.
// ─────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("reconcileObjectSnapshot — resurrectPresent (DB, BLOCK fold #2)", () => {
  const USER5 = "00000000-0000-0000-0000-0000000007b5";
  let connectionId = "";
  let credentialId = "";
  let secretRef = "";

  beforeAll(async () => {
    const seeded = await seedGmailConnection(USER5, "gmail-resurrect-test");
    connectionId = seeded.connectionId;
    credentialId = seeded.credentialId;
    secretRef = seeded.secretRef;
  });

  afterAll(async () => {
    await cleanupGmailConnection(USER5, credentialId, secretRef);
  });

  /** Insert a mail row with an ingested_at safely BEFORE the sweep fence. */
  async function plantRow(soid: string, receivedDaysAgo: number, tombstoned: boolean): Promise<void> {
    const { pool } = await import("../db.js");
    await pool.query(
      `insert into mail_messages (connection_id, user_id, source_object_id, subject, received_at,
                                  folder, raw, ingested_at, deleted_at)
       values ($1, $2, $3, $3, now() - ($4 || ' days')::interval, 'inbox', '{}'::jsonb,
               now() - interval '1 hour', case when $5 then now() - interval '1 day' end)
       on conflict (connection_id, source_object_id) do nothing`,
      [connectionId, USER5, soid, String(receivedDaysAgo), tombstoned],
    );
  }

  it("resurrects census-present in-window tombstones; out-of-window and union:% stay; absentees sweep", async () => {
    const { pool } = await import("../db.js");
    const { reconcileObjectSnapshot } = await import("../sync/runner.js");

    await plantRow("inbox:801", 5, true); // tombstoned, in-window, IN census → resurrects
    await plantRow("inbox:802", 400, true); // tombstoned, OUT of window, IN census → stays tombstoned
    await plantRow("union:x", 5, true); // engine namespace, IN census → NEVER resurrected
    await plantRow("inbox:803", 5, false); // live, in-window, ABSENT from census → swept (tombstone pass)

    const census = new Set(["inbox:801", "inbox:802", "union:x"]);
    const runStartedAt = new Date();
    const swept = await reconcileObjectSnapshot(connectionId, "mail", "message", census, runStartedAt, {
      column: "received_at",
      from: new Date(Date.now() - 179 * DAY_MS),
      to: runStartedAt,
      resurrectPresent: true,
    });
    expect(swept).toBe(1); // the return value stays the TOMBSTONED count (inbox:803 only)

    const rows = await pool.query(
      `select source_object_id, deleted_at from mail_messages where connection_id = $1
        order by source_object_id`,
      [connectionId],
    );
    const byId = new Map(rows.rows.map((r) => [r.source_object_id as string, r.deleted_at]));
    expect(byId.get("inbox:801")).toBeNull(); // census sighting → resurrected
    expect(byId.get("inbox:802")).not.toBeNull(); // out-of-window → untouched tombstone
    expect(byId.get("union:x")).not.toBeNull(); // engine-owned → never resurrected
    expect(byId.get("inbox:803")).not.toBeNull(); // absent from the census → swept
  });

  it("default (option absent): a census-present tombstoned row stays tombstoned — behavior unchanged", async () => {
    const { pool } = await import("../db.js");
    const { reconcileObjectSnapshot } = await import("../sync/runner.js");

    await plantRow("inbox:804", 5, true); // tombstoned, in-window, IN census

    const runStartedAt = new Date();
    await reconcileObjectSnapshot(
      connectionId,
      "mail",
      "message",
      new Set(["inbox:804"]),
      runStartedAt,
      { column: "received_at", from: new Date(Date.now() - 179 * DAY_MS), to: runStartedAt },
    );

    const row = await pool.query(
      `select deleted_at from mail_messages where connection_id = $1 and source_object_id = 'inbox:804'`,
      [connectionId],
    );
    expect(row.rows[0].deleted_at).not.toBeNull(); // no resurrect without the opt-in
  });
});
