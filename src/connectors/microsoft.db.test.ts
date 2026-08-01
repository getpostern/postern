// Microsoft connector DB round-trip — gated on DATABASE_URL so CI stays green when absent.
//
// Drives the generic runner (syncConnection) end-to-end against mail_messages with Graph HTTP
// mocked, proving: (1) the per-folder delta lands ENVELOPE rows only — no body/attachment content
// in `raw`; folder well-known names map to the neutral enum; the folder→deltaLink cursor map
// persists; (2) a Graph `@removed` entry tombstones the row (deleted_at stamped, row kept) per
// ADR 0004; (3) a later live sighting resurrects it (deleted_at cleared); (4) fetchRecordLive serves
// the body on demand and stores NOTHING (row count/columns unchanged).
//
// The credential is sealed with a dummy access token and expires_at in the future + no refresh_ref,
// so resolveAccessToken opens it as-is (no token-endpoint call); only the Graph endpoints are mocked.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { SyncContext } from "./types.js";
import type { AuthContext } from "../auth/resolve.js";
import { MicrosoftConnector } from "./microsoft.js";
import {
  MSG_INBOX_1,
  MSG_SENT_1,
  REMOVED_INBOX_1,
  MSG_INBOX_1_READ_FLIP_PARTIAL,
  MSG_INBOX_1_READ,
  MSG_UNSEEN_READ_FLIP_PARTIAL,
  MSG_UNSEEN_FULL,
  MESSAGE_BODY_RESOURCE,
  deltaPageWithNext,
  deltaPageWithDelta,
  CAL_OCCURRENCE_1,
  CAL_EXCEPTION_1,
  CAL_ALLDAY_1,
  CAL_REMOVED_1,
  CAL_REMOVED_OUT_OF_WINDOW,
  calPageWithDelta,
  CONTACTS_FOLDER_ID,
  CONTACT_1,
  CONTACT_2,
  CONTACT_REMOVED_1,
  CONTACTS_PROBE_PAGE,
  contactPageWithDelta,
} from "./microsoft.fixtures.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A dedicated throwaway user so this round-trip can't race another suite's microsoft credential
// (test files run in parallel; unique(user_id, provider) would otherwise contend).
const TEST_USER = "00000000-0000-0000-0000-0000000007a1";
const DUMMY_TOKEN = "dummy-graph-access-token";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Stateful-by-URL Graph delta router covering three sync rounds (distinguished by $deltatoken). */
function installRouter(): void {
  const route = (url: string): Record<string, unknown> => {
    if (url.includes("/mailFolders/inbox/messages/delta")) {
      if (url.includes("$deltatoken=INBOX_R1")) {
        return deltaPageWithDelta("inbox", [REMOVED_INBOX_1], "INBOX_R2"); // round 2: tombstone
      }
      if (url.includes("$deltatoken=INBOX_R2")) {
        return deltaPageWithDelta("inbox", [MSG_INBOX_1], "INBOX_R3"); // round 3: re-sighting
      }
      return deltaPageWithDelta("inbox", [MSG_INBOX_1], "INBOX_R1"); // round 1: initial
    }
    if (url.includes("/mailFolders/sentitems/messages/delta")) {
      if (url.includes("$deltatoken=SENT_R1")) return deltaPageWithDelta("sentitems", [], "SENT_R2");
      if (url.includes("$deltatoken=SENT_R2")) return deltaPageWithDelta("sentitems", [], "SENT_R3");
      return deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_R1"); // round 1: initial
    }
    throw new Error(`unexpected url: ${url}`);
  };
  globalThis.fetch = vi.fn(async (url: string) =>
    new Response(JSON.stringify(route(url)), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
}

// A 410 GONE on the stored deltaLink must SELF-HEAL (fresh delta) — never wedge the connection in
// status='error'. Isolated connection/user so it can't contend with the round-sequence suite below.
// Declared FIRST so the round-sequence suite's afterAll (which owns pool.end()) runs LAST.
describe.skipIf(!HAS_DB)("Microsoft 410 resync recovery (Graph mocked)", () => {
  const RESYNC_USER = "00000000-0000-0000-0000-0000000007a2";
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'microsoft-410-test') on conflict (id) do nothing`,
      [RESYNC_USER],
    );
    secretRef = await seal({ userId: RESYNC_USER, provider: "microsoft", purpose: "access" }, DUMMY_TOKEN);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status, expires_at)
       values ($1, 'microsoft', 'first_party', $2, 'active', $3) returning id`,
      [RESYNC_USER, secretRef, new Date(Date.now() + 3_600_000)],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'mail', 'microsoft', 'active') returning id`,
      [RESYNC_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [RESYNC_USER]);
    // pool.end() is owned by the round-sequence suite's afterAll (same module, shared pool).
  });

  it("a 410 on the stored deltaLink self-heals: fresh delta, status stays active (no error)", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    // Round 1: a normal initial sync persists a folder→deltaLink cursor map.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        return new Response(JSON.stringify(deltaPageWithDelta("inbox", [MSG_INBOX_1], "INBOX_OLD")), {
          status: 200,
        });
      }
      if (url.includes("/mailFolders/sentitems/messages/delta")) {
        return new Response(JSON.stringify(deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_OLD")), {
          status: 200,
        });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const r1 = await syncConnection(connectionId);
    expect(r1.ok).toBe(true);

    // Round 2: the stored inbox deltaLink (INBOX_OLD) is expired → 410; the fresh delta recovers.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("$deltatoken=INBOX_OLD")) return new Response("gone", { status: 410 });
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        return new Response(JSON.stringify(deltaPageWithDelta("inbox", [MSG_INBOX_1], "INBOX_NEW")), {
          status: 200,
        });
      }
      if (url.includes("$deltatoken=SENT_OLD")) {
        return new Response(JSON.stringify(deltaPageWithDelta("sentitems", [], "SENT_NEW")), {
          status: 200,
        });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const r2 = await syncConnection(connectionId);
    expect(r2.ok).toBe(true); // recovered — did NOT wedge in status='error'

    const cur = await pool.query(`select cursor, status from connectors where id = $1`, [connectionId]);
    expect(cur.rows[0].status).toBe("active"); // the acceptance: no status='error'
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, string>;
    expect(map.inbox).toContain("$deltatoken=INBOX_NEW"); // fresh deltaLink
    expect(map.inbox).not.toContain("INBOX_OLD"); // expired one dropped
    // Wave 11c: cursors are now checkpointed per page on a RECORD (the resumable invariant). This
    // round's sentitems delta is RECORD-LESS (empty page), so it cannot carry a cursor and its
    // deltaLink does NOT advance this cycle — the documented record-less-page edge (a bounded, cheap
    // re-fetch next poll; cumulative delta means no mail is ever lost).
    expect(map.sentitems).toContain("$deltatoken=SENT_OLD");
  });
});

// Wave 11c: a large initial sync whose page 3 transiently 504s must RESUME from the
// incrementally-checkpointed cursor (not restart from zero) and read as 'syncing', then converge to
// 'active' on the next run with the full mailbox and no dupes. Isolated user; does NOT own pool.end()
// (the round-sequence suite below does), so declared BEFORE it.
describe.skipIf(!HAS_DB)("Microsoft large-mailbox 504 resume (Graph mocked)", () => {
  const RESUME_USER = "00000000-0000-0000-0000-0000000007a3";
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;
  // #43 B: the prior PCI_RETRY_5XX_BASE_MS, captured so the near-instant-backoff override is restored.
  let priorRetryBase: string | undefined;

  /**
   * Five one-message inbox pages (P1..P5) — distinct ids so 5 pages = 5 rows. These are COMPLETE
   * envelope representations (what Graph returns for a created/standard item): #138 re-reads any
   * delta entry that is not, so an abbreviated fixture here would silently exercise the re-read path
   * instead of the paging path this suite is about.
   */
  const PAGE_MSGS = [1, 2, 3, 4, 5].map((i) => ({
    id: `PAGE${i}-IMMUTABLE`,
    internetMessageId: `<page-${i}@contoso.example.com>`,
    conversationId: `PAGE${i}-CONV`,
    subject: `Page ${i} message`,
    bodyPreview: `body preview ${i}`,
    from: { emailAddress: { name: "Bulk", address: "bulk@contoso.example.com" } },
    receivedDateTime: `2026-06-0${i}T00:00:00Z`,
    sentDateTime: `2026-06-0${i}T00:00:00Z`,
    isRead: true,
    hasAttachments: false,
    importance: "normal",
  }));

  // Run 1: the inbox SKIP_2 page (page 3) 504s; run 2: it serves. A module-scoped flag flips it.
  let page3Serves = false;
  function fivePageRouter(url: string): Response {
    if (url.includes("/mailFolders/inbox/messages/delta")) {
      if (url.includes("$skiptoken=SKIP_4")) {
        return new Response(JSON.stringify(deltaPageWithDelta("inbox", [PAGE_MSGS[4]], "INBOX_FINAL")), { status: 200 });
      }
      if (url.includes("$skiptoken=SKIP_3")) {
        return new Response(JSON.stringify(deltaPageWithNext("inbox", [PAGE_MSGS[3]], "SKIP_4")), { status: 200 });
      }
      if (url.includes("$skiptoken=SKIP_2")) {
        if (!page3Serves) return new Response("gateway timeout", { status: 504 }); // page 3 fails (run 1)
        return new Response(JSON.stringify(deltaPageWithNext("inbox", [PAGE_MSGS[2]], "SKIP_3")), { status: 200 });
      }
      if (url.includes("$skiptoken=SKIP_1")) {
        return new Response(JSON.stringify(deltaPageWithNext("inbox", [PAGE_MSGS[1]], "SKIP_2")), { status: 200 });
      }
      return new Response(JSON.stringify(deltaPageWithNext("inbox", [PAGE_MSGS[0]], "SKIP_1")), { status: 200 }); // initial
    }
    if (url.includes("/mailFolders/sentitems/messages/delta")) {
      return new Response(JSON.stringify(deltaPageWithDelta("sentitems", [MSG_SENT_1], "SENT_FINAL")), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    // #43 B: idempotent setup — a prior run interrupted mid-504-resume (afterAll never ran) leaves
    // this describe's committed RESUME_USER rows orphaned, and test:db REUSES the *_test DB, so the
    // next insert would duplicate-key on provider_credentials_user_provider_no_item. Delete any stale
    // RESUME_USER rows first (connectors → provider_credentials → users, FK-safe; deleting connectors
    // cascades any committed mail_messages; secrets orphans are harmless) so the reused DB self-heals.
    await pool.query(`delete from connectors where user_id = $1`, [RESUME_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [RESUME_USER]);
    await pool.query(`delete from users where id = $1`, [RESUME_USER]);
    await pool.query(
      `insert into users (id, label) values ($1, 'microsoft-504-resume-test') on conflict (id) do nothing`,
      [RESUME_USER],
    );
    secretRef = await seal({ userId: RESUME_USER, provider: "microsoft", purpose: "access" }, DUMMY_TOKEN);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status, expires_at)
       values ($1, 'microsoft', 'first_party', $2, 'active', $3) returning id`,
      [RESUME_USER, secretRef, new Date(Date.now() + 3_600_000)],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'mail', 'microsoft', 'active') returning id`,
      [RESUME_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    // #43 B: restore the backoff-base env override so it never leaks to another describe/worker.
    if (priorRetryBase === undefined) delete process.env.PCI_RETRY_5XX_BASE_MS;
    else process.env.PCI_RETRY_5XX_BASE_MS = priorRetryBase;
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [RESUME_USER]);
    // pool.end() owned by the round-sequence suite (same module, shared pool).
  });

  it("run 1 commits pages 1-2 + the resume cursor + status='syncing'; run 2 resumes 3-5 → 'active', no dupes", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    globalThis.fetch = vi.fn(async (url: string) => fivePageRouter(url)) as unknown as typeof globalThis.fetch;

    // ── Run 1: page 3 504s through all retries → RetryableError → status='syncing'. The connector's
    //    bounded exponential backoff runs on REAL timers here — deliberately NOT vi.useFakeTimers.
    //    Faking setTimeout would ALSO fake the shared pg Pool's idleTimeoutMillis/connectionTimeoutMillis
    //    (both 10s, src/db.ts); a >10s fake jump then fires those mid-query → "Connection terminated due
    //    to connection timeout" while a real syncConnection is doing real pg IO — the #43 Contention-B
    //    flake, which bit hardest under full parallel load. Keeping real timers keeps pg's pool timers
    //    honest (root cause removed, not masked). To avoid a real ~15s wall-clock backoff (which also
    //    widens the interrupt window that could orphan this describe's rows), shrink the backoff base to
    //    1ms via the PCI_RETRY_5XX_BASE_MS seam (microsoft.ts backoff5xxMs; env unset → prod default) so
    //    the four real backoffs sum to ~15ms. Restored in afterAll.
    priorRetryBase = process.env.PCI_RETRY_5XX_BASE_MS;
    process.env.PCI_RETRY_5XX_BASE_MS = "1";
    page3Serves = false;
    // #99: the runner now classifies the RetryableError as transient and retries the WHOLE attempt
    // with a real jittered backoff (RETRY_BACKOFF_MS [1000,4000] ±25% = 3.75–6.25s of added sleep).
    // That alone pushed this test past vitest's 5000ms default ~40% of runs. Inject a no-op sleeper:
    // the retries still run for real (3 attempts, each re-loading the committed-through cursor and
    // re-hitting the 504), only the wall-clock wait between them is removed. This must NOT be
    // vi.useFakeTimers — see the note above about faking the shared pg Pool's timers.
    const r1 = await syncConnection(connectionId, { sleep: async () => {} });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/504/);

    // Pages 1-2 committed (2 inbox rows); sentitems never reached (inbox is first + it failed mid-folder).
    const inbox1 = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1 and folder = 'inbox'`,
      [connectionId],
    );
    expect(inbox1.rows[0].n).toBe(2);

    const c1 = await pool.query(
      `select cursor, status, last_synced_at, last_error from connectors where id = $1`,
      [connectionId],
    );
    expect(c1.rows[0].status).toBe("syncing"); // resumable, NOT a hard error
    expect(c1.rows[0].last_synced_at).toBeNull(); // stamped ONLY on full completion
    expect(c1.rows[0].last_error).toMatch(/504/); // reason still inspectable
    const map1 = JSON.parse(c1.rows[0].cursor) as Record<string, string>;
    expect(map1.inbox).toContain("$skiptoken=SKIP_2"); // the page-2 resume checkpoint
    expect(map1.sentitems).toBeUndefined(); // sentitems never started

    // ── Run 2: resumes from SKIP_2 → pages 3,4,5 + sentitems → status='active', full mailbox.
    page3Serves = true;
    const r2 = await syncConnection(connectionId);
    expect(r2.ok).toBe(true);
    expect(r2.upserted).toBe(4); // P3 + P4 + P5 + SENT_1 (P1/P2 NOT re-fetched)

    const inbox2 = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1 and folder = 'inbox'`,
      [connectionId],
    );
    expect(inbox2.rows[0].n).toBe(5); // all five inbox pages, no dupes
    const total = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(total.rows[0].n).toBe(6); // 5 inbox + 1 sent

    const c2 = await pool.query(
      `select cursor, status, last_synced_at from connectors where id = $1`,
      [connectionId],
    );
    expect(c2.rows[0].status).toBe("active"); // converged
    expect(c2.rows[0].last_synced_at).not.toBeNull(); // NOW stamped (full success)
    const map2 = JSON.parse(c2.rows[0].cursor) as Record<string, string>;
    expect(map2.inbox).toContain("$deltatoken=INBOX_FINAL");
    expect(map2.sentitems).toContain("$deltatoken=SENT_FINAL");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #26a — calendar sector DB round-trip. A fresh calendarView chain lands normalized rows AND
// window-sweeps a stale in-window row while leaving out-of-window history alive; the incremental
// round tombstones a real @removed and absorbs an out-of-window @removed id (0 rows, no error);
// the per-record drill stores nothing. Declared BEFORE the round-sequence suite (pool.end owner).
// ═══════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("Microsoft calendar DB round-trip (Graph mocked, #26a)", () => {
  const CAL_USER = "00000000-0000-0000-0000-0000000007a4";
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'microsoft-calendar-db-test') on conflict (id) do nothing`,
      [CAL_USER],
    );
    secretRef = await seal({ userId: CAL_USER, provider: "microsoft", purpose: "access" }, DUMMY_TOKEN);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status, expires_at)
       values ($1, 'microsoft', 'first_party', $2, 'active', $3) returning id`,
      [CAL_USER, secretRef, new Date(Date.now() + 3_600_000)],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'calendar', 'microsoft', 'active') returning id`,
      [CAL_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [CAL_USER]);
    // pool.end() owned by the round-sequence suite (same module, shared pool).
  });

  it("round 1: fresh chain lands normalized rows; the window sweep tombstones a stale IN-window row and spares an OUT-of-window one", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    // Pre-seed two STALE rows a dead chain left behind: one inside the ±365d window, one outside.
    await pool.query(
      `insert into calendar_events (connection_id, user_id, source_object_id, summary, starts_at, raw, ingested_at)
       values ($1, $2, 'STALE-IN-WINDOW', 'stale in-window', now(), '{}'::jsonb, now()),
              ($1, $2, 'STALE-OUT-OF-WINDOW', 'stale out-of-window', now() + interval '600 days', '{}'::jsonb, now())`,
      [connectionId, CAL_USER],
    );

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/me/calendarView/delta") && url.includes("startDateTime=")) {
        return new Response(
          JSON.stringify(calPageWithDelta([CAL_OCCURRENCE_1, CAL_EXCEPTION_1, CAL_ALLDAY_1], "CAL_R1")),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(3);

    // Normalized columns land per the spec table.
    const occ = await pool.query(
      `select summary, description, location, starts_at, ends_at, start_tz, all_day, status,
              organizer_email, owner_response, is_recurring, recurrence_master_id,
              original_start, original_start_tz, html_link, deleted_at,
              (raw ? 'attendees') as raw_has_attendees
         from calendar_events where connection_id = $1 and source_object_id = $2`,
      [connectionId, CAL_OCCURRENCE_1.id],
    );
    const r = occ.rows[0];
    expect(r.summary).toBe("Weekly sync");
    expect(r.location).toBe("Teams");
    expect(new Date(r.starts_at).toISOString()).toBe("2026-07-15T16:00:00.000Z");
    expect(new Date(r.ends_at).toISOString()).toBe("2026-07-15T16:30:00.000Z");
    expect(r.start_tz).toBe("Pacific Standard Time");
    expect(r.all_day).toBe(false);
    expect(r.status).toBe("confirmed");
    expect(r.organizer_email).toBe("alice@contoso.example.com");
    expect(r.owner_response).toBe("accepted");
    expect(r.is_recurring).toBe(true);
    expect(r.recurrence_master_id).toBe("AAMkAGI2-Cal-Master-0001");
    expect(r.original_start).toBeNull();
    expect(r.deleted_at).toBeNull();
    expect(r.raw_has_attendees).toBe(true); // attendee detail rides raw (never a queryable column)

    const allday = await pool.query(
      `select all_day, starts_at, ends_at from calendar_events where connection_id = $1 and source_object_id = $2`,
      [connectionId, CAL_ALLDAY_1.id],
    );
    expect(allday.rows[0].all_day).toBe(true);
    expect(new Date(allday.rows[0].ends_at).toISOString()).toBe("2026-07-21T00:00:00.000Z"); // exclusive end

    // The complete one-run fresh chain swept: stale IN-window tombstoned, OUT-of-window spared.
    const stale = await pool.query(
      `select source_object_id, deleted_at from calendar_events
        where connection_id = $1 and source_object_id like 'STALE-%' order by source_object_id`,
      [connectionId],
    );
    expect(stale.rows).toHaveLength(2);
    expect(stale.rows[0].source_object_id).toBe("STALE-IN-WINDOW");
    expect(stale.rows[0].deleted_at).not.toBeNull(); // swept (in-window, not in the enumeration)
    expect(stale.rows[1].source_object_id).toBe("STALE-OUT-OF-WINDOW");
    expect(stale.rows[1].deleted_at).toBeNull(); // outside [ws, we] — accumulated history survives

    // The {ws, we, link} cursor persisted; connection healthy.
    const cur = await pool.query(`select cursor, status from connectors where id = $1`, [connectionId]);
    expect(cur.rows[0].status).toBe("active");
    const map = JSON.parse(cur.rows[0].cursor) as { ws: string; we: string; link: string };
    expect(map.link).toContain("$deltatoken=CAL_R1");
    expect(Number.isFinite(Date.parse(map.ws))).toBe(true);
    expect(Number.isFinite(Date.parse(map.we))).toBe(true);
  });

  it("round 2: @removed tombstones the row; an OUT-OF-WINDOW @removed id tombstones 0 rows WITHOUT error; a resumed chain does not sweep", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("$deltatoken=CAL_R1")) {
        return new Response(
          JSON.stringify(calPageWithDelta([CAL_REMOVED_1, CAL_REMOVED_OUT_OF_WINDOW], "CAL_R2")),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true); // the unknown out-of-window id did NOT error the sync
    expect(res.deleted).toBe(1); // only the real row tombstoned; the noise matched 0 rows

    const occ = await pool.query(
      `select deleted_at from calendar_events where connection_id = $1 and source_object_id = $2`,
      [connectionId, CAL_OCCURRENCE_1.id],
    );
    expect(occ.rows[0].deleted_at).not.toBeNull();

    // No ghost row was inserted for the out-of-window id; siblings stay live.
    const ghost = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1 and source_object_id = $2`,
      [connectionId, CAL_REMOVED_OUT_OF_WINDOW.id],
    );
    expect(ghost.rows[0].n).toBe(0);
    const alive = await pool.query(
      `select count(*)::int as n from calendar_events
        where connection_id = $1 and deleted_at is null and source_object_id in ($2, $3)`,
      [connectionId, CAL_EXCEPTION_1.id, CAL_ALLDAY_1.id],
    );
    expect(alive.rows[0].n).toBe(2);
  });

  it("fetchRecordLive (calendar drill) serves the event live and stores NOTHING", async () => {
    const { pool } = await import("../db.js");
    const before = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1`,
      [connectionId],
    );
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(CAL_OCCURRENCE_1), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const ctx: SyncContext = { userId: CAL_USER, connectionId, secretRef, secret: DUMMY_TOKEN, sector: "calendar" };
    const out = (await new MicrosoftConnector().fetchRecordLive(ctx, CAL_OCCURRENCE_1.id)) as { id: string };
    expect(out.id).toBe(CAL_OCCURRENCE_1.id);
    const urlArg = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];
    expect(urlArg).toContain(`/me/events/${encodeURIComponent(CAL_OCCURRENCE_1.id)}`);

    const after = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1`,
      [connectionId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #26a — contacts sector DB round-trip: probe → folder-scoped delta → normalized rows +
// full-folder fresh-chain sweep; the incremental round tombstones an @removed contact.
// ═══════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("Microsoft contacts DB round-trip (Graph mocked, #26a)", () => {
  const CT_USER = "00000000-0000-0000-0000-0000000007a5";
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'microsoft-contacts-db-test') on conflict (id) do nothing`,
      [CT_USER],
    );
    secretRef = await seal({ userId: CT_USER, provider: "microsoft", purpose: "access" }, DUMMY_TOKEN);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status, expires_at)
       values ($1, 'microsoft', 'first_party', $2, 'active', $3) returning id`,
      [CT_USER, secretRef, new Date(Date.now() + 3_600_000)],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'contacts', 'microsoft', 'active') returning id`,
      [CT_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [CT_USER]);
    // pool.end() owned by the round-sequence suite (same module, shared pool).
  });

  it("round 1: probe + fresh chain land normalized rows (best-effort E.164) and sweep a stale row from the whole folder", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    // A stale contact the folder no longer contains — the complete fresh chain must tombstone it.
    await pool.query(
      `insert into contacts (connection_id, user_id, source_object_id, display_name, updated_at, raw, ingested_at)
       values ($1, $2, 'STALE-CONTACT', 'Gone Person', now(), '{}'::jsonb, now())`,
      [connectionId, CT_USER],
    );

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/me/contacts?")) {
        return new Response(JSON.stringify(CONTACTS_PROBE_PAGE), { status: 200 });
      }
      if (url.includes(`/me/contactFolders/${CONTACTS_FOLDER_ID}/contacts/delta`) && url.includes("$select=")) {
        return new Response(JSON.stringify(contactPageWithDelta([CONTACT_1, CONTACT_2], "CT_R1")), {
          status: 200,
        });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2);

    const c1 = await pool.query(
      `select display_name, given_name, family_name, primary_email, primary_phone, company, job_title,
              updated_at is not null as has_updated, deleted_at
         from contacts where connection_id = $1 and source_object_id = $2`,
      [connectionId, CONTACT_1.id],
    );
    const r = c1.rows[0];
    expect(r.display_name).toBe("Carol Friend");
    expect(r.given_name).toBe("Carol");
    expect(r.family_name).toBe("Friend");
    expect(r.primary_email).toBe("carol@partner.example.org");
    expect(r.primary_phone).toBe("+14255550100"); // formatting stripped, leading + kept
    expect(r.company).toBe("Partner Org");
    expect(r.job_title).toBe("Head of Partnerships");
    expect(r.has_updated).toBe(true);
    expect(r.deleted_at).toBeNull();

    const c2 = await pool.query(
      `select primary_phone from contacts where connection_id = $1 and source_object_id = $2`,
      [connectionId, CONTACT_2.id],
    );
    expect(c2.rows[0].primary_phone).toBe("4255550199"); // businessPhones fallback, NO invented +

    // Full-folder fresh-chain sweep tombstoned the stale row.
    const stale = await pool.query(
      `select deleted_at from contacts where connection_id = $1 and source_object_id = 'STALE-CONTACT'`,
      [connectionId],
    );
    expect(stale.rows[0].deleted_at).not.toBeNull();

    // The {folderId, link} cursor persisted.
    const cur = await pool.query(`select cursor, status from connectors where id = $1`, [connectionId]);
    expect(cur.rows[0].status).toBe("active");
    const map = JSON.parse(cur.rows[0].cursor) as { folderId: string; link: string };
    expect(map.folderId).toBe(CONTACTS_FOLDER_ID);
    expect(map.link).toContain("$deltatoken=CT_R1");
  });

  it("round 2: the incremental delta's @removed tombstones the contact; the sibling stays live; NO probe on resume", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/me/contacts?")) throw new Error("must not re-probe on a stored cursor");
      if (url.includes("$deltatoken=CT_R1")) {
        return new Response(JSON.stringify(contactPageWithDelta([CONTACT_REMOVED_1], "CT_R2")), {
          status: 200,
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);

    const c1 = await pool.query(
      `select deleted_at from contacts where connection_id = $1 and source_object_id = $2`,
      [connectionId, CONTACT_1.id],
    );
    expect(c1.rows[0].deleted_at).not.toBeNull();
    const c2 = await pool.query(
      `select deleted_at from contacts where connection_id = $1 and source_object_id = $2`,
      [connectionId, CONTACT_2.id],
    );
    expect(c2.rows[0].deleted_at).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #26a — reconcileObjectSnapshot window scope against the REAL table: from/to bound the sweep;
// a bogus column throws (fail-closed) before any SQL.
// ═══════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("reconcileObjectSnapshot — window bounds (DB, #26a)", () => {
  const W_USER = "00000000-0000-0000-0000-0000000007a6";
  let connectionId: string;
  let credentialId: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'reconcile-window-db-test') on conflict (id) do nothing`,
      [W_USER],
    );
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'microsoft', 'first_party', 'active') returning id`,
      [W_USER],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'calendar', 'microsoft', 'active') returning id`,
      [W_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from users where id = $1`, [W_USER]);
    // pool.end() owned by the round-sequence suite (same module, shared pool).
  });

  it("tombstones ONLY stale rows whose window column lies in [from, to]; live + out-of-window rows survive", async () => {
    const { pool } = await import("../db.js");
    const { reconcileObjectSnapshot } = await import("../sync/runner.js");

    await pool.query(
      `insert into calendar_events (connection_id, user_id, source_object_id, summary, starts_at, raw, ingested_at)
       values ($1, $2, 'W-STALE-IN', 'in window, stale', now(), '{}'::jsonb, now()),
              ($1, $2, 'W-STALE-OUT', 'out of window, stale', now() + interval '400 days', '{}'::jsonb, now()),
              ($1, $2, 'W-LIVE-IN', 'in window, live', now(), '{}'::jsonb, now())`,
      [connectionId, W_USER],
    );

    const startedAt = new Date(Date.now() + 1000); // fence: all three seeds are older
    const from = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const to = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const swept = await reconcileObjectSnapshot(
      connectionId,
      "calendar",
      "calendar_event",
      new Set(["W-LIVE-IN"]),
      startedAt,
      { column: "starts_at", from, to },
    );
    expect(swept).toBe(1);

    const rows = await pool.query(
      `select source_object_id, deleted_at from calendar_events
        where connection_id = $1 order by source_object_id`,
      [connectionId],
    );
    const byId = Object.fromEntries(rows.rows.map((r: { source_object_id: string; deleted_at: unknown }) => [r.source_object_id, r.deleted_at]));
    expect(byId["W-STALE-IN"]).not.toBeNull(); // in window + stale → swept
    expect(byId["W-STALE-OUT"]).toBeNull(); // outside [from, to] → spared
    expect(byId["W-LIVE-IN"]).toBeNull(); // enumerated live → spared
  });

  it("a window column that is not a REGISTRY field throws (fail-closed) and sweeps nothing", async () => {
    const { pool } = await import("../db.js");
    const { reconcileObjectSnapshot } = await import("../sync/runner.js");
    await expect(
      reconcileObjectSnapshot(connectionId, "calendar", "calendar_event", new Set<string>(), new Date(), {
        column: "definitely_not_a_column",
        from: new Date(0),
        to: new Date(),
      }),
    ).rejects.toThrow(/unknown window column/);
    // Nothing was tombstoned by the failed call (W-STALE-OUT and W-LIVE-IN are still live).
    const live = await pool.query(
      `select count(*)::int as n from calendar_events where connection_id = $1 and deleted_at is null`,
      [connectionId],
    );
    expect(live.rows[0].n).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #138 — the STORE-level witnesses: a Graph delta UPDATE partial must never leave a content-hollow
// row in mail_messages. Both are mutation-tested against the connector's re-read (turn
// isCompleteEnvelope into `() => true` and both go red — the first loses the cached content, the
// second lands an empty row).
//
// Why the store, not the connector, is the right level: normalizeMail is TOTAL (absent → null) and
// the runner's buildUpsert puts EVERY non-key column in `do update set <col> = excluded.<col>`
// (src/sync/runner.ts), so it is the round trip through applyRecords that turns a partial into 14
// nulls. Isolated user; does NOT own pool.end() (the round-sequence suite below does).
// ═══════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("Microsoft delta partials never store hollow rows (#138)", () => {
  const HOLLOW_USER = "00000000-0000-0000-0000-0000000007a4";
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  /** Round 1 (full envelopes), then round 2 (whatever `round2` says), plus the by-id re-read. */
  function installPartialRouter(
    round2: ReadonlyArray<unknown>,
    byId: (id: string) => Response,
  ): void {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/me/messages/")) {
        const id = decodeURIComponent(
          url.slice(url.indexOf("/me/messages/") + "/me/messages/".length).split("?")[0],
        );
        return byId(id);
      }
      if (url.includes("/mailFolders/inbox/messages/delta")) {
        if (url.includes("$deltatoken=HOLLOW_R1")) {
          return new Response(JSON.stringify(deltaPageWithDelta("inbox", round2, "HOLLOW_R2")), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(deltaPageWithDelta("inbox", [MSG_INBOX_1], "HOLLOW_R1")), {
          status: 200,
        });
      }
      if (url.includes("/mailFolders/sentitems/messages/delta")) {
        if (url.includes("$deltatoken=HOLLOW_SENT_R1")) {
          return new Response(JSON.stringify(deltaPageWithDelta("sentitems", [], "HOLLOW_SENT_R2")), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify(deltaPageWithDelta("sentitems", [MSG_SENT_1], "HOLLOW_SENT_R1")),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof globalThis.fetch;
  }

  /** The exact live shape from #138: served, not deleted, and every content column null. */
  async function hollowCount(): Promise<number> {
    const { pool } = await import("../db.js");
    const res = await pool.query(
      `select count(*)::int as n from mail_messages
        where connection_id = $1 and deleted_at is null
          and subject is null and from_address is null and received_at is null
          and snippet is null and message_id_header is null and sent_at is null`,
      [connectionId],
    );
    return res.rows[0].n as number;
  }

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    // Idempotent setup: test:db REUSES pci_test, so a run interrupted before afterAll would
    // duplicate-key on provider_credentials_user_provider_no_item.
    await pool.query(`delete from connectors where user_id = $1`, [HOLLOW_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [HOLLOW_USER]);
    await pool.query(`delete from users where id = $1`, [HOLLOW_USER]);
    await pool.query(
      `insert into users (id, label) values ($1, 'microsoft-138-hollow-test') on conflict (id) do nothing`,
      [HOLLOW_USER],
    );
    secretRef = await seal({ userId: HOLLOW_USER, provider: "microsoft", purpose: "access" }, DUMMY_TOKEN);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status, expires_at)
       values ($1, 'microsoft', 'first_party', $2, 'active', $3) returning id`,
      [HOLLOW_USER, secretRef, new Date(Date.now() + 3_600_000)],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'mail', 'microsoft', 'active') returning id`,
      [HOLLOW_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [HOLLOW_USER]);
    // pool.end() owned by the round-sequence suite (same module, shared pool).
  });

  it("WITNESS 1: a {id,isRead} partial over a STORED FULL ROW keeps every content column", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    installPartialRouter(
      [MSG_INBOX_1_READ_FLIP_PARTIAL],
      () => new Response(JSON.stringify(MSG_INBOX_1_READ), { status: 200 }),
    );

    // Round 1: the full envelope lands.
    expect((await syncConnection(connectionId)).ok).toBe(true);
    const before = await pool.query(
      `select subject, from_address, from_name, snippet, received_at, sent_at, message_id_header,
              thread_id, has_attachments, importance, folder, is_read
         from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    expect(before.rows[0].subject).toBe(MSG_INBOX_1.subject);
    expect(before.rows[0].is_read).toBe(false);

    // Round 2: Graph reports the read-status flip as a PARTIAL.
    expect((await syncConnection(connectionId)).ok).toBe(true);

    const after = await pool.query(
      `select subject, from_address, from_name, snippet, received_at, sent_at, message_id_header,
              thread_id, has_attachments, importance, folder, is_read
         from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    // Nothing the cache faithfully held was erased…
    for (const col of [
      "subject",
      "from_address",
      "from_name",
      "snippet",
      "received_at",
      "sent_at",
      "message_id_header",
      "thread_id",
      "has_attachments",
      "importance",
      "folder",
    ]) {
      expect({ col, v: after.rows[0][col] }).toEqual({ col, v: before.rows[0][col] });
    }
    // …and the update the partial DID report was applied.
    expect(after.rows[0].is_read).toBe(true);
    expect(await hollowCount()).toBe(0);

    // `raw` is a real Graph message, so the Inspector renders content (the #138 blank-row symptom).
    const raw = await pool.query(
      `select raw from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    expect((raw.rows[0].raw as Record<string, unknown>).subject).toBe(MSG_INBOX_1.subject);
  });

  it("WITNESS 2: a partial for an UNSEEN message lands COMPLETE, never as empty mail", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    // Reset to a fresh chain so round 2 below is the partial round again.
    await pool.query(`update connectors set cursor = null where id = $1`, [connectionId]);
    installPartialRouter(
      [MSG_UNSEEN_READ_FLIP_PARTIAL],
      () => new Response(JSON.stringify(MSG_UNSEEN_FULL), { status: 200 }),
    );
    expect((await syncConnection(connectionId)).ok).toBe(true); // round 1
    expect((await syncConnection(connectionId)).ok).toBe(true); // round 2: the unseen partial

    const row = await pool.query(
      `select subject, from_address, snippet, received_at, message_id_header, is_read, folder
         from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_UNSEEN_FULL.id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].subject).toBe(MSG_UNSEEN_FULL.subject);
    expect(row.rows[0].from_address).toBe("renewals@vendor.example.net");
    expect(row.rows[0].snippet).toBe(MSG_UNSEEN_FULL.bodyPreview);
    expect(row.rows[0].received_at).not.toBeNull();
    expect(row.rows[0].is_read).toBe(true);
    expect(row.rows[0].folder).toBe("inbox");
    expect(await hollowCount()).toBe(0);
  });

  it("WITNESS 3: a partial whose message the SOURCE no longer has is tombstoned, not blanked", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    await pool.query(`update connectors set cursor = null where id = $1`, [connectionId]);
    installPartialRouter(
      [MSG_INBOX_1_READ_FLIP_PARTIAL],
      () => new Response("not found", { status: 404 }),
    );
    expect((await syncConnection(connectionId)).ok).toBe(true); // round 1: the full envelope
    expect((await syncConnection(connectionId)).ok).toBe(true); // round 2: partial → 404 → tombstone

    const row = await pool.query(
      `select subject, deleted_at from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    expect(row.rows[0].deleted_at).not.toBeNull(); // tombstoned (ADR 0004)
    expect(row.rows[0].subject).toBe(MSG_INBOX_1.subject); // …with its content INTACT, not blanked
    expect(await hollowCount()).toBe(0);
  });

  it("REPAIR: a cursor reset re-enumerates and refills a row that was left hollow", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());

    // Plant the exact pre-fix damage: a served row with every content column null. (This is what
    // the OLD code produced; the point of the test is that supported machinery repairs it.)
    await pool.query(
      `insert into mail_messages (connection_id, user_id, source_object_id, is_read, folder, raw, ingested_at, deleted_at)
       values ($1, $2, $3, true, 'inbox', $4, now(), null)
       on conflict (connection_id, source_object_id) do update
         set subject = null, from_address = null, from_name = null, sender_address = null,
             snippet = null, received_at = null, sent_at = null, message_id_header = null,
             thread_id = null, has_attachments = null, importance = null,
             is_read = true, folder = 'inbox', raw = excluded.raw, deleted_at = null`,
      [connectionId, HOLLOW_USER, MSG_INBOX_1.id, JSON.stringify(MSG_INBOX_1_READ_FLIP_PARTIAL)],
    );
    expect(await hollowCount()).toBe(1); // BEFORE

    // The supported repair: setSyncWindow clears connectors.cursor, so the next sync issues a FRESH
    // windowed delta whose entries are full standard representations.
    const { setSyncWindow } = await import("../core/lifecycle.js");
    const auth: AuthContext = {
      userId: HOLLOW_USER,
      agentId: "operator",
      grantedSectors: new Set(["mail"]),
    };
    await setSyncWindow(auth, connectionId, 36500);
    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    expect(cur.rows[0].cursor).toBeNull();

    installPartialRouter([], () => new Response("not found", { status: 404 }));
    expect((await syncConnection(connectionId)).ok).toBe(true);

    expect(await hollowCount()).toBe(0); // AFTER
    const row = await pool.query(
      `select subject, received_at from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    expect(row.rows[0].subject).toBe(MSG_INBOX_1.subject);
    expect(row.rows[0].received_at).not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("Microsoft DB round-trip (Graph mocked)", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'microsoft-db-test') on conflict (id) do nothing`,
      [TEST_USER],
    );

    // Seal a dummy access token; expires_at in the future + no refresh_ref → opened as-is.
    secretRef = await seal({ userId: TEST_USER, provider: "microsoft", purpose: "access" }, DUMMY_TOKEN);

    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status, expires_at)
       values ($1, 'microsoft', 'first_party', $2, 'active', $3) returning id`,
      [TEST_USER, secretRef, new Date(Date.now() + 3_600_000)],
    );
    credentialId = cred.rows[0].id as string;

    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'mail', 'microsoft', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> mail_messages.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("round 1: lands envelope rows only (no body), folder enums, cursor map persists", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new MicrosoftConnector());
    installRouter();

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2); // 1 inbox + 1 sent
    expect(res.deleted).toBe(0);

    const count = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(count.rows[0].n).toBe(2);

    // The inbox envelope: scalar columns mapped; raw carries NO body (envelope-only footprint).
    const inbox = await pool.query(
      `select from_address, from_name, sender_address, subject, snippet, thread_id,
              message_id_header, is_read, has_attachments, folder, importance,
              received_at is not null as has_received, deleted_at,
              (raw ? 'body') as has_body, (raw ? '__pci_folder') as has_folder_key
         from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    const r = inbox.rows[0];
    expect(r.from_address).toBe("alice@contoso.example.com");
    expect(r.from_name).toBe("Alice Sender");
    expect(r.sender_address).toBe("alice@contoso.example.com");
    expect(r.subject).toBe("Q3 planning agenda");
    expect(r.snippet).toContain("agenda");
    expect(r.thread_id).toBe("AAQkAGI2Conv0001");
    expect(r.message_id_header).toBe("<CY4PR01MB-inbox-0001@contoso.example.com>");
    expect(r.is_read).toBe(false);
    expect(r.has_attachments).toBe(true);
    expect(r.folder).toBe("inbox");
    expect(r.importance).toBe("high");
    expect(r.has_received).toBe(true);
    expect(r.deleted_at).toBeNull();
    expect(r.has_body).toBe(false); // ADR 0001: body is NEVER stored
    expect(r.has_folder_key).toBe(true); // synthetic folder thread (not a queryable column)

    // The sent envelope maps to folder=sent.
    const sent = await pool.query(
      `select folder from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_SENT_1.id],
    );
    expect(sent.rows[0].folder).toBe("sent");

    // The cursor persisted as a JSON folder→deltaLink map.
    const cur = await pool.query(`select cursor, last_synced_at, status from connectors where id = $1`, [
      connectionId,
    ]);
    expect(cur.rows[0].status).toBe("active");
    expect(cur.rows[0].last_synced_at).not.toBeNull();
    const map = JSON.parse(cur.rows[0].cursor) as Record<string, string>;
    expect(map.inbox).toContain("$deltatoken=INBOX_R1");
    expect(map.sentitems).toContain("$deltatoken=SENT_R1");
  });

  it("round 2: a Graph @removed entry tombstones the row (deleted_at stamped, row kept)", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    installRouter();

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);

    const row = await pool.query(
      `select deleted_at from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    expect(row.rows[0].deleted_at).not.toBeNull(); // tombstoned, not hard-deleted

    // Row count unchanged (tombstone, not delete); the sent message stays live.
    const total = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(total.rows[0].n).toBe(2);
  });

  it("round 3: a later live sighting resurrects the tombstoned row", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("../sync/index.js");
    installRouter();

    const res = await syncConnection(connectionId);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1); // the re-sighted inbox message

    const row = await pool.query(
      `select deleted_at from mail_messages where connection_id = $1 and source_object_id = $2`,
      [connectionId, MSG_INBOX_1.id],
    );
    expect(row.rows[0].deleted_at).toBeNull(); // resurrected (ADR 0004 #3)
  });

  it("fetchRecordLive serves the body on demand and stores NOTHING", async () => {
    const { pool } = await import("../db.js");

    const before = await pool.query(
      `select count(*)::int as n from mail_messages where connection_id = $1`,
      [connectionId],
    );

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(MESSAGE_BODY_RESOURCE), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const ctx: SyncContext = {
      userId: TEST_USER,
      connectionId,
      secretRef,
      secret: DUMMY_TOKEN,
    };
    const out = (await new MicrosoftConnector().fetchRecordLive(ctx, MSG_INBOX_1.id)) as {
      body: { content: string };
    };
    expect(out.body.content).toContain("agenda");

    // Nothing stored: the row count is unchanged, and the cached row still carries no body.
    const after = await pool.query(
      `select count(*)::int as n,
              bool_or(raw ? 'body') as any_body
         from mail_messages where connection_id = $1`,
      [connectionId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].any_body).toBe(false);
  });
});
