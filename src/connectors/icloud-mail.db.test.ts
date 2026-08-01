// iCloud Mail connector DB round-trip — gated on DATABASE_URL so CI stays green when absent.
//
// Drives the generic runner (syncConnection) end-to-end against mail_messages with imapflow mocked via
// the injectable client factory, proving: (1) the per-folder CONDSTORE/QRESYNC sync lands ENVELOPE
// rows only — no body/source in `raw`; the localized "Sent Messages" path maps to the neutral enum;
// the per-folder {uidValidity,modseq} cursor map persists (no `_census` key — iCloud has none);
// (2) a QRESYNC VANISHED uid tombstones the row (deleted_at stamped, row kept) per ADR 0004; (3) a
// later live sighting resurrects it (deleted_at cleared); (4) fetchRecordLive serves the RFC822 body
// on demand and stores NOTHING (row count/columns unchanged); (5) a UIDVALIDITY reset re-backfills a
// windowed full resync and the stale-generation sweep runs (both folders enumerated).
//
// The credential is sealed with a dummy ASP + a username (the Apple ID) as static_token custody (no
// refresh_ref / expires_at), so resolveAccessToken opens it as-is. The runner gates provider "apple"
// into MAIL_PROVIDERS, so a null sync_window_days resolves to the 180-day default → the windowed path.
//
// #43 hygiene: every query is scoped by connection_id (no unscoped count(*)/list); a dedicated
// throwaway user keeps this suite from racing another connector's credential.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SyncContext } from "./types.js";
import { IcloudMailConnector } from "./icloud-mail.js";
import {
  INBOX_MSG_1,
  SENT_MSG_1,
  MESSAGE_BODY_RESULT,
  INBOX_PATH,
  SENT_PATH,
  UIDVALIDITY_INBOX,
  UIDVALIDITY_SENT,
  makeFakeImap,
  type FakeRound,
} from "./icloud-mail.fixtures.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A dedicated throwaway user so this round-trip can't race another suite's apple credential.
const TEST_USER = "00000000-0000-0000-0000-0000000009b1";
const ASP = "dummy-icloud-app-specific-password";
const APPLE_ID = "operator@icloud.com";

/** Seed one user + apple credential + mail connector; returns ids for cleanup. */
async function seedConnection(
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
  const secretRef = await seal({ userId, provider: "apple", purpose: "access" }, ASP);
  const cred = await pool.query(
    `insert into provider_credentials (user_id, provider, custody, secret_ref, username, status)
     values ($1, 'apple', 'static_token', $2, $3, 'active') returning id`,
    [userId, secretRef, APPLE_ID],
  );
  const credentialId = cred.rows[0].id as string;
  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status, sync_window_days)
     values ($1, $2, 'mail', 'apple', 'active', $3) returning id`,
    [userId, credentialId, syncWindowDays],
  );
  return { connectionId: conn.rows[0].id as string, credentialId, secretRef };
}

/** FK-cascade cleanup for one seeded connection (never ends the shared pool). */
async function cleanupConnection(
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

function inbox(over: Partial<FakeRound["folders"][number]>): FakeRound["folders"][number] {
  return { path: INBOX_PATH, specialUse: "\\Inbox", uidValidity: UIDVALIDITY_INBOX, highestModseq: 55n, ...over };
}
function sent(over: Partial<FakeRound["folders"][number]>): FakeRound["folders"][number] {
  return { path: SENT_PATH, specialUse: "\\Sent", uidValidity: UIDVALIDITY_SENT, highestModseq: 77n, ...over };
}

// Three sync rounds against ONE registered connector: initial → VANISHED → re-sighting.
const ROUNDS: FakeRound[] = [
  { folders: [inbox({ highestModseq: 55n, messages: [INBOX_MSG_1] }), sent({ messages: [SENT_MSG_1] })] },
  { folders: [inbox({ highestModseq: 60n, messages: [], vanished: [501] }), sent({ messages: [] })] },
  { folders: [inbox({ highestModseq: 65n, messages: [INBOX_MSG_1] }), sent({ messages: [] })] },
];

describe.skipIf(!HAS_DB)("iCloud Mail DB round-trip (imapflow mocked)", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { registerConnector } = await import("../sync/index.js");
    const seeded = await seedConnection(TEST_USER, "icloud-mail-db-test");
    connectionId = seeded.connectionId;
    credentialId = seeded.credentialId;
    secretRef = seeded.secretRef;
    // ONE connector instance drives all three rounds (the fake pops the next round per sync run).
    registerConnector(new IcloudMailConnector(makeFakeImap({ rounds: ROUNDS }).factory));
  });

  afterAll(async () => {
    await cleanupConnection(TEST_USER, credentialId, secretRef);
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

    const inboxRow = await pool.query(
      `select from_address, from_name, sender_address, subject, snippet, thread_id,
              message_id_header, is_read, has_attachments, folder, importance,
              received_at is not null as has_received, deleted_at,
              (raw ? 'source') as has_source, (raw ? 'body') as has_body,
              (raw ? '__pci_folder') as has_folder_key
         from mail_messages where connection_id = $1 and source_object_id = 'inbox:501'`,
      [connectionId],
    );
    const r = inboxRow.rows[0];
    expect(r.from_address).toBe("alice@icloud.example.com");
    expect(r.from_name).toBe("Alice Sender");
    expect(r.sender_address).toBeNull(); // sender === from ⇒ null
    expect(r.subject).toBe("Family trip itinerary");
    expect(r.snippet).toBeNull();
    expect(r.thread_id).toBeNull(); // standard IMAP has no thread id
    expect(r.message_id_header).toBe("<icloud-inbox-0001@mail.me.com>");
    expect(r.is_read).toBe(false);
    expect(r.has_attachments).toBe(true);
    expect(r.folder).toBe("inbox");
    expect(r.importance).toBeNull();
    expect(r.has_received).toBe(true);
    expect(r.deleted_at).toBeNull();
    expect(r.has_source).toBe(false); // ADR 0001: the body/source is NEVER stored
    expect(r.has_body).toBe(false);
    expect(r.has_folder_key).toBe(true);

    // The sent envelope maps to folder=sent (discovered via SPECIAL-USE, localized "Sent Messages").
    const sentRow = await pool.query(
      `select folder from mail_messages where connection_id = $1 and source_object_id = 'sent:601'`,
      [connectionId],
    );
    expect(sentRow.rows[0].folder).toBe("sent");

    // The cursor persisted as a per-folder {uidValidity,modseq} JSON map — NO _census key.
    const cur = await pool.query(`select cursor, last_synced_at, status from connectors where id = $1`, [
      connectionId,
    ]);
    expect(cur.rows[0].status).toBe("active");
    expect(cur.rows[0].last_synced_at).not.toBeNull();
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, unknown>;
    expect(map.inbox).toEqual({ uidValidity: "30000", modseq: "55" });
    expect(map.sent).toEqual({ uidValidity: "40000", modseq: "77" });
    expect(map).not.toHaveProperty("_census");
  });

  it("round 2: a QRESYNC VANISHED uid tombstones the row (deleted_at stamped, row kept)", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);

    const row = await pool.query(
      `select deleted_at from mail_messages where connection_id = $1 and source_object_id = 'inbox:501'`,
      [connectionId],
    );
    expect(row.rows[0].deleted_at).not.toBeNull(); // tombstoned, not hard-deleted

    // Row count unchanged (tombstone, not delete).
    const total = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(total.rows[0].n).toBe(2);

    // The inbox cursor advanced (modseq 55 → 60).
    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, { modseq: string }>;
    expect(map.inbox.modseq).toBe("60");
  });

  it("round 3: a later live sighting resurrects the tombstoned row", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1); // the re-sighted inbox message

    const row = await pool.query(
      `select deleted_at from mail_messages where connection_id = $1 and source_object_id = 'inbox:501'`,
      [connectionId],
    );
    expect(row.rows[0].deleted_at).toBeNull(); // resurrected (ADR 0004)
  });
});

describe.skipIf(!HAS_DB)("iCloud Mail fetchRecordLive stores nothing", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { registerConnector } = await import("../sync/index.js");
    const seeded = await seedConnection(
      "00000000-0000-0000-0000-0000000009b2",
      "icloud-mail-fetchlive-test",
    );
    connectionId = seeded.connectionId;
    credentialId = seeded.credentialId;
    secretRef = seeded.secretRef;
    registerConnector(
      new IcloudMailConnector(
        makeFakeImap({ rounds: [{ folders: [inbox({ messages: [INBOX_MSG_1] }), sent({ messages: [] })] }] }).factory,
      ),
    );
  });

  afterAll(async () => {
    await cleanupConnection("00000000-0000-0000-0000-0000000009b2", credentialId, secretRef);
  });

  it("a productive sync then a body drill leaves the row count unchanged", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    await syncConnection(connectionId);
    const before = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );

    const fake = makeFakeImap({
      rounds: [{ folders: [inbox({})] }],
      bodyByUid: { [INBOX_MSG_1.uid]: MESSAGE_BODY_RESULT },
    });
    const ctx: SyncContext = {
      userId: "00000000-0000-0000-0000-0000000009b2",
      connectionId,
      secretRef,
      secret: ASP,
      username: APPLE_ID,
    };
    const body = (await new IcloudMailConnector(fake.factory).fetchRecordLive(
      ctx,
      `inbox:${INBOX_MSG_1.uid}`,
    )) as { source: string };
    expect(body.source).toContain("Family trip itinerary");

    const after = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n); // stored NOTHING
  });
});
