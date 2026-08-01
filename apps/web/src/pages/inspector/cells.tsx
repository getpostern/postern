// Cell rendering + the pure derivations the inspector table needs. Everything that DERIVES a display
// value from a served row lives here as a pure, exported function so a test can pin it against the
// REAL wire shape — most importantly the home state cell (#59), whose bug is invisible in a fixture
// built the wrong way.

import type { ReactNode } from "react";
import { humanize } from "../../api/format";
import type { Row } from "../../api/types";
import type { CellKind, ColumnDef } from "./registry";
import { SYNTHETIC_FIELDS } from "./registry";
import { formatMoney } from "./money";
import styles from "./cells.module.css";

const DASH = "—";

/** A served value counts as empty (for data-aware hiding, and for "—") when it is null/absent or a
 *  blank string. `false` and `0` are NOT empty — they are real data. */
export function isEmptyValue(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Compact absolute stamp for a list cell: "MM-DD" (or "MM-DD HH:mm" when a time-of-day is present).
 *  Absolute, not relative: the inspector is the DATA-recency surface, and mixing a relative clock in
 *  here would cross it with the transport clock the freshness grammar keeps separate. Rendered in UTC
 *  so a stored UTC-midnight date does not slip a day on a negative-offset machine. */
export function formatStamp(v: unknown): string {
  if (isEmptyValue(v)) return DASH;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const date = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
  return hasTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}

/** Locale number, up to 2 decimals. Never fabricates precision (does not pad -6.5 to -6.50) and never
 *  forces a leading "+" — a bare count is not a signed amount. */
export function formatNum(v: unknown): string {
  if (isEmptyValue(v)) return DASH;
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── #59 — the home state cell ─────────────────────────────────────────────────
//
// THE BUG this replaces: the old cell treated any `availability !== "available"` as an error and hid
// the value. Live Home Assistant NEVER reports "available" — it reports "online" for a reachable
// entity (src/connectors/homeassistant.ts: `raw === "unavailable" || raw === "unknown" ? raw :
// "online"`). So every healthy entity rendered a red "error" pill with its real state hidden. A
// fixture built with availability:"available" hides the bug; the test below uses "online".

export type StateTone = "ok" | "idle" | "error";

/**
 * Map the REAL availability vocabulary — `online` | `unavailable` | `unknown` (and defensively a
 * legacy `available`) — onto a display. Reachable entities ALWAYS render their actual state value;
 * `error` is reserved for a genuinely `unavailable` entity.
 */
export function homeStateDisplay(
  availability: unknown,
  state: unknown,
  unit: unknown,
): { text: string; tone: StateTone } {
  const avail = typeof availability === "string" ? availability.toLowerCase() : null;
  const value = isEmptyValue(state) ? null : String(state);
  const withUnit = (t: string): string =>
    !isEmptyValue(unit) ? `${t} ${String(unit)}` : t;

  if (avail === "unavailable") return { text: value ?? "unavailable", tone: "error" };
  // "unknown" is reachable-but-stateless — calm, not an error (spec: reserve error for unavailable).
  if (avail === "unknown") return { text: value ?? "unknown", tone: "idle" };
  // online / available / (missing, defensive) → reachable: render the real value, never an error.
  return { text: value == null ? DASH : withUnit(value), tone: "ok" };
}

// ── per-row provenance: the __source column (#65 / #122) ──────────────────────
//
// THE COMPLAINT this closes, in the operator's own words: *"still no source on contacts."* Three
// providers feed calendar and contacts on a real box (Google, Microsoft, iCloud) and the LIST rendered
// identical rows with nothing to tell them apart. The record DRILL had provenance; the list did not,
// because — as the code here used to say — *"the PROVIDER name is NOT on the list wire (query()
// returns REGISTRY fields; connection_id is not one)"*.
//
// **It is served now.** Every element of `rows` from `POST /api/data/:sector` carries ONE synthetic
// output key, `__provenance` = `{ connection_id, provider, merged }` (core `RowProvenance`), ON BY
// DEFAULT in rows mode. It is output-only: `connection_id` is still absent from the REGISTRY `fields`
// map, so it stays un-filterable, un-sortable and — the point — un-WRITABLE, because that map is also
// the ingest allow-list and a provider must never get to say which connection its rows belong to.
//
// The four answers, in precedence order, and they are NOT interchangeable:
//
//   1. `__provenance` ABSENT      → the wire did not carry it (an older gateway, or aggregate mode).
//                                   "Not served" is a fact about the wire and NEVER means "unknown".
//                                   Finance's pre-provenance `union:`-namespace derivation still
//                                   answers here, so an older gateway loses nothing it had.
//   2. `merged === true`          → a cross-provider dedup synthetic. `connection_id` and `provider`
//                                   are BOTH null ON PURPOSE: the row stands for more than one
//                                   connection, so naming an anchor member would be a half-truth.
//   3. `provider` is a string     → the `connectors.provider` SLUG, verbatim off the wire. Rendered
//                                   through the ONE shared humanisation (`api/format`), never a
//                                   second slug→name table — this repo has been bitten three times by
//                                   a second table that merely agreed at first.
//   4. `provider === null`        → "unknown source". The row's connection could not be resolved in
//                                   this sector for this user; the gateway fails CLOSED rather than
//                                   guessing. NEVER synthesise a provider from row content.

/** The served per-row provenance — mirrors `RowProvenance` in `src/core/query.ts`. */
export interface RowProvenance {
  /** `connectors.id`. null ⟺ merged (no single source). */
  connection_id: string | null;
  /** The provider SLUG ("google", "microsoft", "apple", "plaid", "simplefin", "whoop", "home_assistant"). */
  provider: string | null;
  /** true = a dedup synthetic standing for >1 connection. */
  merged: boolean;
}

/**
 * Read `__provenance` off a served row, or `null` when the wire did not carry it.
 *
 * `Row` is `Record<string, unknown>`, so this narrowing is the only place the shape is asserted.
 * `merged` is the discriminator that must be PRESENT — an object without it is not this contract, and
 * treating a missing `merged` as `false` would silently turn a shape mismatch into "not merged".
 */
export function rowProvenance(row: Row): RowProvenance | null {
  const p = row["__provenance"];
  if (p == null || typeof p !== "object" || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.merged !== "boolean") return null;
  return {
    connection_id: typeof o.connection_id === "string" ? o.connection_id : null,
    provider: typeof o.provider === "string" && o.provider !== "" ? o.provider : null,
    merged: o.merged,
  };
}

/** Which of the four answers a `__source` cell is rendering — the cell's ink follows from it. */
export type SourceKind = "union" | "provider" | "unknown" | "unserved";

/**
 * The `__source` cell for one served row. Pure, and the ONLY place the four answers are decided.
 *
 * A `shadowed_by_id` row (visible only under finance's opt-in "show the provider rows behind merges")
 * keeps its shadow marker ALONGSIDE its now-served provider name: the reveal exists precisely to say
 * WHICH providers sit behind a merge, and the fact that the row is behind one is the reveal's premise.
 * Neither fact is dropped for the other.
 */
export function sourceCell(row: Row): { text: string; kind: SourceKind } {
  const p = rowProvenance(row);
  const shadowed = row.shadowed_by_id != null;

  if (p === null) {
    // Not served. Finance's reserved-namespace derivation is the one honest thing still available
    // (CLAUDE.md / ADR 0021: `union:%` is a reserved `source_object_id` namespace).
    const soid = typeof row.source_object_id === "string" ? row.source_object_id : "";
    if (soid.startsWith("union:")) return { text: "union", kind: "union" };
    if (shadowed) return { text: "shadowed", kind: "provider" };
    return { text: "not served", kind: "unserved" };
  }

  if (p.merged) return { text: "union", kind: "union" };
  if (p.provider !== null) {
    const name = humanize(p.provider);
    return { text: shadowed ? `${name} · shadowed` : name, kind: "provider" };
  }
  return { text: "unknown source", kind: "unknown" };
}

// ── mail flags (the __flags column) ───────────────────────────────────────────
// Derived strictly from served booleans — no invented "flagged" state (there is no served flag).

export function mailFlags(row: Row): string {
  const parts: string[] = [];
  if (row.is_read === false) parts.push("unread");
  if (row.has_attachments === true) parts.push("attachment");
  return parts.length ? parts.join(" · ") : DASH;
}

// ── the cell renderer ──────────────────────────────────────────────────────────

/** The `__source` cell's ink, one class per answer — see `sourceCell`'s precedence list. */
const SOURCE_CLASS: Record<SourceKind, string> = {
  union: styles.sourceUnion,
  provider: styles.sourceProvider,
  unknown: styles.sourceUnknown,
  unserved: styles.sourceUnserved,
};

const KIND_CLASS: Record<CellKind, string> = {
  text: styles.text,
  muted: styles.muted,
  mono: styles.mono,
  monoMuted: styles.monoMuted,
  category: styles.category,
  num: styles.num,
  money: styles.money,
  datetime: styles.datetime,
  source: styles.mono,
  state: styles.text,
  flags: styles.muted,
};

/** Render one column's cell for a row. Kept out of the page so the table stays declarative. */
export function renderCell(col: ColumnDef, row: Row): ReactNode {
  switch (col.kind) {
    case "state": {
      const d = homeStateDisplay(row.availability, row.state, row.unit);
      return <span className={styles.text} data-state-tone={d.tone}>{d.text}</span>;
    }
    case "source": {
      const s = sourceCell(row);
      return (
        <span className={SOURCE_CLASS[s.kind]} data-source-kind={s.kind}>
          {s.text}
        </span>
      );
    }
    case "flags":
      return <span className={styles.muted}>{mailFlags(row)}</span>;
    case "datetime":
      return <span className={styles.datetime}>{formatStamp(row[col.field])}</span>;
    case "num":
      return <span className={styles.num}>{formatNum(row[col.field])}</span>;
    case "money":
      // The ROW's own currency, never the column's or a constant: `currency` is a REGISTRY scalar on
      // all three finance objects (src/core/schema.ts), so it is on the list wire, and it is
      // genuinely per-row — a EUR account and a null-currency SimpleFIN cash holding sit in the same
      // column as a USD one.
      return <span className={styles.money}>{formatMoney(row[col.field], row.currency)}</span>;
    default: {
      const v = row[col.field];
      const text = isEmptyValue(v) ? DASH : typeof v === "boolean" ? (v ? "true" : "false") : String(v);
      return <span className={KIND_CLASS[col.kind]}>{text}</span>;
    }
  }
}

// ── #83 — data-aware columns ───────────────────────────────────────────────────
//
// The table reflects the ACTUAL shape of what was cached, not the schema. A column that is empty
// across every loaded row is dropped; a sparse one is de-emphasised. The headline column (index 0)
// and the synthetic columns (finance's __source is always meaningful; mail's __flags is derived) are
// never dropped — a table with no first column, or a finance list that hid provenance, would be
// worse than a mostly-empty column. **Verified against a fixture here; verified against real iCloud
// contacts (name+phone only) in phase 3, where the fixture cannot prove the real shape.**

export interface ColumnAnalysis {
  visible: ColumnDef[];
  /** Fields present but under the sparse threshold — the header renders de-emphasised. */
  sparse: Set<string>;
}

const SPARSE_THRESHOLD = 0.12;

export function analyzeColumns(columns: ColumnDef[], rows: Row[]): ColumnAnalysis {
  if (rows.length === 0) return { visible: columns, sparse: new Set() };
  const visible: ColumnDef[] = [];
  const sparse = new Set<string>();
  columns.forEach((col, i) => {
    // Never hide the headline or a synthetic/derived column.
    if (i === 0 || SYNTHETIC_FIELDS.has(col.field)) {
      visible.push(col);
      return;
    }
    const filled = rows.reduce((n, r) => (isEmptyValue(r[col.field]) ? n : n + 1), 0);
    if (filled === 0) return; // fully empty → drop
    if (filled / rows.length < SPARSE_THRESHOLD) sparse.add(col.field);
    visible.push(col);
  });
  return { visible, sparse };
}
