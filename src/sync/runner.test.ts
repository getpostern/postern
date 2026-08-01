// Runner flow tests with a mocked pool + mocked vault. DB-free: every code path of syncConnection
// is exercised without Postgres by stubbing pool.query and secrets.open. Asserts the contract that
// the scheduler relies on: syncConnection NEVER throws, sets status='error' on failure, resolves the
// secret with purpose:'access', and hands plaintext to the connector via ctx.secret. Deletion
// records (ADR 0004) take the dedicated tombstone UPDATE — never normalize(), never the upsert.
// Wave 5: routes by the CONNECTION's sector and threads the CURRENT secretRef + sector + username
// into SyncContext.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Connector, RawRecord, SyncContext, SyncPolicy } from "../connectors/types.js";
import type { CredentialRef } from "../oauth/refresh.js";
import { RetryableError } from "./errors.js";
// The REAL #121 named-cause strings, imported from their throw sites (fix-round F3): a hand-copied
// literal here would stay green while the connectors drifted. Both connectors are inert at import
// (gmail's runner import resolves to THIS suite's mocked-db runner module).
import { API_DISABLED_MESSAGE } from "../connectors/google.js";
import { AUTH_REFUSED_MESSAGE } from "../connectors/gmail.js";

// ── mock the shared pool ──────────────────────────────────────────────────────
const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

// ── mock the vault open() ─────────────────────────────────────────────────────
const open = vi.fn();
vi.mock("../secrets/index.js", () => ({ open: (...a: unknown[]) => open(...a) }));

// ── mock the credential-resolution seam ───────────────────────────────────────
// Passthrough to the REAL resolveAccessToken by default (which sees the mocked pool + vault, so
// the static branch behaves exactly as before); the threading test overrides the return to prove
// the runner threads what it's GIVEN ({ token, secretRef }), not what it loaded at boot.
const resolveMock = vi.fn();
vi.mock("../oauth/refresh.js", () => ({
  resolveAccessToken: (...a: unknown[]) => resolveMock(...a),
}));
const realRefresh = await vi.importActual<typeof import("../oauth/refresh.js")>("../oauth/refresh.js");

// import AFTER the mocks are declared (vi.mock is hoisted, but be explicit).
const { syncConnection, resolveWindowDays, markStreamState, maskError, MAX_SYNC_ATTEMPTS, RETRY_BACKOFF_MS, RETRY_JITTER_FRACTION } =
  await import("./runner.js");
const { registerConnector } = await import("./registry.js");

const POLL: SyncPolicy = { mode: "poll", defaultIntervalSec: 3600, freshnessToleranceSec: 3600, supportsIncremental: true };
// Opt-in variant: a connector whose cursor is committed-through (Microsoft-like) — the runner may
// persist it mid-stream. The default POLL leaves cursorCommittedThrough absent (today's safe behaviour).
const POLL_COMMITTED: SyncPolicy = { ...POLL, cursorCommittedThrough: true };

const CONN = "11111111-1111-1111-1111-111111111111";
const USER = "00000000-0000-0000-0000-000000000001";
const CRED = "22222222-2222-2222-2222-222222222222";

interface FakeOpts {
  provider?: string;
  sector?: string;
  objectType?: string;
  records?: RawRecord[];
  syncThrows?: boolean;
  /** The message syncThrows throws (default "boom in sync") — the #121 pipe tests throw the
   *  connectors' real named-cause strings through the REAL classifier. */
  syncThrowsMessage?: string;
  normalizeFn?: (raw: RawRecord) => Record<string, unknown>;
  onCtx?: (ctx: SyncContext) => void;
  /** Opt in to mid-stream cursor checkpointing (policy.cursorCommittedThrough = true). Default false. */
  committedThrough?: boolean;
}

function fakeConnector(o: FakeOpts = {}): Connector {
  const records = o.records ?? [];
  return {
    provider: o.provider ?? "fakeprov",
    sector: o.sector ?? "finance",
    objectType: o.objectType ?? "transaction",
    policy: o.committedThrough ? POLL_COMMITTED : POLL,
    actions: [],
    async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
      o.onCtx?.(ctx);
      if (o.syncThrows) throw new Error(o.syncThrowsMessage ?? "boom in sync");
      for (const r of records) yield r;
    },
    normalize(raw: RawRecord): Record<string, unknown> {
      if (o.normalizeFn) return o.normalizeFn(raw);
      return { source_object_id: raw.externalId, amount: -1 };
    },
    strongKeys() {
      return {};
    },
    async execute() {
      return { ok: true };
    },
  };
}

/**
 * Make pool.query return the connection-load row first, then succeed for everything else.
 *
 * NOTE (#99): the in-run retry loop probes `select status from connectors where id = $1` before each
 * backoff. That SQL is NOT matched here, so it falls through to the catch-all `{ rows: [] }` — no
 * row, therefore not schedulable, therefore NO retry. Every pre-existing test in this file is
 * consequently single-attempt exactly as it was. The retry suite at the bottom mocks the probe
 * explicitly (mockRetryRow) rather than relying on that.
 */
function mockConnRow(opts: {
  provider: string;
  secretRef?: string | null;
  cursor?: string | null;
  lastSyncedAt?: Date | null;
  /** The CONNECTION's sector — what the runner must route + thread by (default 'finance'). */
  sector?: string;
  /** The credential's static identity (pc.username), threaded into ctx.username. */
  username?: string | null;
  /** The stored connectors.sync_window_days (wave 12a), threaded into ctx.windowDays for mail. */
  syncWindowDays?: number | null;
  /** rowCount the mocked pool reports for tombstone UPDATEs (default 1 = the row existed live). */
  tombstoneHits?: number;
}) {
  query.mockReset();
  query.mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("from connectors c")) {
      return Promise.resolve({
        rows: [
          {
            id: CONN,
            user_id: USER,
            provider: opts.provider,
            sector: opts.sector ?? "finance",
            cursor: opts.cursor ?? null,
            last_synced_at: opts.lastSyncedAt ?? null,
            credential_id: CRED,
            secret_ref: opts.secretRef ?? null,
            // OAuth-refresh columns: null for these static-path providers, so resolveAccessToken
            // takes its static branch (no refresh) exactly as the pre-refresh runner did.
            refresh_ref: null,
            expires_at: null,
            custody: "static_token",
            username: opts.username ?? null,
            sync_window_days: opts.syncWindowDays ?? null,
          },
        ],
      });
    }
    // tombstone UPDATEs report a rowCount (the runner counts only rowCount > 0 as applied)
    if (typeof sql === "string" && sql.includes("set deleted_at = now()")) {
      return Promise.resolve({ rows: [], rowCount: opts.tombstoneHits ?? 1 });
    }
    // upserts + update connectors + status flips
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  query.mockReset();
  open.mockReset();
  resolveMock.mockReset();
  // default: delegate to the REAL resolveAccessToken (static branch over the mocked pool/vault).
  resolveMock.mockImplementation((cred: unknown) => realRefresh.resolveAccessToken(cred as CredentialRef));
});

describe("syncConnection — error paths (no throw escapes)", () => {
  it("unknown connectionId -> { ok:false, error:'unknown connection' }, never throws", async () => {
    query.mockResolvedValue({ rows: [] }); // no connection row
    const res = await syncConnection("does-not-exist");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown connection");
  });

  it("unregistered provider -> { ok:false }, status flipped to 'error'", async () => {
    mockConnRow({ provider: "never-registered-provider" });
    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no connector registered");
    // a status='error' update must have been issued
    const flipped = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(flipped).toBe(true);
  });

  it("connector.sync that throws -> { ok:false } and connectors.status set to 'error'", async () => {
    registerConnector(fakeConnector({ provider: "throwprov", syncThrows: true }));
    mockConnRow({ provider: "throwprov" });
    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    const flipped = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(flipped).toBe(true);
  });

  it("unknown normalized column -> { ok:false } and no SQL with a bad identifier is run", async () => {
    // Table is resolved PER RECORD now: finance/transaction resolves, then the per-record column
    // validation rejects the unknown column BEFORE any SQL is built (the bad name never reaches SQL).
    registerConnector(
      fakeConnector({
        provider: "badcolprov",
        records: [{ externalId: "a", raw: {} }],
        normalizeFn: (r) => ({ source_object_id: r.externalId, not_a_real_column: 1 }),
      }),
    );
    mockConnRow({ provider: "badcolprov" });
    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    // the rejected column name must never reach a SQL string
    const leaked = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("not_a_real_column"),
    );
    expect(leaked).toBe(false);
  });

  it("write-surface pin (finance-dedup-trust-batch): a connector emitting shadowed_by_id/dedup_group_id fails the allow-list", async () => {
    // The dedup linkage columns are served READ-ONLY via query()'s includeShadowed projection but are
    // deliberately ABSENT from the REGISTRY fields list — which is ALSO applyRecords' write allow-list.
    // A connector that emits either column must fail exactly like any unknown column (a provider that
    // could write shadowed_by_id could pre-shadow its own rows and vanish them from the served view).
    for (const [provider, extra] of [
      ["shadowwriteprov", { shadowed_by_id: "33333333-3333-3333-3333-333333333333" }],
      ["groupwriteprov", { dedup_group_id: "44444444-4444-4444-4444-444444444444" }],
    ] as const) {
      registerConnector(
        fakeConnector({
          provider,
          records: [{ externalId: "a", raw: {} }],
          normalizeFn: (r) => ({ source_object_id: r.externalId, amount: -1, ...extra }),
        }),
      );
      mockConnRow({ provider });
      const res = await syncConnection(CONN);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("unknown column");
      // the rejected linkage column never reaches a SQL string (no insert/update was built with it)
      const leaked = query.mock.calls.some(
        ([sql]) => typeof sql === "string" && (sql.includes("shadowed_by_id") || sql.includes("dedup_group_id")),
      );
      expect(leaked).toBe(false);
    }
  });

  it("never throws even when the connection-load query itself rejects", async () => {
    query.mockRejectedValueOnce(new Error("db is down"));
    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("db is down");
  });
});

// ── #121: the named onboarding causes survive the pipe end-to-end ──────────────────────────────
//
// The connector names the cause; this pins the rest of the journey: the REAL classifier reads it
// TERMINAL (→ markError, status='error', the state the Console's NEEDS ATTENTION band and the
// post-connect first-sync report are driven by — never the quiet 'syncing'), and last_error stores
// the FULL remedy text unmangled through maskError. The Console renders `error.message` verbatim
// (apps/web/src/api/freshness.ts), so nothing downstream needs to change for the cause to show.
describe("syncConnection — the #121 named causes land in last_error intact, classified terminal", () => {
  const CAL_DISABLED_MSG = API_DISABLED_MESSAGE.calendar;
  const GMAIL_REFUSED_MSG = AUTH_REFUSED_MESSAGE;

  for (const [provider, message] of [
    ["google", CAL_DISABLED_MSG],
    ["gmail", GMAIL_REFUSED_MSG],
  ] as const) {
    it(`${provider}: the named message reaches last_error whole, via status='error' (never 'syncing')`, async () => {
      registerConnector(fakeConnector({ provider, syncThrows: true, syncThrowsMessage: message }));
      mockConnRow({ provider });
      const res = await syncConnection(CONN);
      expect(res.ok).toBe(false);

      // Terminal → markError: the loud state the Console offers Reconnect from.
      const flip = query.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
      );
      expect(flip).toBeTruthy();
      // markError's params are [connectionId, maskError(message)] — the remedy arrives WHOLE:
      // secret-free by construction, nothing redacted, under the 500-char cap.
      expect((flip![1] as string[])[1]).toBe(message);
      // …and never the quiet 'syncing' inversion (a terminal cause hidden behind a retry state).
      const syncing = query.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("status = 'syncing'"),
      );
      expect(syncing).toBe(false);
    });
  }

  it("maskError is the identity on both named messages (each fits the 500-char cap with nothing secret-shaped)", () => {
    for (const msg of [CAL_DISABLED_MSG, GMAIL_REFUSED_MSG]) {
      expect(msg.length).toBeLessThanOrEqual(500);
      expect(maskError(msg)).toBe(msg);
    }
  });
});

describe("syncConnection — secret resolution", () => {
  it("calls open() with { userId, provider, purpose:'access' } and hands plaintext to ctx.secret", async () => {
    let observed: string | null | undefined;
    registerConnector(
      fakeConnector({
        provider: "secretprov",
        records: [{ externalId: "x", raw: {}, cursor: "cur-1" }],
        onCtx: (ctx) => {
          observed = ctx.secret;
        },
      }),
    );
    open.mockResolvedValue(Buffer.from("the-plaintext-token", "utf8"));
    mockConnRow({ provider: "secretprov", secretRef: "sec_abc" });

    const res = await syncConnection(CONN);

    expect(res.ok).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("sec_abc", { userId: USER, provider: "secretprov", purpose: "access" });
    expect(observed).toBe("the-plaintext-token");
  });

  it("no secret_ref -> ctx.secret is null and open() is not called", async () => {
    let observed: string | null | undefined = "unset";
    registerConnector(
      fakeConnector({
        provider: "nosecretprov",
        records: [],
        onCtx: (ctx) => {
          observed = ctx.secret;
        },
      }),
    );
    mockConnRow({ provider: "nosecretprov", secretRef: null });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(observed).toBeNull();
  });
});

describe("syncConnection — per-record routing (multi-object)", () => {
  it("routes object:'account' and object:'transaction' to their respective finance tables", async () => {
    registerConnector(
      fakeConnector({
        provider: "multiobjprov",
        sector: "finance",
        objectType: "transaction",
        records: [
          { externalId: "acct-1", raw: {}, object: "account" },
          { externalId: "txn-1", raw: {}, object: "transaction" },
        ],
        normalizeFn: (r) => ({ source_object_id: r.externalId }),
      }),
    );
    mockConnRow({ provider: "multiobjprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2);

    const intoAccounts = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes('insert into "finance_accounts"'),
    );
    const intoTxns = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes('insert into "finance_transactions"'),
    );
    expect(intoAccounts).toBe(true);
    expect(intoTxns).toBe(true);
  });

  it("a record with no `object` falls back to connector.objectType (existing single-object behavior)", async () => {
    registerConnector(
      fakeConnector({
        provider: "fallbackobjprov",
        sector: "finance",
        objectType: "account",
        records: [{ externalId: "acct-9", raw: {} }], // no `object` -> connector.objectType = 'account'
        normalizeFn: (r) => ({ source_object_id: r.externalId }),
      }),
    );
    mockConnRow({ provider: "fallbackobjprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    const intoAccounts = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes('insert into "finance_accounts"'),
    );
    const intoTxns = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes('insert into "finance_transactions"'),
    );
    expect(intoAccounts).toBe(true);
    expect(intoTxns).toBe(false);
  });

  it("an unknown (sector, object) -> { ok:false } and connectors.status flipped to 'error'", async () => {
    registerConnector(
      fakeConnector({
        provider: "badrouteprov",
        sector: "finance",
        objectType: "transaction",
        records: [{ externalId: "x", raw: {}, object: "not_a_real_object" }],
        normalizeFn: (r) => ({ source_object_id: r.externalId }),
      }),
    );
    mockConnRow({ provider: "badrouteprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    const flipped = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(flipped).toBe(true);
  });
});

describe("syncConnection — deletion records (tombstones)", () => {
  it("a deletion record takes the dedicated UPDATE (parameterized), never normalize(), never an insert", async () => {
    registerConnector(
      fakeConnector({
        provider: "tombprov",
        records: [{ externalId: "gone-1", raw: { transaction_id: "gone-1" }, deleted: true, cursor: "c-del" }],
        normalizeFn: () => {
          throw new Error("normalize must NEVER be called for a deletion record");
        },
      }),
    );
    mockConnRow({ provider: "tombprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);
    expect(res.upserted).toBe(0);

    // The dedicated tombstone UPDATE ran against the REGISTRY-derived table, fully parameterized,
    // with the deleted_at-is-null guard (re-delivery keeps the original timestamp).
    const tomb = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("set deleted_at = now()"),
    );
    expect(tomb).toBeTruthy();
    expect((tomb as unknown[])[0]).toContain('update "finance_transactions"');
    expect((tomb as unknown[])[0]).toContain("connection_id = $1 and source_object_id = $2");
    expect((tomb as unknown[])[0]).toContain("deleted_at is null");
    expect((tomb as unknown[])[1]).toEqual([CONN, "gone-1"]);

    // Never the upsert path: no insert SQL means no ghost row can ever be created.
    const inserted = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("insert into"),
    );
    expect(inserted).toBe(false);
  });

  it("cursor advances when ONLY deletion records carry it", async () => {
    registerConnector(
      fakeConnector({
        provider: "tombcursorprov",
        records: [{ externalId: "gone-2", raw: {}, deleted: true, cursor: "c-del-only" }],
      }),
    );
    mockConnRow({ provider: "tombcursorprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.newCursor).toBe("c-del-only");
    const writeBack = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("update connectors set cursor"),
    );
    expect((writeBack as unknown[])[1]).toEqual([CONN, "c-del-only"]);
  });

  it("a no-op deletion (unknown / already-tombstoned id, rowCount 0) is NOT counted", async () => {
    registerConnector(
      fakeConnector({
        provider: "tombmissprov",
        records: [{ externalId: "never-seen", raw: {}, deleted: true }],
      }),
    );
    mockConnRow({ provider: "tombmissprov", tombstoneHits: 0 });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(0);
    expect(res.upserted).toBe(0);
  });

  it("a deletion record with an empty externalId -> { ok:false } (fail-closed), status flipped", async () => {
    registerConnector(
      fakeConnector({
        provider: "tombbadidprov",
        records: [{ externalId: "", raw: {}, deleted: true }],
      }),
    );
    mockConnRow({ provider: "tombbadidprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("deletion record missing externalId");
    const flipped = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(flipped).toBe(true);
  });

  it("mixed stream: upserted counts live records, deleted counts tombstones, separately", async () => {
    registerConnector(
      fakeConnector({
        provider: "tombmixprov",
        records: [
          { externalId: "live-1", raw: {}, cursor: "c1" },
          { externalId: "gone-3", raw: {}, deleted: true, cursor: "c2" },
          { externalId: "live-2", raw: {}, cursor: "c3" },
        ],
      }),
    );
    mockConnRow({ provider: "tombmixprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(2);
    expect(res.deleted).toBe(1);
    expect(res.newCursor).toBe("c3");
  });

  it("live upserts write deleted_at (null) so a tombstoned row the source re-presents resurrects", async () => {
    registerConnector(
      fakeConnector({
        provider: "resurrectprov",
        records: [{ externalId: "back-1", raw: {} }],
      }),
    );
    mockConnRow({ provider: "resurrectprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);

    const insert = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes('insert into "finance_transactions"'),
    );
    expect(insert).toBeTruthy();
    const [sql, values] = insert as [string, unknown[]];
    // deleted_at is in the column list AND in the on-conflict update set (the resurrect path)…
    expect(sql).toContain('"deleted_at"');
    expect(sql).toContain('"deleted_at" = excluded."deleted_at"');
    // …and its bound value is null.
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(", ");
    expect(values[cols.indexOf('"deleted_at"')]).toBeNull();
  });
});

describe("syncConnection — reserved 'union:' namespace rejection (#37)", () => {
  it("a live record whose NORMALIZED soid is 'union:'-prefixed -> { ok:false }, status='error', NO upsert SQL ran", async () => {
    // The externalId is clean — the guard must fire on the normalize()-derived soid (a poisoned raw
    // with a clean externalId would bypass an externalId-only check).
    registerConnector(
      fakeConnector({
        provider: "unionliveprov",
        records: [{ externalId: "clean-id", raw: {} }],
        normalizeFn: () => ({ source_object_id: "union:forged", amount: -1 }),
      }),
    );
    mockConnRow({ provider: "unionliveprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("reserved 'union:' namespace");
    const flipped = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(flipped).toBe(true);
    // No upsert SQL ever ran for the poisoned record — the forged synthetic never reaches the table.
    const inserted = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("insert into"),
    );
    expect(inserted).toBe(false);
  });

  it("a deletion record with a 'union:'-prefixed externalId -> { ok:false }, status='error', NO tombstone UPDATE ran", async () => {
    registerConnector(
      fakeConnector({
        provider: "uniondelprov",
        records: [{ externalId: "union:acct:forged", raw: {}, deleted: true }],
      }),
    );
    mockConnRow({ provider: "uniondelprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("reserved 'union:' namespace");
    const flipped = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(flipped).toBe(true);
    // The engine's synthetic winner was never tombstoned.
    const tombstoned = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("set deleted_at = now()"),
    );
    expect(tombstoned).toBe(false);
  });

  it("non-prefix soids ('unionx', 'xunion:') and a case-variant ('UNION:x' — exact-case, no folding) pass", async () => {
    registerConnector(
      fakeConnector({
        provider: "unionokprov",
        records: [
          { externalId: "unionx", raw: {} },
          { externalId: "xunion:", raw: {} },
          { externalId: "UNION:x", raw: {} }, // NOT sweep-exempt, no forgery value → not rejected
        ],
      }),
    );
    mockConnRow({ provider: "unionokprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(3);
  });
});

describe("syncConnection — happy path bookkeeping", () => {
  it("upserts each record, persists the last non-null cursor, returns ok", async () => {
    registerConnector(
      fakeConnector({
        provider: "happyprov",
        records: [
          { externalId: "a", raw: { i: 1 }, cursor: "c1" },
          { externalId: "b", raw: { i: 2 }, cursor: "c2" },
          { externalId: "c", raw: { i: 3 }, cursor: "c3" },
        ],
      }),
    );
    mockConnRow({ provider: "happyprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(3);
    expect(res.newCursor).toBe("c3");

    // the cycle-end write-back must pass the last cursor as a parameter (the incremental per-record
    // UPDATEs use a distinct `cursor = $2` shape; the success write-back uses `coalesce`).
    const writeBack = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("cursor = coalesce($2, cursor)"),
    );
    expect(writeBack).toBeTruthy();
    expect((writeBack as unknown[])[1]).toEqual([CONN, "c3"]);
  });
});

describe("syncConnection — incremental cursor checkpointing + retryable classification (wave 11c)", () => {
  it("OPT-IN (cursorCommittedThrough=true): persists connectors.cursor IMMEDIATELY per cursor-bearing record (targeted, parameterized UPDATE)", async () => {
    registerConnector(
      fakeConnector({
        provider: "incrcursorprov",
        committedThrough: true,
        records: [
          { externalId: "a", raw: {}, cursor: "c1" },
          { externalId: "b", raw: {}, cursor: "c2" },
        ],
      }),
    );
    mockConnRow({ provider: "incrcursorprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);

    // One immediate targeted UPDATE per cursor-bearing record, before the cycle-end write-back.
    const immediate = query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("update connectors set cursor = $2 where id = $1"),
    );
    expect(immediate.length).toBe(2);
    expect((immediate[0] as unknown[])[1]).toEqual([CONN, "c1"]);
    expect((immediate[1] as unknown[])[1]).toEqual([CONN, "c2"]);
  });

  it("OPT-IN (cursorCommittedThrough=true): a deletion record carrying a cursor ALSO triggers the immediate UPDATE", async () => {
    registerConnector(
      fakeConnector({
        provider: "incrdelprov",
        committedThrough: true,
        records: [{ externalId: "gone-1", raw: {}, deleted: true, cursor: "cd1" }],
      }),
    );
    mockConnRow({ provider: "incrdelprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    const immediate = query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("update connectors set cursor = $2 where id = $1"),
    );
    expect(immediate.length).toBe(1);
    expect((immediate[0] as unknown[])[1]).toEqual([CONN, "cd1"]);
  });

  // ── THE SAFETY GATE (the adversarial-review fix). A connector that does NOT declare its cursor
  // committed-through (the default — Plaid/SimpleFIN/Whoop) must NEVER persist a cursor mid-stream:
  // its cursor is written ONLY at cycle-end on success, exactly as before this wave. ──────────────
  it("DEFAULT (no flag): NO mid-stream UPDATE — cursor written ONLY at cycle-end on success", async () => {
    registerConnector(
      fakeConnector({
        provider: "noflagprov", // committedThrough absent → today's safe behaviour
        records: [
          { externalId: "a", raw: {}, cursor: "c1" },
          { externalId: "b", raw: {}, cursor: "c2" },
        ],
      }),
    );
    mockConnRow({ provider: "noflagprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);

    // No immediate per-record cursor UPDATE ever ran.
    const immediate = query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("update connectors set cursor = $2 where id = $1"),
    );
    expect(immediate.length).toBe(0);

    // The cursor is advanced ONLY by the cycle-end coalesce write-back, to the final cursor.
    const writeBack = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("cursor = coalesce($2, cursor)"),
    );
    expect(writeBack).toBeTruthy();
    expect((writeBack as unknown[])[1]).toEqual([CONN, "c2"]);
  });

  it("DEFAULT (no flag): a mid-stream upsert failure leaves connectors.cursor UNTOUCHED (no skip-on-resume)", async () => {
    // The data-loss hazard the adversarial review caught: a batch/window-END cursor on every record
    // + immediate persistence + a partial-batch failure would skip the uncommitted records on resume.
    // With no flag the runner must NOT have persisted any cursor before the failure, and the cycle-end
    // write-back never runs (the sync threw) → connectors.cursor stays at its PRIOR value.
    registerConnector(
      fakeConnector({
        provider: "midfailprov", // committedThrough absent
        records: [
          { externalId: "a", raw: {}, cursor: "batch-end" },
          { externalId: "b", raw: {}, cursor: "batch-end" }, // normalize throws here → mid-stream failure
        ],
        normalizeFn: (r) => {
          if (r.externalId === "b") throw new Error("upsert boom mid-stream");
          return { source_object_id: r.externalId, amount: -1 };
        },
      }),
    );
    mockConnRow({ provider: "midfailprov", cursor: "prior-cursor" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);

    // NO mid-stream cursor persistence happened — the prior cursor is never advanced past it.
    const immediate = query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("update connectors set cursor = $2 where id = $1"),
    );
    expect(immediate.length).toBe(0);
    // And the success write-back (which would coalesce a new cursor) never ran.
    const writeBack = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("cursor = coalesce($2, cursor)"),
    );
    expect(writeBack).toBe(false);
  });

  it("a connector emitting a cursor ONLY on its final record yields the same final cursor as before (no flag → cycle-end only)", async () => {
    registerConnector(
      fakeConnector({
        provider: "endcursorprov",
        records: [
          { externalId: "a", raw: {} },
          { externalId: "b", raw: {} },
          { externalId: "c", raw: {}, cursor: "final" },
        ],
      }),
    );
    mockConnRow({ provider: "endcursorprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.newCursor).toBe("final");
    // No flag → no immediate UPDATE …
    const immediate = query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("update connectors set cursor = $2 where id = $1"),
    );
    expect(immediate.length).toBe(0);
    // … the cycle-end coalesce write-back carries the final cursor.
    const writeBack = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("cursor = coalesce($2, cursor)"),
    );
    expect((writeBack as unknown[])[1]).toEqual([CONN, "final"]);
  });

  it("a RetryableError from sync -> status='syncing' (+last_error), NOT status='error', NO success write-back", async () => {
    registerConnector({
      ...fakeConnector({ provider: "retryprov" }),
      // eslint-disable-next-line require-yield
      async *sync(): AsyncIterable<RawRecord> {
        throw new RetryableError("microsoft: delta fetch returned 504");
      },
    });
    mockConnRow({ provider: "retryprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/504/);

    // status flipped to 'syncing' (resumable), recording the masked reason in last_error.
    const syncing = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'syncing'"),
    );
    expect(syncing).toBeTruthy();
    expect((syncing as unknown[])[0]).toContain("last_error = $2");
    expect((syncing as unknown[])[1]).toEqual([CONN, "microsoft: delta fetch returned 504"]);

    // NOT a hard error, and the success write-back (last_synced_at = now()) did NOT run.
    const errored = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(errored).toBe(false);
    const success = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("last_synced_at = now()"),
    );
    expect(success).toBe(false);
  });

  it("a plain Error stays terminal -> status='error' (NOT 'syncing')", async () => {
    registerConnector(fakeConnector({ provider: "terminalprov", syncThrows: true }));
    mockConnRow({ provider: "terminalprov" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(false);
    const errored = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'error'"),
    );
    expect(errored).toBe(true);
    const syncing = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'syncing'"),
    );
    expect(syncing).toBe(false);
  });
});

describe("syncConnection — wave-5 threading + multi-sector routing", () => {
  it("threads the resolved CURRENT secretRef (not the boot-loaded one), sector and username into SyncContext", async () => {
    const NEW_REF = "sec_rotated_after_refresh";
    let seen: SyncContext | undefined;
    registerConnector(
      fakeConnector({
        provider: "threadprov",
        records: [],
        onCtx: (ctx) => {
          seen = { ...ctx };
        },
      }),
    );
    mockConnRow({ provider: "threadprov", secretRef: "sec_stale_boot_ref", username: "operator@example.com" });
    // a refresh happened inside resolveAccessToken: the boot ref is retired, NEW_REF is current.
    resolveMock.mockResolvedValue({ token: "fresh-token", secretRef: NEW_REF });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);

    // the runner handed resolveAccessToken the full credential snapshot…
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).toHaveBeenCalledWith({
      credentialId: CRED,
      userId: USER,
      provider: "threadprov",
      secretRef: "sec_stale_boot_ref",
      refreshRef: null,
      expiresAt: null,
    });
    // …and ctx carries the CURRENT ref + token plus the connection's sector and the username.
    expect(seen?.secretRef).toBe(NEW_REF);
    expect(seen?.secret).toBe("fresh-token");
    expect(seen?.sector).toBe("finance");
    expect(seen?.username).toBe("operator@example.com");
  });

  it("a null pc.username threads through as ctx.username === null", async () => {
    let seen: SyncContext | undefined;
    registerConnector(
      fakeConnector({
        provider: "nousernameprov",
        records: [],
        onCtx: (ctx) => {
          seen = { ...ctx };
        },
      }),
    );
    mockConnRow({ provider: "nousernameprov", username: null });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(seen?.username).toBeNull();
  });

  it("routes records by the CONNECTION's sector, not the connector's static one", async () => {
    registerConnector(
      fakeConnector({
        provider: "crosssectorprov",
        sector: "health", // the connector's static sector — must NOT drive routing
        objectType: "transaction",
        records: [{ externalId: "t-1", raw: {} }],
        normalizeFn: (r) => ({ source_object_id: r.externalId }),
      }),
    );
    // the CONNECTION's row says 'finance' — tableForObject must receive THAT. (Routing by the
    // connector's 'health' would fail-closed: there is no health/transaction REGISTRY entry.)
    mockConnRow({ provider: "crosssectorprov", sector: "finance" });

    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1);
    const intoTxns = query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.includes('insert into "finance_transactions"'),
    );
    expect(intoTxns).toBe(true);
  });
});

describe("markStreamState — push-stream health write-back (#39)", () => {
  it("writes the three stream columns ONLY (never status), masks the error, and CASes stream_changed_at on the OLD state", async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });

    await markStreamState(CONN, "retrying", "refused https://user:pass@bridge.example/a?token=zzz");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    // status is NEVER touched — the pause/revoke resurrection guard holds by construction.
    expect(sql).not.toContain("status");
    // The transition-only stamp: compare-and-set against the row's CURRENT stream_state.
    expect(sql).toContain("stream_changed_at = case when stream_state is distinct from $2");
    expect(values[0]).toBe(CONN);
    expect(values[1]).toBe("retrying");
    expect(values[2]).toContain("//***@"); // userinfo masked
    expect(values[2]).toContain("token=***"); // secret query param masked
    expect(values[2]).not.toContain("user:pass");
  });

  it("'connected' with no reason nulls stream_error; a DB failure is swallowed (best-effort)", async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    await markStreamState(CONN, "connected");
    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values[1]).toBe("connected");
    expect(values[2]).toBeNull();

    query.mockRejectedValueOnce(new Error("db down"));
    await expect(markStreamState(CONN, "down", "x")).resolves.toBeUndefined(); // never throws
  });
});

describe("resolveWindowDays — mail recency window (wave 12a; sector-gated since #26a)", () => {
  it("mail-sector connections of mail providers default to 180 when sync_window_days is null", () => {
    expect(resolveWindowDays("microsoft", "mail", null)).toBe(180); // the #26a regression pin
    expect(resolveWindowDays("gmail", "mail", null)).toBe(180);
  });
  it("mail-sector connections honor an explicit stored window", () => {
    expect(resolveWindowDays("microsoft", "mail", 365)).toBe(365);
    expect(resolveWindowDays("gmail", "mail", 36500)).toBe(36500);
  });
  it("non-mail providers are always null (ignored), regardless of the stored value", () => {
    expect(resolveWindowDays("simplefin", "finance", null)).toBeNull();
    expect(resolveWindowDays("homeassistant", "home", 30)).toBeNull();
    expect(resolveWindowDays("whoop", "health", 180)).toBeNull();
  });
  it("NON-mail sectors of a mail provider are null — the ADR-0017 window must not leak into the microsoft calendar/contacts fan-out (#26a)", () => {
    expect(resolveWindowDays("microsoft", "calendar", null)).toBeNull();
    expect(resolveWindowDays("microsoft", "calendar", 90)).toBeNull();
    expect(resolveWindowDays("microsoft", "contacts", null)).toBeNull();
    expect(resolveWindowDays("microsoft", "contacts", 365)).toBeNull();
  });
});

describe("reconcileObjectSnapshot — optional window scope (#26a)", () => {
  it("throws on a window column that is not a REGISTRY field of the object's table (fail-closed, before any SQL)", async () => {
    query.mockClear();
    const { reconcileObjectSnapshot } = await import("./runner.js");
    await expect(
      reconcileObjectSnapshot(CONN, "calendar", "calendar_event", new Set<string>(), new Date(), {
        column: "no_such_column",
        from: new Date(0),
        to: new Date(),
      }),
    ).rejects.toThrow(/unknown window column 'no_such_column'/);
    expect(query).not.toHaveBeenCalled(); // validated BEFORE touching the pool
  });

  it("a valid window column adds parameterized bounds to the sweep WHERE clause", async () => {
    query.mockClear();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const { reconcileObjectSnapshot } = await import("./runner.js");
    const from = new Date("2025-07-11T00:00:00Z");
    const to = new Date("2027-07-11T00:00:00Z");
    await reconcileObjectSnapshot(CONN, "calendar", "calendar_event", new Set(["EV-1"]), new Date(), {
      column: "starts_at",
      from,
      to,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`"starts_at" >= $4`);
    expect(sql).toContain(`"starts_at" <= $5`);
    expect(params[3]).toBe(from);
    expect(params[4]).toBe(to);
  });

  it("without a window the sweep SQL is unchanged (3 params, no bounds clause)", async () => {
    query.mockClear();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const { reconcileObjectSnapshot } = await import("./runner.js");
    await reconcileObjectSnapshot(CONN, "calendar", "calendar_event", new Set<string>(), new Date());
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("$4");
    expect(params).toHaveLength(3);
  });
});

describe("syncConnection — threads sync_window_days into ctx.windowDays (wave 12a)", () => {
  it("a mail connector with a null window threads the 180-day default", async () => {
    let seen: SyncContext | undefined;
    registerConnector(
      fakeConnector({ provider: "microsoft", sector: "mail", records: [], onCtx: (c) => (seen = c) }),
    );
    mockConnRow({ provider: "microsoft", sector: "mail", syncWindowDays: null });
    const res = await syncConnection(CONN);
    expect(res.ok).toBe(true);
    expect(seen?.windowDays).toBe(180);
  });

  it("a mail connector threads an explicit stored window", async () => {
    let seen: SyncContext | undefined;
    registerConnector(
      fakeConnector({ provider: "gmail", sector: "mail", records: [], onCtx: (c) => (seen = c) }),
    );
    mockConnRow({ provider: "gmail", sector: "mail", syncWindowDays: 365 });
    await syncConnection(CONN);
    expect(seen?.windowDays).toBe(365);
  });

  it("a non-mail connector threads windowDays = null even with a stored value", async () => {
    let seen: SyncContext | undefined;
    registerConnector(
      fakeConnector({ provider: "nonmailprov", sector: "finance", records: [], onCtx: (c) => (seen = c) }),
    );
    mockConnRow({ provider: "nonmailprov", sector: "finance", syncWindowDays: 30 });
    await syncConnection(CONN);
    expect(seen?.windowDays).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// reconcileObjectSnapshot — the additive `window.resurrectPresent` option (gmail-recency-window
// BLOCK fold #2). Mocked-pool SQL-shape tests: the resurrect UPDATE runs BEFORE the tombstone
// UPDATE, is fully parameterized, excludes `union:%`, applies the window bounds, and the return
// value stays the TOMBSTONED count. Default (option absent) behavior is byte-shape unchanged.
// The real-row behavior (in-window resurrect / out-of-window stays / union:% never) is pinned
// against the REAL mail_messages table in src/connectors/gmail.db.test.ts.
// ─────────────────────────────────────────────────────────────────────────────────────

const { reconcileObjectSnapshot } = await import("./runner.js");

describe("reconcileObjectSnapshot — resurrectPresent (BLOCK fold #2)", () => {
  const FROM = new Date("2026-01-12T00:00:00.000Z");
  const TO = new Date("2026-07-11T00:00:00.000Z");
  const WINDOW = { column: "received_at", from: FROM, to: TO };
  const STARTED = new Date("2026-07-11T01:00:00.000Z");
  const LIVE = new Set(["inbox:1", "inbox:2"]);

  it("resurrectPresent:true → the resurrect UPDATE runs FIRST (parameterized, union-excluded, window-bounded), return = TOMBSTONED count", async () => {
    query.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("set deleted_at = null")) {
        return Promise.resolve({ rows: [], rowCount: 5 }); // 5 resurrected — must NOT be returned
      }
      return Promise.resolve({ rows: [], rowCount: 2 }); // 2 tombstoned — the return value
    });

    const n = await reconcileObjectSnapshot(CONN, "mail", "message", LIVE, STARTED, {
      ...WINDOW,
      resurrectPresent: true,
    });
    expect(n).toBe(2); // Promise<number> stays the tombstoned count

    expect(query).toHaveBeenCalledTimes(2);
    const [resSql, resParams] = query.mock.calls[0] as [string, unknown[]];
    const [tombSql, tombParams] = query.mock.calls[1] as [string, unknown[]];

    // The resurrect UPDATE: clears deleted_at on census-PRESENT tombstoned rows, in-window only,
    // never `union:%`; every value parameterized (no raw input in SQL).
    expect(resSql).toContain('update "mail_messages" set deleted_at = null');
    expect(resSql).toContain("deleted_at is not null");
    expect(resSql).toContain("source_object_id = any($2)");
    expect(resSql).toContain("source_object_id not like 'union:%'");
    expect(resSql).toContain('"received_at" >= $3 and "received_at" <= $4');
    expect(resParams).toEqual([CONN, ["inbox:1", "inbox:2"], FROM, TO]);

    // The tombstone UPDATE runs SECOND, exactly as before (window params ride $4/$5).
    expect(tombSql).toContain("set deleted_at = now()");
    expect(tombSql).toContain("ingested_at < $2");
    expect(tombParams).toEqual([CONN, STARTED, ["inbox:1", "inbox:2"], FROM, TO]);
  });

  it("window WITHOUT resurrectPresent → ONE query only (the tombstone UPDATE) — default behavior unchanged", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const n = await reconcileObjectSnapshot(CONN, "mail", "message", LIVE, STARTED, WINDOW);
    expect(n).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("set deleted_at = now()");
    expect(sql).not.toContain("deleted_at = null");
  });

  it("no window at all (existing callers) → ONE unwindowed tombstone UPDATE, 3 params", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const n = await reconcileObjectSnapshot(CONN, "finance", "holding", new Set(["h1"]), STARTED);
    expect(n).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("set deleted_at = now()");
    expect(sql).not.toContain(">= $4");
    expect(params).toEqual([CONN, STARTED, ["h1"]]);
  });

  it("an unknown window column throws BEFORE any SQL, resurrectPresent or not (fail-closed REGISTRY validation)", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(
      reconcileObjectSnapshot(CONN, "mail", "message", LIVE, STARTED, {
        column: "no_such_column; drop table users",
        from: FROM,
        to: TO,
        resurrectPresent: true,
      }),
    ).rejects.toThrow(/unknown window column/);
    expect(query).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #99 — sync error classification + the bounded in-run retry.
//
// The defect this closes: EVERY error that was not a RetryableError went straight to markError →
// status='error' → deriveFreshness 'error' → the Console rendered "needs you / Reconnect". Only
// microsoft ever threw RetryableError, so one 503 from Plaid/SimpleFIN/Whoop/Google flipped a
// healthy connection to "needs you" for a whole cadence (6h for finance).
//
// Every test here injects `sleep` (no real elapsed time) and mocks the `stillSchedulable` probe
// explicitly, so the attempt counts below are the real budget, not an accident of the mock.
// ═══════════════════════════════════════════════════════════════════════════════════

/** A connector whose sync() is counted; `throwFor(n)` decides what attempt n (1-based) throws. */
function countingConnector(o: {
  provider: string;
  /** Return something to throw on attempt n, or null to yield `records` instead. */
  throwFor: (attempt: number) => unknown;
  records?: RawRecord[];
  onCtx?: (ctx: SyncContext) => void;
}): { connector: Connector; calls: () => number } {
  let calls = 0;
  const connector: Connector = {
    provider: o.provider,
    sector: "finance",
    objectType: "transaction",
    policy: POLL,
    actions: [],
    async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
      calls++;
      o.onCtx?.(ctx);
      const boom = o.throwFor(calls);
      if (boom !== null && boom !== undefined) throw boom;
      for (const r of o.records ?? []) yield r;
    },
    normalize: (raw: RawRecord) => ({ source_object_id: raw.externalId, amount: -1 }),
    strongKeys: () => ({}),
    execute: async () => ({ ok: true }),
  };
  return { connector, calls: () => calls };
}

/**
 * Mock the pool for a retry run: the connection load serves `cursors` in order (last repeats), and
 * the stillSchedulable probe serves `probeStatuses` in order (last repeats, default 'active').
 */
function mockRetryRow(opts: {
  provider: string;
  cursors?: (string | null)[];
  probeStatuses?: string[];
  /** true = the probe finds NO row at all (the connection was disconnected mid-retry). */
  probeMissing?: boolean;
}): { loads: () => number; probes: () => number } {
  let loads = 0;
  let probes = 0;
  query.mockReset();
  query.mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("from connectors c")) {
      const cursors = opts.cursors ?? [null];
      const cursor = cursors[Math.min(loads, cursors.length - 1)] ?? null;
      loads++;
      return Promise.resolve({
        rows: [
          {
            id: CONN,
            user_id: USER,
            provider: opts.provider,
            sector: "finance",
            cursor,
            last_synced_at: null,
            credential_id: CRED,
            secret_ref: null,
            refresh_ref: null,
            expires_at: null,
            custody: "static_token",
            username: null,
            sync_window_days: null,
          },
        ],
      });
    }
    if (typeof sql === "string" && sql.startsWith("select status from connectors")) {
      probes++;
      if (opts.probeMissing) return Promise.resolve({ rows: [] });
      const statuses = opts.probeStatuses ?? ["active"];
      return Promise.resolve({ rows: [{ status: statuses[Math.min(probes - 1, statuses.length - 1)] }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return { loads: () => loads, probes: () => probes };
}

/** Every SQL string issued this run, for shape assertions. */
const sqlOf = (): string[] =>
  query.mock.calls.map(([sql]) => (typeof sql === "string" ? sql : "")).filter(Boolean);

describe("syncConnection — bounded in-run retry (#99)", () => {
  it("a transient failure is retried up to the attempt budget, then lands status='syncing'", async () => {
    const sleeps: number[] = [];
    const { connector, calls } = countingConnector({
      provider: "retry-503-prov",
      // The verbatim whoop status shape (whoop.ts:265) — a 503 is transient.
      throwFor: () => new Error("whoop: /v1/cycle returned 503"),
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-503-prov" });

    const res = await syncConnection(CONN, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(calls()).toBe(3); // MAX_SYNC_ATTEMPTS exactly — not 1, not 4
    expect(calls()).toBe(MAX_SYNC_ATTEMPTS);
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("transient");
    expect(res.error).toBe("whoop: /v1/cycle returned 503");

    const syncing = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'syncing'"),
    );
    expect(syncing).toBeTruthy();
    expect((syncing as unknown[])[1]).toEqual([CONN, "whoop: /v1/cycle returned 503"]);
    // NEVER the hard error — that is the false "needs you" this unit removes.
    expect(sqlOf().some((s) => s.includes("status = 'error'"))).toBe(false);
  });

  it("a terminal failure is never retried", async () => {
    const sleeps: number[] = [];
    const { connector, calls } = countingConnector({
      provider: "retry-terminal-prov",
      // Verbatim plaid shape (plaid.ts:249) carrying the dead-item enum.
      throwFor: () => new Error("plaid transactions_sync failed: 400 ITEM_LOGIN_REQUIRED"),
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-terminal-prov" });

    const res = await syncConnection(CONN, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(calls()).toBe(1); // zero retries: a dead credential must reach Reconnect immediately
    expect(sleeps).toEqual([]);
    expect(res.errorClass).toBe("terminal");
    expect(sqlOf().some((s) => s.includes("status = 'error'"))).toBe(true);
    expect(sqlOf().some((s) => s.includes("status = 'syncing'"))).toBe(false);
  });

  it("a transient failure that succeeds on retry writes no error status at all", async () => {
    // THE HEADLINE FIX: the false "needs you" never appears, because no status write happens.
    const { connector, calls } = countingConnector({
      provider: "retry-recover-prov",
      throwFor: (n) => (n === 1 ? new Error("simplefin: account fetch returned 503") : null),
      records: [{ externalId: "recovered-1", raw: {}, cursor: "c-after-retry" }],
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-recover-prov" });

    const res = await syncConnection(CONN, { sleep: async () => {} });

    expect(calls()).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1);
    expect(res.newCursor).toBe("c-after-retry");
    expect(res.errorClass).toBeUndefined();
    expect(sqlOf().some((s) => s.includes("status = 'error'"))).toBe(false);
    expect(sqlOf().some((s) => s.includes("status = 'syncing'"))).toBe(false);
    // The success write-back DID run.
    expect(sqlOf().some((s) => s.includes("last_synced_at = now()"))).toBe(true);
  });

  it("the retry re-loads the connection row so a committed-through cursor is picked up", async () => {
    // A cursorCommittedThrough connector (Microsoft) persists its cursor MID-stream, so attempt 2
    // must resume from the committed checkpoint — not from the cursor attempt 1 was handed.
    const seen: (string | undefined)[] = [];
    const { connector, calls } = countingConnector({
      provider: "retry-cursor-prov",
      throwFor: (n) => (n < 3 ? new Error("microsoft: delta fetch returned 503") : null),
      onCtx: (ctx) => seen.push(ctx.cursor),
    });
    registerConnector(connector);
    const counters = mockRetryRow({
      provider: "retry-cursor-prov",
      cursors: ["cursor-load-1", "cursor-load-2", "cursor-load-3"],
    });

    const res = await syncConnection(CONN, { sleep: async () => {} });

    expect(res.ok).toBe(true);
    expect(calls()).toBe(3);
    expect(counters.loads()).toBe(3); // one connection load PER attempt, not hoisted out
    // The VALUES, not just the query count: each attempt saw the cursor its own load returned.
    expect(seen).toEqual(["cursor-load-1", "cursor-load-2", "cursor-load-3"]);
  });

  it("backoff is jittered and bounded", async () => {
    const sleeps: number[] = [];
    const { connector } = countingConnector({
      provider: "retry-backoff-prov",
      throwFor: () => new Error("google: calendar fetch returned 500"),
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-backoff-prov" });

    await syncConnection(CONN, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toHaveLength(MAX_SYNC_ATTEMPTS - 1); // exactly 2 — bounded, never a loop
    sleeps.forEach((ms, i) => {
      const base = RETRY_BACKOFF_MS[i];
      expect(ms).toBeGreaterThanOrEqual(base * (1 - RETRY_JITTER_FRACTION));
      expect(ms).toBeLessThanOrEqual(base * (1 + RETRY_JITTER_FRACTION));
    });
    // Drawn around DIFFERENT bases (1s then 4s) — a flat backoff would fail this.
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);

    // JITTER IS ACTUALLY APPLIED. A range assertion alone cannot catch its removal (the bare
    // constant sits inside the range), so drive a second run and require the draws to differ.
    const second: number[] = [];
    mockRetryRow({ provider: "retry-backoff-prov" });
    await syncConnection(CONN, {
      sleep: async (ms) => {
        second.push(ms);
      },
    });
    expect(second).toHaveLength(MAX_SYNC_ATTEMPTS - 1);
    expect(second).not.toEqual(sleeps);
    expect(sleeps.some((ms) => !RETRY_BACKOFF_MS.includes(ms))).toBe(true); // never the bare constant
  });

  it("a pause landing mid-retry aborts the remaining attempts", async () => {
    const sleeps: number[] = [];
    const { connector, calls } = countingConnector({
      provider: "retry-paused-prov",
      throwFor: () => new Error("whoop: /v1/cycle returned 503"),
    });
    registerConnector(connector);
    // The probe (which runs AFTER attempt 1 fails) reports the operator's pause.
    mockRetryRow({ provider: "retry-paused-prov", probeStatuses: ["paused"] });

    const res = await syncConnection(CONN, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(calls()).toBe(1); // the provider is not hammered for the rest of the budget
    expect(sleeps).toEqual([]); // aborted BEFORE the backoff
    expect(res.errorClass).toBe("transient");
    // …and the status write it does make still carries the pause/revoke resurrection guard, so the
    // paused row is never flipped back to 'syncing' (runner.ts:581).
    const syncing = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'syncing'"),
    );
    expect((syncing as unknown[])[0]).toContain("status not in ('paused', 'revoked')");
  });

  it("a connection row that vanished mid-retry aborts the remaining attempts too", async () => {
    const { connector, calls } = countingConnector({
      provider: "retry-gone-prov",
      throwFor: () => new Error("whoop: /v1/cycle returned 503"),
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-gone-prov", probeMissing: true });

    await syncConnection(CONN, { sleep: async () => {} });
    expect(calls()).toBe(1);
  });

  it("syncConnection still never throws", async () => {
    // A connector throwing a NON-Error: the classifier must not blow up inside the catch, because
    // the scheduler (scheduler.ts:179) fires this and never awaits a rejection.
    const { connector, calls } = countingConnector({
      provider: "retry-nonerror-prov",
      throwFor: () => "boom",
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-nonerror-prov" });

    const res = await syncConnection(CONN, { sleep: async () => {} });
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("terminal");
    expect(res.error).toBe("boom");
    expect(calls()).toBe(1);
  });

  it("an escape from the retry machinery itself still lands on the failure path, never throws", async () => {
    // The outer guard: if anything AROUND the attempt throws (here an injected sleep), syncConnection
    // must still return a SyncResult and write a status — the scheduler fires it unawaited.
    const { connector, calls } = countingConnector({
      provider: "retry-sleepboom-prov",
      throwFor: () => new Error("whoop: /v1/cycle returned 503"),
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-sleepboom-prov" });

    const res = await syncConnection(CONN, {
      sleep: async () => {
        throw new Error("timer exploded");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timer exploded");
    expect(res.errorClass).toBe("terminal"); // an unknown failure is terminal, and it IS recorded
    expect(calls()).toBe(1);
    expect(sqlOf().some((s) => s.includes("status = 'error'"))).toBe(true);
  });

  it("attempts is clamped to at least 1, and attempts:1 disables the retry entirely", async () => {
    const { connector, calls } = countingConnector({
      provider: "retry-clamp-prov",
      throwFor: () => new Error("whoop: /v1/cycle returned 503"),
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-clamp-prov" });

    await syncConnection(CONN, { attempts: 0, sleep: async () => {} });
    expect(calls()).toBe(1);

    await syncConnection(CONN, { attempts: 1, sleep: async () => {} });
    expect(calls()).toBe(2); // one more, i.e. still exactly one attempt per call
  });

  it("the provider is reported even when the failing attempt is not the first", async () => {
    const { connector } = countingConnector({
      provider: "retry-provider-prov",
      throwFor: () => new Error("google: request failed"),
    });
    registerConnector(connector);
    mockRetryRow({ provider: "retry-provider-prov" });

    const res = await syncConnection(CONN, { sleep: async () => {} });
    expect(res.provider).toBe("retry-provider-prov");
  });
});
