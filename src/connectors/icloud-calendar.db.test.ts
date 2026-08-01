// iCloud calendar connector DB round-trip — gated on DATABASE_URL. Drives the REAL syncConnection
// against calendar_events with the DavTransport faked (no real iCloud), proving: (1) a full sync
// expands a recurring .ics into per-occurrence rows (attendees survive as jsonb in raw; is_recurring
// + recurrence_master_id set); the per-collection sync-token/ctag/hrefSoids cursor persists; (2) a
// 404-in-report tombstones every occurrence of that href (ADR 0004); (3) a later re-sighting
// resurrects them.
//
// The credential is a static_token custody sealed with a dummy ASP + the Apple ID username, so
// resolveAccessToken opens it as-is.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IcloudCalendarConnector } from "./icloud-calendar.js";
import {
  CAL_COLLECTION,
  FakeCalTransport,
  recurringIcs,
  type CalRound,
} from "./icloud-calendar.fixtures.js";
import type { DavObject } from "./dav-core.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_USER = "00000000-0000-0000-0000-00000000ca01";
const APP_PASSWORD = "dummy-apple-asp";
const APPLE_ID = "me@icloud.com";
const DAY = 24 * 60 * 60 * 1000;

const HREF = `${CAL_COLLECTION.url}rec.ics`;
const FIRST_START = new Date(Date.now() + 1 * DAY);
const obj = (etag: string): DavObject => ({ href: HREF, etag, body: recurringIcs("REC-DB-1", FIRST_START, 5) });

const ROUNDS: Array<Record<string, CalRound>> = [
  { [CAL_COLLECTION.url]: { changed: [obj("e1")], nextToken: "t1", ctag: "a" } }, // full
  { [CAL_COLLECTION.url]: { deletions: [HREF], nextToken: "t2", ctag: "b" } }, // removed href
  { [CAL_COLLECTION.url]: { changed: [obj("e2")], nextToken: "t3", ctag: "c" } }, // re-sighting
];

describe.skipIf(!HAS_DB)("iCloud calendar DB round-trip (DAV faked)", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    const { registerConnector } = await import("../sync/index.js");
    await pool.query(`insert into users (id, label) values ($1, 'icloud-cal-db') on conflict (id) do nothing`, [
      TEST_USER,
    ]);
    secretRef = await seal({ userId: TEST_USER, provider: "apple", purpose: "access" }, APP_PASSWORD);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, username, status)
       values ($1, 'apple', 'static_token', $2, $3, 'active') returning id`,
      [TEST_USER, secretRef, APPLE_ID],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'calendar', 'apple', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;

    // ONE shared fake transport across all rounds (discover() advances the round).
    const transport = new FakeCalTransport([CAL_COLLECTION], ROUNDS);
    registerConnector(new IcloudCalendarConnector(() => transport));
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("round 1: expands a recurring .ics into 5 occurrence rows; cursor persists", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(5);
    expect(res.deleted).toBe(0);

    const rows = await pool.query(
      `select count(*)::int as n,
              count(*) filter (where is_recurring) ::int as recurring,
              count(*) filter (where recurrence_master_id = 'REC-DB-1')::int as mastered
         from calendar_events where connection_id = $1 and deleted_at is null`,
      [connectionId],
    );
    expect(rows.rows[0].n).toBe(5);
    expect(rows.rows[0].recurring).toBe(5);
    expect(rows.rows[0].mastered).toBe(5);

    // attendees ride in raw (not a scalar column); starts_at populated.
    const one = await pool.query(
      `select starts_at, start_tz, summary, jsonb_typeof(raw->'attendees') as att_type
         from calendar_events where connection_id = $1 and deleted_at is null order by starts_at limit 1`,
      [connectionId],
    );
    expect(one.rows[0].starts_at).not.toBeNull();
    expect(one.rows[0].start_tz).toBe("America/New_York");
    expect(one.rows[0].att_type).toBe("array");

    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    expect(cur.rows[0].cursor).toContain(CAL_COLLECTION.url);
  });

  it("round 2: a removed href tombstones every occurrence (rows kept)", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(5);

    const live = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1 and deleted_at is null`,
      [connectionId],
    );
    expect(live.rows[0].n).toBe(0);
    const total = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1`,
      [connectionId],
    );
    expect(total.rows[0].n).toBe(5); // tombstoned, not hard-deleted
  });

  it("round 3: a re-sighting resurrects the occurrences", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(5);

    const live = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1 and deleted_at is null`,
      [connectionId],
    );
    expect(live.rows[0].n).toBe(5);
  });
});
