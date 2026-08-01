// The inspector's column model — REGISTRY-driven, one row of config per sector object.
//
// Columns are NOT hand-authored per page (build-notes §5.1): every `field` here is a real column on
// the server REGISTRY (`src/core/schema.ts`) except the TWO synthetic keys below, which are marked so
// the rest of the code (sort, filter, data-aware hiding) can treat them differently:
//
//   __source  — per-row PROVENANCE, on every object whose sector can be fed by more than one source.
//               Read from `__provenance` ({ connection_id, provider, merged }), which
//               `POST /api/data/:sector` now serves on every row in rows mode — see `cells.ts`
//               `sourceCell` for the four answers and why they are not interchangeable. It used to be
//               finance-ONLY, because the provider name was not on the list wire and only finance's
//               reserved `union:` namespace could be derived; the operator's most-repeated complaint
//               (#122, "still no source on contacts") was the cost of that gap, with three providers
//               feeding calendar and contacts on a real box.
//   __flags   — mail ONLY, a compact derived summary of the served booleans (is_read /
//               has_attachments). Not a stored column, so it is never sortable.
//
// `SECTOR_OBJECTS` (api/types) is the object-key contract; this file mirrors each object's SCALAR
// columns from the same REGISTRY those keys index. When a sector gains an object or a column, this
// file and `src/core/schema.ts` change together — exactly as `SECTOR_OBJECTS` already does.

import type { Sector } from "../../api/types";

/** The synthetic, non-REGISTRY column keys (never sortable, never sent to query()). */
export const SYNTHETIC_FIELDS = new Set(["__source", "__flags"]);

/** How a cell paints — decided by column, applied by `cells.tsx`. */
export type CellKind =
  | "text" // body ink — the row's headline (merchant, subject, title, name, entity)
  | "muted" // body faded — a secondary string (account, location, org)
  | "mono" // mono ink — an identifier value
  | "monoMuted" // mono faded — a de-emphasised mono value
  | "category" // mono faded, smaller — the taxonomy token (FOOD_AND_DRINK)
  | "num" // mono ink, right — a bare number (quantity, duration, efficiency)
  | "money" // mono ink, right — a signed currency amount, rendered with the row's served `currency` and a U+2212 minus
  | "datetime" // mono faded — a timestamp, formatted
  | "source" // per-row provenance — the provider name, the union marker (marigold), or a stated absence
  | "state" // home entity state — availability-aware (#59)
  | "flags"; // mail flags — derived from served booleans

export interface ColumnDef {
  /** A REGISTRY scalar field, or a `__synthetic` key (see SYNTHETIC_FIELDS). */
  field: string;
  header: string;
  /** Fixed lane in px (e.g. "120px"); omit → the column flexes to fill. */
  width?: string;
  align?: "left" | "right";
  kind: CellKind;
}

export interface ObjectDef {
  /** The exact REGISTRY key — "finance.transaction", "mail", … — passed to query()/getRecord(). */
  key: string;
  /** The object tab label (multi-object sectors only). */
  tabLabel: string;
  /** The count noun ("transactions" → "8,823 transactions"). */
  noun: string;
  /** Default sort column (the object's REGISTRY `primaryTime`), always desc. */
  primaryTime: string;
  /** The REGISTRY text field the filter box targets with a `contains` query ("" = no filter field). */
  filterField: string;
  filterPlaceholder: string;
  columns: ColumnDef[];
}

export interface SectorDef {
  sector: Sector;
  /** Display title ("Finance") — the back-link + masthead. */
  title: string;
  /** The masthead subtitle, verbatim from Paper. */
  subtitle: string;
  objects: ObjectDef[];
}

// Sortable = a real REGISTRY scalar (server validates orderBy against schema.fields; a synthetic or
// derived column would be a typed 400). Used by the page to decide which headers get a sort button.
export function isSortable(col: ColumnDef): boolean {
  return !SYNTHETIC_FIELDS.has(col.field);
}

/**
 * THE Source column — one definition, so the lane cannot drift between sectors.
 *
 * Width, ink and type come from the Finance inspector artboard's own Source lane (`6I9-0` / node
 * 6ML-0, `get_jsx({format:"inline-styles"})`): a fixed 130px slot, mono 12px. Every sector that
 * carries provenance reuses THIS object rather than repeating the width, because "the surface a person
 * already learned" is the whole reason to reuse the finance treatment — and a hand-copied `130px` is
 * how five lanes end up four pixels apart.
 *
 * Placement rule, taken from finance: after the descriptive columns, before any trailing numeric or
 * derived run (finance puts it immediately before Amount / Balance / Value).
 */
const SOURCE_COLUMN: ColumnDef = {
  field: "__source",
  header: "Source",
  width: "130px",
  kind: "source",
};

// ── FINANCE ──────────────────────────────────────────────────────────────────
// Finance front-loads __source (build-notes §5.1) on every object.

const financeAccount: ObjectDef = {
  key: "finance.account",
  tabLabel: "Accounts",
  noun: "accounts",
  primaryTime: "balance_at",
  filterField: "name",
  filterPlaceholder: "Filter accounts…",
  columns: [
    { field: "name", header: "Account", kind: "text" },
    { field: "account_type", header: "Type", width: "140px", kind: "muted" },
    { field: "institution_name", header: "Institution", width: "200px", kind: "muted" },
    SOURCE_COLUMN,
    { field: "current_balance", header: "Balance", width: "140px", align: "right", kind: "money" },
  ],
};

const financeTransaction: ObjectDef = {
  key: "finance.transaction",
  tabLabel: "Transactions",
  noun: "transactions",
  primaryTime: "posted_at",
  filterField: "merchant",
  filterPlaceholder: "Filter transactions…",
  columns: [
    { field: "posted_at", header: "Date", width: "100px", kind: "datetime" },
    { field: "merchant", header: "Merchant", kind: "text" },
    { field: "category", header: "Category", width: "170px", kind: "category" },
    { field: "account_source_id", header: "Account", width: "150px", kind: "muted" },
    SOURCE_COLUMN,
    { field: "amount", header: "Amount", width: "110px", align: "right", kind: "money" },
  ],
};

const financeHolding: ObjectDef = {
  key: "finance.holding",
  tabLabel: "Holdings",
  noun: "holdings",
  primaryTime: "as_of",
  filterField: "symbol",
  filterPlaceholder: "Filter holdings…",
  columns: [
    { field: "symbol", header: "Symbol", width: "110px", kind: "mono" },
    { field: "name", header: "Security", kind: "text" },
    { field: "security_type", header: "Type", width: "140px", kind: "muted" },
    SOURCE_COLUMN,
    // `quantity` stays "num" — shares are a COUNT, not money. Dressing it in the account's currency
    // would read "$12.50" for 12.5 shares.
    { field: "quantity", header: "Quantity", width: "120px", align: "right", kind: "num" },
    { field: "market_value", header: "Value", width: "130px", align: "right", kind: "money" },
  ],
};

// ── MAIL ─────────────────────────────────────────────────────────────────────

const mailObject: ObjectDef = {
  key: "mail",
  tabLabel: "Messages",
  noun: "envelopes",
  primaryTime: "received_at",
  filterField: "subject",
  filterPlaceholder: "Filter envelopes…",
  columns: [
    { field: "received_at", header: "Date", width: "100px", kind: "datetime" },
    { field: "from_name", header: "From", width: "190px", kind: "text" },
    { field: "subject", header: "Subject", kind: "text" },
    { field: "folder", header: "Folder", width: "140px", kind: "muted" },
    SOURCE_COLUMN,
    { field: "__flags", header: "Flags", width: "110px", kind: "flags" },
  ],
};

// ── CALENDAR ──────────────────────────────────────────────────────────────────

const calendarObject: ObjectDef = {
  key: "calendar",
  tabLabel: "Events",
  noun: "events",
  primaryTime: "starts_at",
  filterField: "summary",
  filterPlaceholder: "Filter events…",
  columns: [
    { field: "starts_at", header: "Start", width: "150px", kind: "datetime" },
    { field: "summary", header: "Title", kind: "text" },
    { field: "ends_at", header: "End", width: "150px", kind: "datetime" },
    { field: "location", header: "Location", width: "220px", kind: "muted" },
    SOURCE_COLUMN,
  ],
};

// ── CONTACTS ──────────────────────────────────────────────────────────────────

const contactsObject: ObjectDef = {
  key: "contacts",
  tabLabel: "Contacts",
  noun: "contacts",
  primaryTime: "updated_at",
  filterField: "display_name",
  filterPlaceholder: "Filter contacts…",
  columns: [
    { field: "display_name", header: "Name", width: "220px", kind: "text" },
    { field: "primary_email", header: "Email", kind: "muted" },
    { field: "primary_phone", header: "Phone", width: "170px", kind: "mono" },
    { field: "company", header: "Org", width: "200px", kind: "muted" },
    SOURCE_COLUMN,
  ],
};

// ── HEALTH ────────────────────────────────────────────────────────────────────
//
// health.sample is the ONE object that gets NO `__source` column, deliberately: it already carries a
// REAL `source` REGISTRY scalar, and on the shipped connectors that column holds the producing
// provider's own token ("apple_health" · "whoop" — `src/connectors/apple-health.ts` SOURCE,
// `src/connectors/whoop.ts`). Adding provenance beside it would put TWO columns headed "Source" in one
// table, answering the same question twice, and the REGISTRY one is strictly better: it is sortable and
// filterable, which a synthetic key can never be. Workouts and sleep sessions have no such column, so
// they take `SOURCE_COLUMN` in the finance position (after the descriptive columns, before the numbers).

const healthSample: ObjectDef = {
  key: "health.sample",
  tabLabel: "Samples",
  noun: "samples",
  primaryTime: "window_start",
  filterField: "metric_type",
  filterPlaceholder: "Filter samples…",
  columns: [
    { field: "window_start", header: "Time", width: "100px", kind: "datetime" },
    { field: "metric_type", header: "Type", kind: "mono" },
    { field: "value", header: "Value", width: "120px", align: "right", kind: "num" },
    { field: "unit", header: "Unit", width: "120px", kind: "muted" },
    { field: "source", header: "Source", width: "170px", kind: "muted" },
  ],
};

const healthWorkout: ObjectDef = {
  key: "health.workout",
  tabLabel: "Workouts",
  noun: "workouts",
  primaryTime: "started_at",
  filterField: "sport",
  filterPlaceholder: "Filter workouts…",
  columns: [
    { field: "started_at", header: "Started", width: "160px", kind: "datetime" },
    { field: "sport", header: "Sport", kind: "mono" },
    SOURCE_COLUMN,
    { field: "duration_seconds", header: "Duration", width: "120px", align: "right", kind: "num" },
    { field: "distance_meters", header: "Distance", width: "120px", align: "right", kind: "num" },
    { field: "energy_kcal", header: "kcal", width: "100px", align: "right", kind: "num" },
    { field: "strain", header: "Strain", width: "100px", align: "right", kind: "num" },
  ],
};

const healthSleep: ObjectDef = {
  key: "health.sleep_session",
  tabLabel: "Sleep",
  noun: "sessions",
  primaryTime: "started_at",
  filterField: "",
  filterPlaceholder: "Filter sleep…",
  columns: [
    { field: "started_at", header: "Started", width: "160px", kind: "datetime" },
    { field: "ended_at", header: "Ended", width: "160px", kind: "datetime" },
    { field: "is_nap", header: "Type", width: "100px", kind: "muted" },
    SOURCE_COLUMN,
    { field: "time_asleep_seconds", header: "Asleep", width: "120px", align: "right", kind: "num" },
    { field: "efficiency_pct", header: "Efficiency", width: "120px", align: "right", kind: "num" },
  ],
};

// ── HOME ──────────────────────────────────────────────────────────────────────

const homeObject: ObjectDef = {
  key: "home",
  tabLabel: "Entities",
  noun: "entities",
  primaryTime: "state_timestamp",
  filterField: "entity_id",
  filterPlaceholder: "Filter entities…",
  columns: [
    { field: "entity_id", header: "Entity", width: "220px", kind: "mono" },
    { field: "domain", header: "Domain", width: "140px", kind: "muted" },
    { field: "state", header: "State", kind: "state" },
    { field: "area", header: "Area", width: "180px", kind: "muted" },
    // Home has exactly ONE registered connector today, so on most boxes every cell here reads "Home
    // Assistant". It is carried anyway: two HA instances are two credentials and therefore two `home`
    // connections (two houses is an ordinary shape), and a lane that exists on five tables and is
    // absent on the sixth is the inconsistency a person notices. A constant true answer is mild; a
    // missing provenance column is the defect this change exists to remove.
    SOURCE_COLUMN,
    { field: "state_timestamp", header: "Changed", width: "120px", align: "right", kind: "datetime" },
  ],
};

export const SECTORS: Record<Sector, SectorDef> = {
  finance: {
    sector: "finance",
    title: "Finance",
    subtitle:
      "The raw cache — for verification, not analysis. Every row carries its source; a deduped union drills to both pristine provider rows.",
    objects: [financeAccount, financeTransaction, financeHolding],
  },
  mail: {
    sector: "mail",
    title: "Mail",
    // #100 item 2 — this used to read "Open a message to fetch its body and attachments live from
    // the source", while one click below `RecordDrillPage.tsx` drew that button permanently disabled:
    // the masthead promised what the drill could not do.
    //
    // The drill CAN do it now (#57 — `POST /api/operator/fetch_live` is served and the button is
    // wired), and the promise still does not come back here, for a reason the original fix did not
    // have: a live record fetch needs the CONNECTOR to implement it. Gmail, iCloud Mail, Microsoft and
    // Home Assistant do; a connector that does not answers core's typed "live record fetch not
    // supported for <provider>", which the drill shows verbatim. A masthead sentence cannot know which
    // provider a row came from, so promising it for a whole sector would over-claim for some of them —
    // and this Console's rule is that a promise is made where it can be kept. The offer lives on the
    // drill, next to the button that keeps it.
    subtitle:
      "The raw cache — envelopes only. Sender, subject and snippet are cached; bodies and attachments stay at the source.",
    objects: [mailObject],
  },
  calendar: {
    sector: "calendar",
    title: "Calendar",
    subtitle:
      "The raw cache — for verification, not analysis. Each event carries its source calendar; the same meeting from two providers shows as two tagged rows.",
    objects: [calendarObject],
  },
  contacts: {
    sector: "contacts",
    title: "Contacts",
    subtitle:
      "The raw cache — for verification, not analysis. Each contact carries its source book; the same person from two providers shows as two tagged rows.",
    objects: [contactsObject],
  },
  health: {
    sector: "health",
    title: "Health",
    subtitle:
      "The raw cache — for verification, not analysis. Every sample carries its source connection and exact timestamp.",
    objects: [healthSample, healthWorkout, healthSleep],
  },
  home: {
    sector: "home",
    title: "Home",
    subtitle:
      "The raw cache — for verification, not analysis. Live state per entity; reachable devices show their value, only genuinely-unavailable ones read as error.",
    objects: [homeObject],
  },
};

/** The sector's config, or undefined for a bad route param. */
export function sectorDef(sector: string): SectorDef | undefined {
  return (SECTORS as Record<string, SectorDef>)[sector];
}

/** Find the object def for an exact REGISTRY key across all sectors (the drill resolves by key). */
export function objectDefByKey(key: string): { sector: SectorDef; object: ObjectDef } | undefined {
  for (const sd of Object.values(SECTORS)) {
    const object = sd.objects.find((o) => o.key === key);
    if (object) return { sector: sd, object };
  }
  return undefined;
}
