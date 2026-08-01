// Google connector DB round-trip — gated on DATABASE_URL so CI stays green when absent.
//
// Drives the generic runner (syncConnection) end-to-end for BOTH sectors of ONE google credential
// (sector calendar → calendar_events; sector contacts → contacts), with the Google APIs mocked,
// proving: (1) the full sync upserts events + people into their own tables (per-connection cursor =
// the syncToken; no cross-sector packing); the calendar event's attendees survive as a jsonb array
// in `raw` (NOT promoted to a scalar column); (2) a cancelled event / a deleted person tombstones the
// row (deleted_at stamped, row kept) per ADR 0004; (3) a later live re-sighting resurrects it.
//
// The credential is sealed with a dummy access token and NO refresh_ref, so resolveAccessToken opens
// it as-is (no token-endpoint call); only the Google endpoints are mocked.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { GoogleConnector } from "./google.js";
import {
  CAL_EVENT_1,
  CAL_EVENT_2,
  CAL_EVENT_1_CANCELLED,
  PERSON_1,
  PERSON_2,
  PERSON_1_DELETED,
  calEventsPage,
  peopleConnectionsPage,
} from "./google.fixtures.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A dedicated throwaway user so this round-trip can't race another suite's google credential
// (test files run in parallel; unique(user_id, provider) would otherwise contend).
const TEST_USER = "00000000-0000-0000-0000-0000000009c1";
const DUMMY_TOKEN = "dummy-google-access-token";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Stateful-by-syncToken router covering three rounds for BOTH sectors (routed by API host). */
function installRouter(): void {
  const calRoute = (url: string): Record<string, unknown> => {
    if (url.includes("syncToken=CAL_R1")) {
      return calEventsPage([CAL_EVENT_1_CANCELLED], { nextSyncToken: "CAL_R2" }); // round 2: tombstone
    }
    if (url.includes("syncToken=CAL_R2")) {
      return calEventsPage([CAL_EVENT_1], { nextSyncToken: "CAL_R3" }); // round 3: re-sighting
    }
    return calEventsPage([CAL_EVENT_1, CAL_EVENT_2], { nextSyncToken: "CAL_R1" }); // round 1: full
  };
  const peopleRoute = (url: string): Record<string, unknown> => {
    if (url.includes("syncToken=PPL_R1")) {
      return peopleConnectionsPage([PERSON_1_DELETED], { nextSyncToken: "PPL_R2" }); // round 2: tombstone
    }
    if (url.includes("syncToken=PPL_R2")) {
      return peopleConnectionsPage([PERSON_1], { nextSyncToken: "PPL_R3" }); // round 3: re-sighting
    }
    return peopleConnectionsPage([PERSON_1, PERSON_2], { nextSyncToken: "PPL_R1" }); // round 1: full
  };
  globalThis.fetch = vi.fn(async (url: string) => {
    const body = url.includes("/people/me/connections") ? peopleRoute(url) : calRoute(url);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe.skipIf(!HAS_DB)("Google DB round-trip (calendar + contacts; Google mocked)", () => {
  let calConnectionId: string;
  let contactsConnectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    const { registerConnector } = await import("../sync/index.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'google-db-test') on conflict (id) do nothing`,
      [TEST_USER],
    );

    // Seal a dummy access token; no refresh_ref → resolveAccessToken opens it as-is.
    secretRef = await seal({ userId: TEST_USER, provider: "google", purpose: "access" }, DUMMY_TOKEN);

    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status)
       values ($1, 'google', 'first_party', $2, 'active') returning id`,
      [TEST_USER, secretRef],
    );
    credentialId = cred.rows[0].id as string;

    // ONE credential fans out to TWO per-sector connections (ADR 0006). Each has its OWN cursor.
    const cal = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'calendar', 'google', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    calConnectionId = cal.rows[0].id as string;
    const contacts = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'contacts', 'google', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    contactsConnectionId = contacts.rows[0].id as string;

    registerConnector(new GoogleConnector());
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> calendar_events / contacts.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("round 1: full sync lands events + people in their own tables; attendees stored as jsonb; cursors persist", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    installRouter();

    const calRes = await syncConnection(calConnectionId);
    expect(calRes.ok).toBe(true);
    expect(calRes.upserted).toBe(2); // CAL_EVENT_1 + CAL_EVENT_2
    expect(calRes.deleted).toBe(0);

    const contactsRes = await syncConnection(contactsConnectionId);
    expect(contactsRes.ok).toBe(true);
    expect(contactsRes.upserted).toBe(2); // PERSON_1 + PERSON_2
    expect(contactsRes.deleted).toBe(0);

    const calCount = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1`,
      [calConnectionId],
    );
    expect(calCount.rows[0].n).toBe(2);
    const contactCount = await pool.query(
      `select count(*)::int as n from contacts where connection_id = $1`,
      [contactsConnectionId],
    );
    expect(contactCount.rows[0].n).toBe(2);

    // The calendar event: scalar columns mapped; attendees survive as a jsonb ARRAY in raw (NOT a scalar).
    const ev = await pool.query(
      `select summary, starts_at, start_tz, all_day, status, organizer_email, owner_response,
              is_recurring, html_link, deleted_at,
              jsonb_typeof(raw->'attendees') as attendees_type
         from calendar_events where connection_id = $1 and source_object_id = $2`,
      [calConnectionId, CAL_EVENT_1.id],
    );
    const e = ev.rows[0];
    expect(e.summary).toBe("Q3 planning");
    expect(e.start_tz).toBe("America/Los_Angeles");
    expect(e.all_day).toBe(false);
    expect(e.status).toBe("confirmed");
    expect(e.organizer_email).toBe("alice@contoso.example.com");
    expect(e.owner_response).toBe("accepted");
    expect(e.is_recurring).toBe(false);
    expect(e.html_link).toContain("evt-q3-planning-0001");
    expect(e.deleted_at).toBeNull();
    expect(e.attendees_type).toBe("array"); // stored as jsonb (within raw), not flattened to a scalar

    // The contact: primary email/phone selection + updated_at from the CONTACT source.
    const ct = await pool.query(
      `select display_name, primary_email, primary_phone, company, job_title,
              updated_at is not null as has_updated, deleted_at
         from contacts where connection_id = $1 and source_object_id = $2`,
      [contactsConnectionId, PERSON_1.resourceName],
    );
    const c = ct.rows[0];
    expect(c.display_name).toBe("Carol Friend");
    expect(c.primary_email).toBe("carol@partner.example.org");
    expect(c.primary_phone).toBe("+14155550101");
    expect(c.company).toBe("Partner Co");
    expect(c.job_title).toBe("Designer");
    expect(c.has_updated).toBe(true);
    expect(c.deleted_at).toBeNull();

    // Per-connection cursors = the syncTokens (no cross-sector packing).
    const calCur = await pool.query(`select cursor, status, last_synced_at from connectors where id = $1`, [
      calConnectionId,
    ]);
    expect(calCur.rows[0].cursor).toBe("CAL_R1");
    expect(calCur.rows[0].status).toBe("active");
    expect(calCur.rows[0].last_synced_at).not.toBeNull();
    const contactsCur = await pool.query(`select cursor from connectors where id = $1`, [
      contactsConnectionId,
    ]);
    expect(contactsCur.rows[0].cursor).toBe("PPL_R1");
  });

  it("round 2: a cancelled event + a deleted person tombstone their rows (deleted_at stamped, kept)", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    installRouter();

    const calRes = await syncConnection(calConnectionId);
    expect(calRes.ok).toBe(true);
    expect(calRes.deleted).toBe(1);
    const contactsRes = await syncConnection(contactsConnectionId);
    expect(contactsRes.ok).toBe(true);
    expect(contactsRes.deleted).toBe(1);

    const ev = await pool.query(
      `select deleted_at from calendar_events where connection_id = $1 and source_object_id = $2`,
      [calConnectionId, CAL_EVENT_1.id],
    );
    expect(ev.rows[0].deleted_at).not.toBeNull(); // tombstoned, not hard-deleted
    const ct = await pool.query(
      `select deleted_at from contacts where connection_id = $1 and source_object_id = $2`,
      [contactsConnectionId, PERSON_1.resourceName],
    );
    expect(ct.rows[0].deleted_at).not.toBeNull();

    // Row counts unchanged (tombstone, not delete).
    const calCount = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1`,
      [calConnectionId],
    );
    expect(calCount.rows[0].n).toBe(2);
    const contactCount = await pool.query(
      `select count(*)::int as n from contacts where connection_id = $1`,
      [contactsConnectionId],
    );
    expect(contactCount.rows[0].n).toBe(2);
  });

  it("round 3: a later live re-sighting resurrects both tombstoned rows", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    installRouter();

    const calRes = await syncConnection(calConnectionId);
    expect(calRes.ok).toBe(true);
    expect(calRes.upserted).toBe(1); // re-sighted CAL_EVENT_1
    const contactsRes = await syncConnection(contactsConnectionId);
    expect(contactsRes.ok).toBe(true);
    expect(contactsRes.upserted).toBe(1); // re-sighted PERSON_1

    const ev = await pool.query(
      `select deleted_at from calendar_events where connection_id = $1 and source_object_id = $2`,
      [calConnectionId, CAL_EVENT_1.id],
    );
    expect(ev.rows[0].deleted_at).toBeNull(); // resurrected (ADR 0004 #3)
    const ct = await pool.query(
      `select deleted_at from contacts where connection_id = $1 and source_object_id = $2`,
      [contactsConnectionId, PERSON_1.resourceName],
    );
    expect(ct.rows[0].deleted_at).toBeNull();
  });
});
