// iCloud contacts connector DB round-trip — gated on DATABASE_URL. Drives the REAL syncConnection
// against contacts with the DavTransport faked, proving: (1) a full sync parses vCard 3.0 → contact
// rows (display_name/email/phone/company); the per-book ctag + href→{etag,soid} cursor persists;
// (2) a vanished href tombstones its contact (ADR 0004); (3) a returning href resurrects it.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IcloudContactsConnector } from "./icloud-contacts.js";
import { CARD_BOOK, FakeCardTransport, fullVcard, type CardRound } from "./icloud-contacts.fixtures.js";
import type { DavEtag } from "./dav-core.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_USER = "00000000-0000-0000-0000-00000000cd01";
const APP_PASSWORD = "dummy-apple-asp";
const APPLE_ID = "me@icloud.com";

const hA = `${CARD_BOOK.url}a.vcf`;
const hB = `${CARD_BOOK.url}b.vcf`;
const etags = (arr: [string, string][]): DavEtag[] => arr.map(([href, etag]) => ({ href, etag }));

const ROUNDS: Array<Record<string, CardRound>> = [
  // round 0: two contacts.
  {
    [CARD_BOOK.url]: {
      ctag: "cc-1",
      etags: etags([
        [hA, "a1"],
        [hB, "b1"],
      ]),
      bodies: { [hA]: fullVcard("UID-A"), [hB]: fullVcard("UID-B") },
    },
  },
  // round 1: B vanishes (deletion), A's etag moves (re-fetched).
  { [CARD_BOOK.url]: { ctag: "cc-2", etags: etags([[hA, "a2"]]), bodies: { [hA]: fullVcard("UID-A") } } },
  // round 2: B returns (resurrect); A unchanged.
  {
    [CARD_BOOK.url]: {
      ctag: "cc-3",
      etags: etags([
        [hA, "a2"],
        [hB, "b2"],
      ]),
      bodies: { [hB]: fullVcard("UID-B") },
    },
  },
];

describe.skipIf(!HAS_DB)("iCloud contacts DB round-trip (DAV faked)", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    const { registerConnector } = await import("../sync/index.js");
    await pool.query(`insert into users (id, label) values ($1, 'icloud-contacts-db') on conflict (id) do nothing`, [
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
       values ($1, $2, 'contacts', 'apple', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;

    const transport = new FakeCardTransport([CARD_BOOK], ROUNDS);
    registerConnector(new IcloudContactsConnector(() => transport));
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("round 1: parses two vCards into contact rows; cursor persists", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2);

    const a = await pool.query(
      `select display_name, primary_email, primary_phone, company, job_title, deleted_at
         from contacts where connection_id = $1 and source_object_id = 'UID-A'`,
      [connectionId],
    );
    expect(a.rows[0].display_name).toBe("Jane Q Public");
    expect(a.rows[0].primary_email).toBe("jane@example.com");
    expect(a.rows[0].primary_phone).toBe("+14155550101");
    expect(a.rows[0].company).toBe("Acme");
    expect(a.rows[0].deleted_at).toBeNull();

    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    expect(cur.rows[0].cursor).toContain(CARD_BOOK.url);
  });

  it("round 2: a vanished href tombstones its contact (row kept)", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);

    const b = await pool.query(
      `select deleted_at from contacts where connection_id = $1 and source_object_id = 'UID-B'`,
      [connectionId],
    );
    expect(b.rows[0].deleted_at).not.toBeNull();
    const total = await pool.query(
      `select count(*)::int as n from contacts where connection_id = $1`,
      [connectionId],
    );
    expect(total.rows[0].n).toBe(2); // tombstoned, not hard-deleted
  });

  it("round 3: a returning href resurrects the contact", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1); // B re-fetched

    const b = await pool.query(
      `select deleted_at from contacts where connection_id = $1 and source_object_id = 'UID-B'`,
      [connectionId],
    );
    expect(b.rows[0].deleted_at).toBeNull();
  });
});
