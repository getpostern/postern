// Apple / iCloud onboarding fan-out (#26) — DB round-trip. Gated on DATABASE_URL so CI stays green
// without Postgres. Proves the acceptance criteria for Child O:
//   - ONE `apple` static-token credential is created (custody='static_token', username=appleId).
//   - The app-specific password is SEALED at rest (row holds a `sec_` ref, opens under purpose
//     'access') and is NEVER echoed in the HTTP response (S1: secret-free response/logs).
//   - THREE connectors are created in one step — mail, calendar, contacts — provider 'apple', active.
//   - Re-running with a fresh ASP re-seals the SAME one-row credential (upsert) + keeps the 3 sectors.
//   - A blank/whitespace ASP is rejected (ValidationError → 400) and writes NO rows.
//
// #43 hygiene: every query is scoped to the seeded LOCAL_USER (no unscoped count(*)/global list) and
// the suite cleans up its own `apple` rows, so it never contends with other forks on shared tables.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./router.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";

// The db.ts pool singleton is shared across the file — end it exactly once, after everything.
afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

/** A capturing fake ServerResponse (mirrors admin.db.test.ts). */
function fakeRes() {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead(s: number, h?: Record<string, string>) {
      status = s;
      if (h) Object.assign(headers, h);
      this.headersSent = true;
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(payload?: string) {
      if (payload) body += payload;
      this.headersSent = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
}

function ctxFor() {
  const r = fakeRes();
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1:8787" };
  const ctx: RouteContext = {
    req,
    res: r.res,
    params: {},
    query: new URLSearchParams(""),
  };
  return { ctx, r };
}

/** Delete this suite's own Apple credential + its cascaded connectors (user-scoped). */
async function cleanupApple() {
  const { pool } = await import("../db.js");
  // connectors + secrets cascade off the credential; delete the credential last isn't required
  // because the FK is ON DELETE CASCADE, but we scrub connectors explicitly for clarity + then the
  // credential row (which cascades the connectors anyway).
  await pool.query(`delete from provider_credentials where provider = 'apple' and user_id = $1`, [LOCAL_USER]);
}

describe.skipIf(!HAS_DB)("Apple/iCloud onboarding fan-out (DB)", () => {
  beforeEach(cleanupApple);
  afterAll(cleanupApple);

  it("one ASP → 1 credential (sealed) + 3 connectors (mail/calendar/contacts); secret never echoed", async () => {
    const { pool } = await import("../db.js");
    const { postAppleOnboard } = await import("./admin.js");

    const APPLE_ID = "operator@icloud.com";
    // Apple presents the app-specific password grouped for display; the operator may paste it with
    // surrounding whitespace. The interior (including hyphens) is preserved verbatim.
    const ASP = "abcd-efgh-ijkl-mnop";
    const PASTED = `  ${ASP}  `;

    const { ctx, r } = ctxFor();
    await postAppleOnboard(ctx, { appleId: APPLE_ID, appSpecificPassword: PASTED });

    expect(r.status).toBe(201);
    const payload = JSON.parse(r.body);
    expect(payload.provider).toBe("apple");
    expect(typeof payload.credentialId).toBe("string");

    // The ASP is NEVER present anywhere in the response.
    expect(r.body).not.toContain(ASP);
    expect(payload.secret).toBeUndefined();

    // Exactly three connectors, one per sector, all active + provider 'apple'.
    expect(Array.isArray(payload.connectors)).toBe(true);
    const sectors = payload.connectors.map((c: { sector: string }) => c.sector).sort();
    expect(sectors).toEqual(["calendar", "contacts", "mail"]);
    for (const c of payload.connectors) {
      expect(c.status).toBe("active");
      expect(typeof c.connectionId).toBe("string");
    }

    // ── Credential row: static_token custody, appleId as username, a sealed sec_ ref ──
    const cred = await pool.query(
      `select custody, username, secret_ref, refresh_ref from provider_credentials
         where id = $1 and user_id = $2`,
      [payload.credentialId, LOCAL_USER],
    );
    expect(cred.rows[0].custody).toBe("static_token");
    expect(cred.rows[0].username).toBe(APPLE_ID);
    expect(cred.rows[0].secret_ref).toMatch(/^sec_/);
    expect(cred.rows[0].refresh_ref).toBeNull();

    // ── The sealed secret round-trips ONLY under purpose 'access' and is the whitespace-TRIMMED ASP ──
    const { open } = await import("../secrets/index.js");
    const opened = await open(cred.rows[0].secret_ref, {
      userId: LOCAL_USER,
      provider: "apple",
      purpose: "access",
    });
    expect(opened.toString("utf8")).toBe(ASP);
    expect(opened.toString("utf8")).not.toBe(PASTED);

    // ── Three connector rows in the DB, provider 'apple', bound to the one credential ──
    const conns = await pool.query(
      `select sector, provider, status from connectors
         where credential_id = $1 and user_id = $2 order by sector`,
      [payload.credentialId, LOCAL_USER],
    );
    expect(conns.rows).toEqual([
      { sector: "calendar", provider: "apple", status: "active" },
      { sector: "contacts", provider: "apple", status: "active" },
      { sector: "mail", provider: "apple", status: "active" },
    ]);
  });

  it("re-onboard with a fresh ASP → the SAME one-row credential (re-sealed), still 3 connectors", async () => {
    const { pool } = await import("../db.js");
    const { postAppleOnboard } = await import("./admin.js");

    const first = ctxFor();
    await postAppleOnboard(first.ctx, { appleId: "op@icloud.com", appSpecificPassword: "first-aaaa-bbbb-cccc" });
    const firstId = JSON.parse(first.r.body).credentialId as string;

    const second = ctxFor();
    await postAppleOnboard(second.ctx, { appleId: "op@icloud.com", appSpecificPassword: "second-dddd-eeee-ffff" });
    const secondId = JSON.parse(second.r.body).credentialId as string;

    // Upsert on (user, 'apple') → the same credential row, not a second one.
    expect(secondId).toBe(firstId);
    const count = await pool.query(
      `select count(*)::int as n from provider_credentials where provider = 'apple' and user_id = $1`,
      [LOCAL_USER],
    );
    expect(count.rows[0].n).toBe(1);

    // The freshest ASP is what's sealed now.
    const cred = await pool.query(`select secret_ref from provider_credentials where id = $1`, [firstId]);
    const { open } = await import("../secrets/index.js");
    const opened = await open(cred.rows[0].secret_ref, {
      userId: LOCAL_USER,
      provider: "apple",
      purpose: "access",
    });
    expect(opened.toString("utf8")).toBe("second-dddd-eeee-ffff");

    // Still exactly the three sectors.
    const conns = await pool.query(
      `select sector from connectors where credential_id = $1 and user_id = $2 order by sector`,
      [firstId, LOCAL_USER],
    );
    expect(conns.rows.map((r) => r.sector)).toEqual(["calendar", "contacts", "mail"]);
  });

  it("a blank/whitespace ASP is rejected (ValidationError → 400) and writes NO rows", async () => {
    const { pool } = await import("../db.js");
    const { postAppleOnboard } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");

    const { ctx } = ctxFor();
    await expect(
      postAppleOnboard(ctx, { appleId: "op@icloud.com", appSpecificPassword: "   " }),
    ).rejects.toBeInstanceOf(ValidationError);

    const rows = await pool.query(
      `select id from provider_credentials where provider = 'apple' and user_id = $1`,
      [LOCAL_USER],
    );
    expect(rows.rows.length).toBe(0);
  });

  it("a missing appleId is rejected (ValidationError → 400)", async () => {
    const { postAppleOnboard } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    const { ctx } = ctxFor();
    await expect(
      postAppleOnboard(ctx, { appSpecificPassword: "abcd-efgh-ijkl-mnop" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ── The end-to-end SEAM: onboard → 1 credential + 3 connectors → each row resolves via the registry
  //    to the ONE composite `apple` connector, which routes the row's sector to the correct
  //    sub-connector (mail→IcloudMail, calendar→IcloudCalendar, contacts→IcloudContacts). This mirrors
  //    the runner EXACTLY: getConnector(row.provider).sync({ sector: row.sector }).
  it("SEAM: each onboarded connector row resolves via the registry to the composite → correct sub-connector", async () => {
    const { pool } = await import("../db.js");
    const { postAppleOnboard } = await import("./admin.js");
    const { registerConnector, getConnector } = await import("../sync/registry.js");
    const { AppleConnector } = await import("../connectors/apple.js");
    const { IcloudMailConnector } = await import("../connectors/icloud-mail.js");
    const { IcloudCalendarConnector } = await import("../connectors/icloud-calendar.js");
    const { IcloudContactsConnector } = await import("../connectors/icloud-contacts.js");
    type Conn = import("../connectors/types.js").Connector;
    type Rec = import("../connectors/types.js").RawRecord;
    type Ctx = import("../connectors/types.js").SyncContext;

    // 1) Fan-out: exactly 1 credential + 3 connector rows.
    const { ctx, r } = ctxFor();
    await postAppleOnboard(ctx, { appleId: "op@icloud.com", appSpecificPassword: "aaaa-bbbb-cccc-dddd" });
    const payload = JSON.parse(r.body);
    const rows = (
      await pool.query(
        `select id, sector, provider from connectors where credential_id = $1 and user_id = $2 order by sector`,
        [payload.credentialId, LOCAL_USER],
      )
    ).rows as Array<{ id: string; sector: string; provider: string }>;
    expect(rows.map((x) => x.sector)).toEqual(["calendar", "contacts", "mail"]);
    expect(rows.every((x) => x.provider === "apple")).toBe(true);

    // 2) Register the composite with RECORDING sub-connectors, then resolve + sync EXACTLY as the runner
    //    does. Each sector must reach ONLY its own sub-connector (which yields its own record `object`).
    const seen: string[] = [];
    const stub = (object: string): Conn =>
      ({
        provider: "apple",
        sector: object,
        objectType: object,
        policy: { mode: "poll", supportsIncremental: true },
        actions: [],
        async *sync(c: Ctx) {
          seen.push(`${object}<-${c.sector}`);
          yield { object, externalId: `${object}-1`, raw: {} } as Rec;
        },
        normalize: () => ({}),
        strongKeys: () => ({}),
        execute: async () => {
          throw new Error("stub");
        },
      }) as Conn;
    registerConnector(
      new AppleConnector({ mail: stub("message"), calendar: stub("calendar_event"), contacts: stub("contact") }),
    );

    const wantObject: Record<string, string> = { mail: "message", calendar: "calendar_event", contacts: "contact" };
    for (const row of rows) {
      const conn = getConnector(row.provider);
      expect(conn).toBeInstanceOf(AppleConnector);
      for await (const out of conn!.sync({ userId: LOCAL_USER, connectionId: row.id, secretRef: null, sector: row.sector })) {
        expect(out.object).toBe(wantObject[row.sector]); // the sub for this sector produced its own object
      }
    }
    expect(seen.sort()).toEqual(["calendar_event<-calendar", "contact<-contacts", "message<-mail"]);

    // 3) The DEFAULT composite wires the three REAL sub-connector classes: normalize (pure) routes each
    //    record object to the exact output the standalone sub-connector produces.
    registerConnector(new AppleConnector());
    const real = getConnector("apple")!;
    expect(real).toBeInstanceOf(AppleConnector);

    const mailRec = { object: "message", externalId: "inbox:5", raw: { uid: 5, envelope: { messageId: "<m1>", subject: "Hi" }, flags: ["\\Seen"], internalDate: "2026-01-02T00:00:00.000Z", __pci_folder: "inbox" } } as Rec;
    const calRec = { object: "calendar_event", externalId: "uid1", raw: { source_object_id: "uid1", uid: "uid1", summary: "Meet", starts_at: "2026-01-01T00:00:00.000Z", all_day: false, is_recurring: false, attendees: [], ics: "" } } as Rec;
    const conRec = { object: "contact", externalId: "c1", raw: { source_object_id: "c1", uid: "c1", display_name: "Jane Doe", given_name: "Jane", family_name: "Doe", primary_email: "jane@x.com" } } as Rec;

    expect(real.normalize(mailRec)).toEqual(new IcloudMailConnector().normalize(mailRec));
    expect(real.normalize(calRec)).toEqual(new IcloudCalendarConnector().normalize(calRec));
    expect(real.normalize(conRec)).toEqual(new IcloudContactsConnector().normalize(conRec));
    // …and the three outputs are each the right sub-connector's own shape (no cross-wiring).
    expect(real.normalize(mailRec)).toMatchObject({ folder: "inbox", is_read: true });
    expect(real.normalize(calRec)).toMatchObject({ summary: "Meet", starts_at: "2026-01-01T00:00:00.000Z" });
    expect(real.normalize(conRec)).toMatchObject({ display_name: "Jane Doe", primary_email: "jane@x.com" });
  });
});
