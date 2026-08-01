// The five backend seams the Console had been honestly degraded against, now on the wire (commit
// 8529bd3) — and the client-side contract each one needs in order not to become a NEW silent wrong
// answer. Each block names the defect it prevents, because every one of these is a shape where the
// wrong client code still runs, still typechecks (before this unit), and still renders a sentence.
//
// The wire facts are read from the routes, never guessed:
//   src/core/actions.ts        ActionCatalog { actions, count, truncated }
//   src/rest/admin.ts          AUDIT_HAS_MORE_HEADER / AUDIT_NEXT_HEADER, the tri-state grant PATCH
//   src/core/lifecycle.ts      ReconnectKind, served on every connector row
//   src/rest/finance-routes.ts orgDomain, the stored value VERBATIM

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import {
  AUDIT_HAS_MORE_HEADER,
  AUDIT_NEXT_HEADER,
  type ActionCatalog,
  type ConnectorStatus,
  type FinanceBankSummary,
} from "./types";

function stubFetch(status: number, body: unknown, headers?: Record<string, string>) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...(headers ?? {}) },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The URL of call n (0-based) on a stubbed fetch. */
function urlOf(fn: ReturnType<typeof stubFetch>, n = 0): string {
  return (fn.mock.calls[n] as unknown as [string])[0];
}

/** The serialized request body of call n, EXACTLY as it goes on the wire (not re-parsed): the
 *  absent-vs-null distinction below only exists in the raw JSON. */
function rawBodyOf(fn: ReturnType<typeof stubFetch>, n = 0): string {
  return (fn.mock.calls[n] as unknown as [string, RequestInit])[1].body as string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #58 — the action catalog is an ENVELOPE, and `truncated` must reach the caller
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the action catalog reaches the caller whole", () => {
  it("resolves the envelope, not the array — `.actions.length` is readable, `.length` is not", async () => {
    // THE DEFECT: the client declared `ActionSpec[]` while the route answers `{actions,count,truncated}`.
    // A lens read `specs.length` -> undefined -> falsy -> "read-only, no actions" on EVERY sector
    // including Home, with no error anywhere. Only the SHAPE stops that; a runtime check would still
    // have to be written by the caller that already got it wrong.
    stubFetch(200, {
      actions: [
        { id: "home.light.turn_on", description: "Turn on", params: [] },
        { id: "home.light.turn_off", description: "Turn off", params: [] },
      ],
      count: 2,
      truncated: false,
    });
    const catalog: ActionCatalog = await api.listActions("home");
    expect(catalog.actions).toHaveLength(2);
    expect(catalog.count).toBe(2);
    // The old bare-array read, spelled out: this is what the lens was doing, and it must be nothing.
    expect((catalog as unknown as { length?: number }).length).toBeUndefined();
  });

  it("`truncated: true` is NOT dropped — a trimmed catalog can be missing a whole trailing domain", async () => {
    // The cap cuts an ID-SORTED list, and ids are `sector.domain.service`, so a trimmed catalog loses
    // the alphabetical TAIL: every `switch.*` gone while `light.*` survives. A client that dropped this
    // flag would present a prefix as the complete capability surface — the silent-truncation defect
    // already removed from the MCP surface once.
    stubFetch(200, {
      actions: [{ id: "home.light.turn_on", description: "Turn on", params: [] }],
      count: 1,
      truncated: true,
    });
    const catalog = await api.listActions("home");
    expect(catalog.truncated).toBe(true);
    // and `count` is what THIS response holds — never a total, so it cannot be quoted as one
    expect(catalog.count).toBe(1);
  });

  it("count and truncated survive verbatim even when they disagree with actions.length", async () => {
    // The route serves core's answer untouched; so does the client. If a future gateway ever disagreed
    // with itself, the Console must show what it SAID, not a repaired version — a client that
    // recomputed `count = actions.length` would erase the evidence of the disagreement.
    stubFetch(200, { actions: [], count: 7, truncated: true });
    const catalog = await api.listActions("home");
    expect(catalog).toEqual({ actions: [], count: 7, truncated: true });
  });

  it("the whole catalog (no sector) is reachable — the route allows an absent sector", async () => {
    const f = stubFetch(200, { actions: [], count: 0, truncated: false });
    await api.listActions();
    expect(urlOf(f)).toBe("/api/actions");
  });

  it("the narrowing filter is the answer to truncation, and `entityId` goes on the wire as entity_id", async () => {
    // The ONE name mapping on this route (the MCP tool does it identically). Spelling it `entityId`
    // would not fail — the server would ignore it and answer a WIDER catalog than was asked for, which
    // is how a "narrow it" affordance ends up doing nothing at all.
    const f = stubFetch(200, { actions: [], count: 0, truncated: false });
    await api.listActions("home", { area: "Kitchen", domain: "light", entityId: "light.sink", limit: 25 });
    const url = urlOf(f);
    expect(url).toContain("entity_id=light.sink");
    expect(url).not.toContain("entityId");
    expect(url).toContain("sector=home");
    expect(url).toContain("area=Kitchen");
    expect(url).toContain("domain=light");
    expect(url).toContain("limit=25");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #61 — the keyset cursor lives in RESPONSE HEADERS
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the audit ledger's paging facts come off the response headers", () => {
  const row = {
    id: "9",
    agent_id: "a",
    tool: "query",
    sector: "mail",
    decision: "allow" as const,
    deny_reason: null,
    args: null,
    result_count: 1,
    outcome: null,
    request_id: null,
    created_at: "2026-07-26T10:00:00.000Z",
  };
  const CURSOR = "2026-07-26T10:00:00.123456Z|9";

  it("has-more true → the cursor is offered, verbatim", async () => {
    stubFetch(200, [row], { [AUDIT_HAS_MORE_HEADER]: "true", [AUDIT_NEXT_HEADER]: CURSOR });
    const page = await api.auditPage({ limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    // BYTE-FOR-BYTE. The microseconds are the whole point: `created_at` on the wire is
    // millisecond-precision (node-postgres parses timestamptz into a JS Date), so a cursor rebuilt from
    // a row lands up to 999µs off and silently drops every row inside that window — and the audit
    // writer batch-inserts, so those neighbours are routine. Note the row above carries `.000Z` while
    // the cursor carries `.123456Z`: a client that rebuilt the cursor could not produce this string.
    expect(page.nextCursor).toBe(CURSOR);
  });

  it("has-more false → end of history, and no cursor is invented", async () => {
    stubFetch(200, [row], { [AUDIT_HAS_MORE_HEADER]: "false" });
    const page = await api.auditPage();
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("an EXACTLY-FULL final page still reports end-of-history — the header wins over counting rows", async () => {
    // `rows.length === limit` is the tempting inference and it is wrong: the server decides with a
    // limit+1 PROBE row, so a page that happens to end on the boundary is the LAST page. A client that
    // second-guessed the header would offer a "load more" that returns nothing, forever.
    stubFetch(200, [row, row, row], { [AUDIT_HAS_MORE_HEADER]: "false" });
    const page = await api.auditPage({ limit: 3 });
    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("NO has-more header → `undefined`, which is not `false`", async () => {
    // A gateway that predates #61 sends neither header. `false` would claim "that is all there is",
    // which such a gateway cannot support; `undefined` says "this gateway does not page" — a fact about
    // the wire. Same rule as `reconnect_kind` and `last_seen_at`.
    stubFetch(200, [row]);
    const page = await api.auditPage();
    expect(page.hasMore).toBeUndefined();
    expect(page.hasMore).not.toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("a -next header WITHOUT has-more is not offered as a page", async () => {
    // Belt: a cursor we cannot interpret (no has-more means we cannot tell paging from silence) must
    // not become a "load more" button whose behaviour we cannot predict.
    stubFetch(200, [row], { [AUDIT_NEXT_HEADER]: CURSOR });
    const page = await api.auditPage();
    expect(page.hasMore).toBeUndefined();
    expect(page.nextCursor).toBeNull();
  });

  it("`audit()` is UNCHANGED — still the bare row array, headers or not", async () => {
    // Dozens of call sites compile against this. Exposing headers must not alter the shape any of them
    // sees: the header reader is a SECOND method over the SAME request, not a new envelope.
    stubFetch(200, [row], { [AUDIT_HAS_MORE_HEADER]: "true", [AUDIT_NEXT_HEADER]: CURSOR });
    const rows = await api.audit();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([row]);
  });

  it("both methods ask the ledger the SAME question", async () => {
    // A pager whose page 2 carried a filter its page 1 did not would silently walk a different history.
    const filters = { agent: "a", tool: "query", decision: "deny" as const, sector: "mail", since: "2026-07-01T00:00:00Z", before: "2026-07-26T10:00:00.123456Z|9", limit: 50 };
    const f1 = stubFetch(200, []);
    await api.audit(filters);
    const rowsUrl = urlOf(f1);
    vi.unstubAllGlobals();
    const f2 = stubFetch(200, []);
    await api.auditPage(filters);
    expect(urlOf(f2)).toBe(rowsUrl);
  });

  it("the two filters #61 added actually reach the query string", async () => {
    // `sector` was documented as NOT SERVED for weeks (and build-notes §16.5 claimed it existed before
    // it did). It exists now; a client that still omitted it would filter nothing and show the whole
    // ledger under a sector heading.
    const f = stubFetch(200, []);
    await api.audit({ sector: "finance", before: "2026-07-26T10:00:00.123456Z|9" });
    const url = urlOf(f);
    expect(url).toContain("sector=finance");
    expect(url).toContain("before=2026-07-26T10%3A00%3A00.123456Z%7C9");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #80 — the grant PATCH expiry is TRI-STATE on the wire
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("patchAgent preserves the tri-state expiry", () => {
  const agent = { agentId: "a", sectors: ["mail"], created_at: "x", revoked_at: null, expires_at: null };

  it("ABSENT expiry sends NO expiresInDays key — a sectors-only edit must not touch the deadline", async () => {
    // THE DEFECT: `null` means "never expires" to this route. A client that sent `null` for "unchanged"
    // would silently convert every sectors-only edit into "this key now never expires" — and it would
    // return 200 and look right. The raw body is asserted, not a re-parsed object, because
    // `JSON.parse('{"sectors":[]}')` and `{sectors:[],expiresInDays:undefined}` compare EQUAL under
    // toEqual: a test that parsed first could not tell the two apart.
    const f = stubFetch(200, agent);
    await api.patchAgent("a", { sectors: ["mail", "calendar"] });
    expect(rawBodyOf(f)).toBe('{"sectors":["mail","calendar"]}');
    expect(rawBodyOf(f)).not.toContain("expiresInDays");
  });

  it("explicit NULL is sent as null — 'never expires' must be reachable", async () => {
    // A client type that could not express explicit null would make this state unreachable from the
    // Console entirely.
    const f = stubFetch(200, agent);
    await api.patchAgent("a", { expiresInDays: null });
    expect(rawBodyOf(f)).toBe('{"expiresInDays":null}');
  });

  it("a NUMBER is sent as a number (extend or shorten)", async () => {
    const f = stubFetch(200, agent);
    await api.patchAgent("a", { expiresInDays: 30 });
    expect(rawBodyOf(f)).toBe('{"expiresInDays":30}');
  });

  it("both fields together, in one edit", async () => {
    const f = stubFetch(200, agent);
    await api.patchAgent("a", { sectors: ["home"], expiresInDays: 7 });
    expect(JSON.parse(rawBodyOf(f))).toEqual({ sectors: ["home"], expiresInDays: 7 });
  });

  it("absent SECTORS are omitted too — an expiry-only edit cannot clobber the grant set", async () => {
    // The route leaves sectors alone when the key is absent. Sending a stale copy read for the render
    // would overwrite a concurrently-changed grant with what the screen happened to be showing.
    const f = stubFetch(200, agent);
    await api.patchAgent("a", { expiresInDays: 1 });
    expect(rawBodyOf(f)).not.toContain("sectors");
  });

  it("`[]` clears the sectors, and is NOT confused with absent", async () => {
    const f = stubFetch(200, agent);
    await api.patchAgent("a", { sectors: [] });
    expect(rawBodyOf(f)).toBe('{"sectors":[]}');
  });

  it("the shipped sectors-only ARRAY form still means exactly { sectors }", async () => {
    // Kept because dropping it would break existing callers to express nothing new. It must send no
    // expiry key: the array form is how the pre-#80 Console edits a grant, and it must keep meaning
    // "leave the deadline alone".
    const f = stubFetch(200, agent);
    await api.patchAgent("a", ["mail", "home"]);
    expect(rawBodyOf(f)).toBe('{"sectors":["mail","home"]}');
    expect(urlOf(f)).toBe("/api/agents/a");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("PATCH");
  });

  it("sends ONLY the two known keys — a caller's wider object cannot ride along", async () => {
    // The body is built key-by-key rather than spread, and this is the assertion that makes that a
    // contract instead of a style: `{...patch}` would forward whatever a page's form state happens to
    // hold (a draft flag, an agentId, a pasted key) into an admin request. `zod` strips unknown keys
    // server-side, so nothing would break loudly — it would just be on the wire.
    const f = stubFetch(200, agent);
    const wide = { sectors: ["mail"], expiresInDays: 5, agentId: "a", draftKey: "sk-live-should-never-leave" };
    await api.patchAgent("a", wide as never);
    expect(Object.keys(JSON.parse(rawBodyOf(f))).sort()).toEqual(["expiresInDays", "sectors"]);
    expect(rawBodyOf(f)).not.toContain("sk-live");
  });

  it("an empty patch object sends {} — the server's 'nothing to update' 400, not a client-side guess", async () => {
    // The route answers a typed 400 naming both fields. Inventing a client-side error here would give
    // the operator a different (and less accurate) sentence than the gateway's own.
    const f = stubFetch(400, { error: "nothing to update: send 'sectors' and/or 'expiresInDays'" });
    await api.patchAgent("a", {}).catch(() => undefined);
    expect(rawBodyOf(f)).toBe("{}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #89 — the two newly served fields pass through UNTOUCHED, and absent stays absent
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A connector row with every REQUIRED field and no optional ones — the "older gateway" shape. */
function connectorRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: "c1",
    credentialId: "cr1",
    provider: "homeassistant",
    sector: "home",
    status: "active",
    last_synced_at: null,
    last_error: null,
    last_error_at: null,
    policy_mode: "push",
    next_sync_at: null,
    scopes: [],
    credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: null,
    default_interval_sec: null,
    cached_count: 0,
    ...extra,
  };
}

describe("reconnect_kind is served, and its three facts stay three facts", () => {
  it("passes through verbatim on the list wire", async () => {
    stubFetch(200, [connectorRow({ reconnect_kind: "device_push" })]);
    const [row] = await api.listConnectors();
    expect(row.reconnect_kind).toBe("device_push");
  });

  it("`none` is a SERVED claim and must not be manufactured from an absent field", async () => {
    // "none" means the gateway can name no reconnect flow ("we don't know"), NOT "nothing is wrong".
    // A client that defaulted the absent field to "none" would put words in an older gateway's mouth.
    stubFetch(200, [connectorRow({ reconnect_kind: "none" })]);
    const [served] = await api.listConnectors();
    expect(served.reconnect_kind).toBe("none");

    vi.unstubAllGlobals();
    stubFetch(200, [connectorRow()]);
    const [absent] = await api.listConnectors();
    expect(absent.reconnect_kind).toBeUndefined();
    expect("reconnect_kind" in absent).toBe(false);
    expect(absent.reconnect_kind).not.toBe("none");
  });

  it("is present on HEALTHY rows too — it is a property of custody, not of state", async () => {
    // Which is what lets a surface answer "how would I reconnect this?" before anything breaks,
    // synchronously, without a second fetch.
    stubFetch(200, [connectorRow({ status: "active", last_error: null, reconnect_kind: "reauth_oauth" })]);
    const [row] = await api.listConnectors();
    expect(row.status).toBe("active");
    expect(row.reconnect_kind).toBe("reauth_oauth");
  });

  it("the ABSENT case stays expressible — an older gateway's row still typechecks", () => {
    // A COMPILE-TIME assertion: making `reconnect_kind` required would turn every legacy row into a
    // type error and, worse, invite a page to stop writing its "Manage this connection" fallback.
    const legacy: ConnectorStatus = {
      connectionId: "c1",
      credentialId: "cr1",
      provider: "simplefin",
      sector: "finance",
      status: "active",
      last_synced_at: null,
      last_error: null,
      last_error_at: null,
      policy_mode: "poll",
      next_sync_at: null,
      scopes: [],
      credential: { status: "active", expires_at: null },
      webhook_secret_set_at: null,
      sync_window_days: null,
      sync_interval_sec: null,
      min_interval_sec: null,
      default_interval_sec: null,
      cached_count: 0,
    };
    expect(legacy.reconnect_kind).toBeUndefined();
  });
});

describe("orgDomain is served VERBATIM, not normalised", () => {
  const bank = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    institution: "Chase",
    mask: "4327",
    bankKey: "k1",
    dedupGroupId: null,
    providers: [],
    accountCount: 1,
    health: "ok",
    unmergedDuplicate: false,
    classConflict: false,
    ...extra,
  });

  it("the stored value arrives untouched — scheme and www are NOT stripped", async () => {
    // The route deliberately serves the STORED row rather than the dedup engine's grouping fold,
    // because that fold falls back to a NAME fold when the domain is absent — which would smuggle
    // name-guessing back in under a domain-shaped field name. A client that "tidied" the value would
    // re-introduce exactly the normalisation the server refused to do.
    stubFetch(200, [bank({ orgDomain: "https://www.Chase.com/" })]);
    const [card] = await api.getFinanceBanks();
    expect(card.orgDomain).toBe("https://www.Chase.com/");
  });

  it("null (this gateway has no domain for the card) is not the same as absent", async () => {
    stubFetch(200, [bank({ orgDomain: null })]);
    const [servedNull] = await api.getFinanceBanks();
    expect(servedNull.orgDomain).toBeNull();

    vi.unstubAllGlobals();
    stubFetch(200, [bank()]);
    const [absent] = await api.getFinanceBanks();
    expect(absent.orgDomain).toBeUndefined();
    expect("orgDomain" in absent).toBe(false);
  });

  it("the ABSENT case stays expressible on the type", () => {
    const legacy: FinanceBankSummary = {
      institution: "Chase",
      mask: null,
      bankKey: "k1",
      dedupGroupId: null,
      providers: [],
      accountCount: 0,
      health: "unknown",
      unmergedDuplicate: false,
      classConflict: false,
    };
    expect(legacy.orgDomain).toBeUndefined();
  });
});

describe("agent passage is served, and 'not served' still differs from 'never'", () => {
  const grant = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    agentId: "a",
    sectors: ["mail"],
    created_at: "2026-07-01T00:00:00.000Z",
    revoked_at: null,
    expires_at: null,
    ...extra,
  });

  it("last_seen_at: a string, null and absent are three different answers", async () => {
    stubFetch(200, [
      grant({ agentId: "seen", last_seen_at: "2026-07-26T09:00:00.000Z", last_read_at: { mail: "2026-07-26T09:00:00.000Z" } }),
      grant({ agentId: "quiet", last_seen_at: null, last_read_at: {} }),
      grant({ agentId: "legacy" }),
    ]);
    const [seen, quiet, legacy] = await api.listAgents();
    expect(seen.last_seen_at).toBe("2026-07-26T09:00:00.000Z");
    expect(quiet.last_seen_at).toBeNull(); // served, genuinely never seen
    expect(legacy.last_seen_at).toBeUndefined(); // not served — must never render as "never"
    expect(quiet.last_seen_at).not.toBe(legacy.last_seen_at);
  });

  it("last_read_at: {} is served-with-no-reads; a MISSING sector key is no read THERE", async () => {
    stubFetch(200, [
      grant({ agentId: "partial", sectors: ["mail", "home"], last_read_at: { mail: "2026-07-26T09:00:00.000Z" } }),
      grant({ agentId: "none-yet", last_read_at: {} }),
      grant({ agentId: "legacy" }),
    ]);
    const [partial, noneYet, legacy] = await api.listAgents();
    expect(partial.last_read_at?.mail).toBe("2026-07-26T09:00:00.000Z");
    // A GRANTED sector with no entry: a grant the agent has never used. Real and worth saying — and
    // not the same as the grant being absent.
    expect(partial.sectors).toContain("home");
    expect(partial.last_read_at?.home).toBeUndefined();
    expect(noneYet.last_read_at).toEqual({});
    expect(legacy.last_read_at).toBeUndefined();
  });
});
