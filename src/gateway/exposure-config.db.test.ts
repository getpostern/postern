// The `gateway_exposure` singleton store over a real Postgres (gated on DATABASE_URL; disposable
// *_test DB only — see vitest.globalSetup.ts).
//
// Two properties, both of which a plausible "improvement" would break: exactly one gate address can
// exist, and the address is NEVER sealed. The second is stated as a test precisely so nobody later
// "hardens" this by putting a value that is already in a public certificate ledger into the vault —
// that buys no secrecy and makes the address unreadable at boot.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { pool } from "../db.js";
import { lockTestResource } from "../test-support/advisory-lock.js";
import { getExposure, setExposure, clearExposure } from "./exposure-config.js";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("gateway_exposure — the singleton store", () => {
  // `gateway_exposure` is a ONE-ROW table, and THREE db suites drive it (this one,
  // src/rest/exposure-routes.db.test.ts and src/mcp/oauth-bridge.exposure.db.test.ts). Under vitest's
  // parallel file execution their `delete`/`set` land in each other's cells, so hold the table for the
  // whole suite — the plaid_app/oauth_provider_apps idiom (#38, #115). Every contender must use the
  // SAME key or the mutex is decorative.
  let releaseLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseLock = await lockTestResource("gateway_exposure");
  }, 120_000);
  beforeEach(async () => {
    await pool.query(`delete from gateway_exposure where id = true`);
  });
  afterAll(async () => {
    await pool.query(`delete from gateway_exposure where id = true`);
    await releaseLock?.(); // only after the final cleanup — a waiting suite must see an empty table
  });

  it("only one gate address can exist", async () => {
    await setExposure("https://one.example");
    await setExposure("https://two.example");

    const res = await pool.query(`select public_url from gateway_exposure`);
    expect(res.rowCount).toBe(1);
    expect((res.rows[0] as { public_url: string }).public_url).toBe("https://two.example");
    expect((await getExposure())?.publicUrl).toBe("https://two.example");

    // …and clearing really removes it (the store is the whole state; there is no second flag).
    await clearExposure();
    expect(await getExposure()).toBeNull();
    expect((await pool.query(`select 1 from gateway_exposure`)).rowCount).toBe(0);
    await clearExposure(); // idempotent — a second clear is a no-op, not an error
  });

  it("the address is never treated as a secret", async () => {
    const before = (await pool.query(`select count(*)::int as n from secrets`)).rows[0] as {
      n: number;
    };

    await setExposure("https://gw.example.ts.net");

    const after = (await pool.query(`select count(*)::int as n from secrets`)).rows[0] as {
      n: number;
    };
    // Sealing the URL would add a vault row. It must not: a public URL goes into a public CT log by
    // construction, so there is nothing to protect and sealing it only breaks boot-time reads.
    expect(after.n).toBe(before.n);

    // The row holds the URL VERBATIM — not a ref, not a digest.
    const row = (await pool.query(`select public_url from gateway_exposure where id = true`))
      .rows[0] as { public_url: string };
    expect(row.public_url).toBe("https://gw.example.ts.net");
    expect((await getExposure())?.publicUrl).toBe("https://gw.example.ts.net");

    // And the table has no place to PUT a secret ref, so a later change cannot drift into one silently.
    const cols = (
      await pool.query(
        `select column_name from information_schema.columns where table_name = 'gateway_exposure'`,
      )
    ).rows as { column_name: string }[];
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(["consented_at", "created_at", "id", "public_url", "updated_at"]);
    expect(names.some((n) => n.includes("secret"))).toBe(false);
  });
});
