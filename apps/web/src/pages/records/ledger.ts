// The ledger's pure logic — kept out of the component so the finding-critical rules (#78's third
// decision state, #61's served paging reach) are unit-testable without a DOM. The component is a thin
// renderer over these.

import { AUDIT_LIMIT_DEFAULT, SECTORS, type AuditPage, type AuditRow } from "../../api/types";
import { humanize, plural } from "../../api/format";

/**
 * The THREE decision states (#78). The audit's `decision` is only ever `allow | deny` — but an
 * ALLOWED call whose `outcome` is `"error"` is a THIRD thing: admitted at the door, then failed
 * doing the work. Painting it as a green "allow" is the exact lie this finding names. `outcome` is
 * the connector-reported result (`ok | error | …`); anything that is not `"error"` on an allowed row
 * is a plain admission.
 */
export type DecisionState = "admitted" | "denied" | "errored";

export function decisionState(row: Pick<AuditRow, "decision" | "outcome">): DecisionState {
  if (row.decision === "deny") return "denied";
  if (row.outcome === "error") return "errored";
  return "admitted";
}

/** The word each state renders as. The ledger TABLE prints only the two exceptions (§17.5 — the
 *  column read ADMITTED on five of seven rows, which buried the two that mattered); the one-row
 *  drill prints all three, because there the word is a record field, not a repeated column. */
export const DECISION_LABEL: Record<DecisionState, string> = {
  admitted: "Admitted",
  denied: "Denied",
  errored: "Errored",
};

/**
 * The served `decision` filter is `allow | deny` only — there is NO `outcome` filter on the wire
 * (verified against `AuditFilters`), so "errored" can be a rendered STATE but never a server query.
 * The toggle therefore offers exactly what the API backs: All · Admitted · Denied. (#61 names this
 * an "allow/deny toggle" for the same reason; the design's 4th "Errored" segment is ahead of the
 * API — reported, not faked as a filter that would silently only narrow the loaded page.)
 */
export type DecisionFilter = "all" | "allow" | "deny";

export const DECISION_FILTERS: { value: DecisionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "allow", label: "Admitted" },
  { value: "deny", label: "Denied" },
];

/** Map the toggle to the served `AuditFilters.decision` (undefined = no filter). */
export function decisionFilterParam(f: DecisionFilter): "allow" | "deny" | undefined {
  return f === "all" ? undefined : f;
}

/**
 * The Sector filter (#61 part 1) — `""` is no filter, and the rest are the six REGISTRY sectors.
 *
 * The Console drew NO sector control for weeks and that was the right call at the time: `?sector=` was
 * not read by the route, so the pill would have looked like a query and narrowed nothing. It is a plain
 * equality clause on `audit_log.sector` now, so the control is honest and the absence became the lie.
 *
 * The vocabulary is the compile-time `SECTORS` contract, not a runtime distinct-values read: there is
 * no such route, and the ledger is history — a sector could appear in old rows and in no list the
 * gateway can produce today. Offering the contract is the same posture as `AUDIT_TOOLS` above.
 */
export const SECTOR_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All sectors" },
  ...SECTORS.map((s) => ({ value: s, label: humanize(s) })),
];

/**
 * What a sector filter does that nobody would guess from the control: it EXCLUDES the calls that
 * happened in no sector at all — `describe_context`, `get_schema`, a refused handshake. The route
 * matches `sector = $n`, and SQL equality never matches NULL, so those rows silently leave the view.
 *
 * That is not a bug to work around (they genuinely did not happen in a sector) but it does mean a
 * sector-filtered ledger is not the whole ledger, and the one oversight surface must not imply that it
 * is. Returns `null` when no sector is chosen, so the default view gains no print.
 */
export function sectorFilterCaveat(sector: string): string | null {
  if (!sector) return null;
  return "One sector at a time also leaves out every call that belonged to no sector — an agent asking what the gate holds, or a handshake the gate refused. Those are still recorded; they just cannot match a sector.";
}

/**
 * The MCP tool vocabulary — the seven core primitives. There is no served "distinct tools"
 * endpoint, so the Tool filter offers this fixed contract list (the same posture as `SECTOR_OBJECTS`
 * in types.ts: a compile-time contract, not an invented runtime value). If a primitive is added,
 * this list and the core change together.
 */
export const AUDIT_TOOLS = [
  "query",
  "get_record",
  "fetch_live",
  "describe_context",
  "get_schema",
  "list_actions",
  "invoke_action",
] as const;

/**
 * A ledger row's stamp, split for the two-part Time cell (#100 item 9).
 *
 * The column used to print the clock ONLY, so on a trail spanning more than one day a row's date was
 * recoverable only from the drill — and the ledger is exactly the surface you read when you want to
 * know *when* something came through the gate.
 *
 * BOTH halves come from ONE `Date` and BOTH use LOCAL getters. This is not incidental: the
 * inspector's `formatStamp` renders UTC, and mixing a UTC calendar day with a local clock in one
 * cell is a real, silent, off-by-one-day bug for every user west of UTC. Do not reuse it here.
 *
 * Unparseable input degrades to the raw value with no date, mirroring what `timeOfDay` did — a wrong
 * date is worse than no date, and "NaN-NaN" must never reach the screen.
 */
export function ledgerStamp(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: iso };
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { date: `${mm}-${dd}`, time: d.toLocaleTimeString(undefined, { hour12: false }) };
}

/** A compact one-line rendering of the redacted args for a ledger row (CSS ellipsis truncates).
 *
 *  VERBATIM, deliberately — this is also the EXPORT's rendering (`exportCell`), and a CSV of the audit
 *  trail is an archive: it carries the arguments as the gate recorded them, empty keys and all. The
 *  screen's reading is `argsCell` below, which is a different job. */
export function formatArgs(args: unknown): string {
  if (args == null) return "—";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * The half of an args object that says anything: the keys whose value is not null (#106 §4).
 *
 * The operator ran an export from this Console and read the row back as `just now / operator / export /
 * { sector: null }` — three quarters of it right and the last quarter a key with nothing in it. A null
 * `sector` on an export is honest on the wire (nothing was narrowed) and says nothing at all to a
 * reader, and the row already states the sector properly in its own column, with an em-dash. So the
 * screen keeps the keys that carry a value and drops the rest.
 *
 * Returns `null` when nothing survives, so each surface prints its own mark for absence rather than an
 * empty `{}` — the ledger's table cell needs an em-dash where the Gatehouse glance needs nothing at all.
 * Strings, arrays and scalars pass straight through: a positional argument has no key to be empty, and
 * a redacted string is the gate's own word.
 *
 * The return type is `unknown` because the input is (`AuditRow.args` is agent-authored JSON); `null`
 * is the answer callers branch on, and every caller does.
 */
export function argsWithValues(args: unknown): unknown {
  if (args == null) return null;
  if (typeof args !== "object" || Array.isArray(args)) return args;
  const kept = Object.entries(args as Record<string, unknown>).filter(([, v]) => v != null);
  return kept.length === 0 ? null : Object.fromEntries(kept);
}

/** The ledger table's Args cell: the value-bearing keys, or the em-dash the table already uses for a
 *  fact a row does not carry (its Sector column prints the same one). */
export function argsCell(args: unknown): string {
  return formatArgs(argsWithValues(args));
}

/** The pretty (indented) rendering of args, shown verbatim in the per-row drill (#78). */
export function prettyArgs(args: unknown): string {
  if (args == null) return "—";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/**
 * The "Since …" presets — the API accepts ONLY a `since` floor (rows `created_at >= since`), so a true
 * date RANGE is still not offered (reported).
 *
 * `before` is NOT the missing ceiling, tempting as the name is: it is the keyset cursor, and its grammar
 * demands a microsecond instant AND a row id (`…123456Z|9012`), which a date picker cannot produce — a
 * value that does not match is a typed 400. It walks the page, it does not bound the range.
 */
export type SincePreset = "any" | "24h" | "7d" | "30d";

export const SINCE_PRESETS: { value: SincePreset; label: string }[] = [
  { value: "any", label: "Any date" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

const SINCE_MS: Record<Exclude<SincePreset, "any">, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** Resolve a since-preset to the served ISO floor (or undefined for "any"). `now` injectable. */
export function sinceParam(preset: SincePreset, now: Date = new Date()): string | undefined {
  if (preset === "any") return undefined;
  return new Date(now.getTime() - SINCE_MS[preset]).toISOString();
}

// ── The keyset pager (#61 part 2) ─────────────────────────────────────────────────────────────────
//
// What this REPLACES: a ladder that asked for `limit` 100 → 250 → 500 → 1,000 and then told the reader
// that anything older "cannot be reached from here". Both halves are now false. `/api/audit` mints a
// keyset cursor in `x-postern-audit-next` and reads it back as `AuditFilters.before`, so history is
// walkable a page at a time, and `AUDIT_LIMIT_MAX` bounds ONE PAGE rather than what is reachable.
//
// One page is the server's own default, so this Console invents no page size of its own.
export const LEDGER_PAGE_SIZE = AUDIT_LIMIT_DEFAULT;

/**
 * How far the loaded view reaches — read off the SERVED paging facts and nothing else.
 *
 *  · `more`    the gateway offered a place to continue from. `cursor` is its OWN string, verbatim.
 *  · `end`     the gateway said there is nothing older for this filter. Authoritative.
 *  · `unknown` the gateway did not say. NOT an end, and rendered as a reason instead of a claim.
 */
export type LedgerReach =
  | { kind: "more"; cursor: string }
  | { kind: "end" }
  | { kind: "unknown"; reason: string };

/**
 * No has-more header at all. Written for the person: it says what cannot be done, why, and — the load
 * -bearing half — what it does NOT mean. "The gateway predates the keyset cursor" is the #106
 * anti-pattern; so is naming the header.
 */
export const LEDGER_NO_PAGING_REASON =
  "Older entries cannot be asked for here: this gate hands over the ledger without a place to carry on from, so there is nowhere to continue. That is not the same as having reached the end — nothing on this page can tell you whether there are older entries or not.";

/** has-more said yes and no cursor came with it. A different sentence, because it is a different fact:
 *  here the gate HAS said older entries exist. */
export const LEDGER_NO_CURSOR_REASON =
  "This gate says there are older entries but did not say where to carry on from, so they cannot be asked for here.";

/**
 * THE derivation, and the only place `undefined` is separated from `false`. Three traps live in these
 * four lines, and this repo has paid for each of them once:
 *
 *  1. **`hasMore: undefined` is not `false`.** It means the gateway sent no has-more header — it is
 *     older than paging, or something between it and this page dropped the header. Folding it into
 *     `false` would tell a person they had reached the end of their own accountability record when
 *     nobody knows that. It resolves to `unknown`, which the page prints as a reason, never as an end.
 *  2. **`rows.length < limit` is not the signal** — the reason the header exists at all (the rule is
 *     `src/core/query.ts`'s: `count === limit` is the wrong signal; the route answers from a limit+1
 *     PROBE row). An exactly-full FINAL page serves `hasMore: false`, and counting rows would read that
 *     as "there is more" and offer a Load more that returns nothing, forever. This function is not
 *     given `rows`, so it cannot be written that way by a later hand.
 *  3. **A cursor is the server's, verbatim.** `created_at` on the wire has already lost the
 *     microseconds the cursor is anchored to, so one rebuilt from a row drops every row inside a
 *     sub-millisecond window — and the audit writer batch-inserts, so those neighbours are routine.
 *     Nothing here constructs a cursor; `more` carries the header value through untouched.
 */
export function ledgerReach(page: Pick<AuditPage, "hasMore" | "nextCursor">): LedgerReach {
  if (page.hasMore === undefined) return { kind: "unknown", reason: LEDGER_NO_PAGING_REASON };
  if (page.hasMore === false) return { kind: "end" };
  return page.nextCursor
    ? { kind: "more", cursor: page.nextCursor }
    : { kind: "unknown", reason: LEDGER_NO_CURSOR_REASON };
}

// ── The filtered-view export (#78, third sub-finding) ────────────────────────────────────────────
//
// FORMAT RULING — CSV, one mechanism, recorded here so it is cheap to overrule.
//
// The operator delegated the call. The case for JSON: it matches the existing bundle download and
// `args` is structured. The case for CSV: the ledger IS a table, this surface is described in its own
// masthead as "the only oversight", and the person who exports an audit trail is reconciling it —
// sorting, filtering, pivoting, handing it to someone. CSV won on three grounds:
//
//  1. The artefact's shape follows the surface's shape. Every field but `args` is a scalar, and `args`
//     survives verbatim as compact JSON inside one cell — so CSV loses nothing and gains the
//     spreadsheet.
//  2. The complete machine-readable copy ALREADY exists: Settings' full JSON bundle. A second JSON
//     download would overlap it while answering a different question badly.
//  3. Two formats would be two mechanisms to keep honest about the same cap. The brief forbids
//     building both to dodge the decision.
//
// To overrule: the format is `auditRowsToCsv` plus the extension in `ledgerExportFilename` and the
// word in the button's label. `ledgerExportNote` and the download path are already format-agnostic.
//
// Two deliberate non-decisions, reported rather than invented:
//  - NO byte-order mark. Excel wants one to read UTF-8; strict RFC-4180 parsers read it as part of the
//    first field name. This file is as likely to be piped into a script as opened in a spreadsheet, so
//    it stays clean CSV and the mime declares the charset.
//  - NO provenance preamble. Which filters produced the file is genuinely load-bearing for an incident
//    review, but a comment row breaks every CSV parser, and inventing a filename grammar for it is a
//    design decision that is not mine to make.

/**
 * The exported columns — the audit row's OWN wire field names, in the drill's reading order.
 *
 * Wire names, not the table's display headers: the reader of this file is correlating entries against
 * a log or an issue, where the fields are called `request_id` and `created_at`. A translation layer
 * between the export and the API would be one more thing to drift.
 */
export const LEDGER_EXPORT_COLUMNS = [
  "created_at",
  "agent_id",
  "tool",
  "sector",
  "decision",
  "deny_reason",
  "outcome",
  "result_count",
  "request_id",
  "args",
  "id",
] as const;

/** A cell that a spreadsheet would execute rather than read: Excel and Sheets evaluate text opening
 *  with `= + - @`, a tab or a CR. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** …but a plain number is a number. `-50` must stay numeric; `-1+1` must not stay a formula. */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * One RFC-4180 field. Every value is quoted (valid, and it removes a whole class of comma/newline
 * bugs), internal quotes are doubled, and a formula-leading value gets the spreadsheet's own
 * literal-text marker.
 *
 * That last part is not cosmetic. `args` is agent-authored: an agent that puts
 * `=IMPORTRANGE("…","…")` in a query param would have it EXECUTED in the reviewer's spreadsheet the
 * moment they open the audit trail — turning the oversight surface into an exfiltration path.
 * Quoting alone does not prevent it; the leading apostrophe does, displays as nothing in the cell,
 * and is visible as itself in a text editor. Shipping the value raw is the worse trade.
 */
function csvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  const safe = FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** `created_at` goes out VERBATIM — the ISO instant the gate recorded, zone and all. The table
 *  renders a LOCAL clock for reading; an archived artefact carries the unambiguous original. */
function exportCell(row: AuditRow, column: (typeof LEDGER_EXPORT_COLUMNS)[number]): unknown {
  if (column === "args") return row.args == null ? "" : formatArgs(row.args);
  return row[column];
}

/**
 * The filtered view as an RFC-4180 CSV table — header row, then one row per entry, CRLF-delimited.
 *
 * `rows` is whatever the page is showing and NOTHING else: that is the finding. An export that
 * quietly re-reads the trail unfiltered is the #74 complaint ("Export dumps everything") wearing a
 * new hat, and this repo fixed that once already.
 */
export function auditRowsToCsv(rows: AuditRow[]): string {
  const lines = [LEDGER_EXPORT_COLUMNS.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(LEDGER_EXPORT_COLUMNS.map((c) => csvField(exportCell(row, c))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Mirrors `postern-export-<date>.json` — the same convention, so two downloads from one gate sort
 *  together in a downloads folder. */
export function ledgerExportFilename(now: Date = new Date()): string {
  return `postern-ledger-${now.toISOString().slice(0, 10)}.csv`;
}

/** What the ledger knows about its own reach, as the page computes it. */
export interface LedgerExportScope {
  /** Rows currently rendered — exactly what the file will hold. */
  shown: number;
  /**
   * The SERVED reach of the loaded view (`ledgerReach`), never an inference from `shown`.
   *
   * This used to be two booleans derived from `rows.length === limit` — the signal `src/core/query.ts`
   * names as the wrong one. An exactly-full FINAL page therefore printed "load more first to take more
   * of the trail with you" when there was nothing more, and the 1,000-row page printed a flat dead end.
   */
  reach: LedgerReach["kind"];
}

/**
 * The sentence printed beside the export button — what the file WILL contain, said before the click.
 *
 * The export itself does NOT grow a second mechanism: it is still exactly the rows on screen, because
 * an export that quietly re-read the trail is the #74 complaint. What changed is that the pager can now
 * reach the end, so the caveat SHRINKS to the truth as the reader walks — and at `end` it disappears
 * into the strongest honest claim, which the ladder could never earn.
 *
 * It never claims completeness without "as of this read": the audit writer is async by invariant, so a
 * call in flight is legitimately not in the file yet.
 */
export function ledgerExportNote(scope: LedgerExportScope): string {
  // `plural` (not a hand-rolled ternary) so "1 entry" never reads "1 entries" — the #92 rule.
  const n = plural(scope.shown, "entry", "entries");
  if (scope.reach === "more") {
    return `The file is this view exactly — ${n}, and nothing beyond what is loaded. Load more first to take more of the trail with you.`;
  }
  if (scope.reach === "unknown") {
    // Neither "all of them" nor "there is more" — the gate did not say, and the file must not either.
    return `The file is this view exactly — ${n}. This gate did not say whether anything older exists, so the file cannot claim to be all of them.`;
  }
  return `The file is this view exactly — ${n}, every one these filters match as of this read.`;
}
