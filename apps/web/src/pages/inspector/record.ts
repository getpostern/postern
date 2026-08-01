// Pure derivations for the record drill — kept out of the component so a test can pin the mirror.
// The rule (build-notes §5.2): mirror the stored row, never summarise. So NORMALIZED is every scalar
// the store holds (minus the system/provenance/jsonb columns, which have their own homes), formatted
// only enough to be read — never re-computed.

import type { Row } from "../../api/types";
// The drill's private `money()` moved to `./money` so the LIST cell renders the identical string
// (#100 item 3) — two copies is how "−$87.32" here and "-87.32" one click away happened.
import { moneyOrNull } from "./money";
import { objectDefByKey } from "./registry";

const DASH = "—";

/** Columns that are NOT normalized scalars — they belong to Provenance, to Raw, or are internal. */
const SYSTEM_KEYS = new Set([
  "id",
  "user_id",
  "connection_id",
  "source_object_id",
  "ingested_at",
  "deleted_at",
  "raw",
  "attributes",
  "attendees",
  "shadowed_by_id",
  "dedup_group_id",
]);

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

/** "YYYY-MM-DD" if the value is midnight, else "YYYY-MM-DD HH:mm". Rendered in UTC so a stored
 *  UTC-midnight date does not slip a day on a negative-offset machine (and stays deterministic). */
export function fmtStamp(v: unknown): string {
  if (v == null || v === "") return DASH;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
  return hasTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}

/** Mirror a normalized scalar: timestamps get lightly formatted; booleans/nulls read plainly; every
 *  other value is stringified untouched. */
export function fmtNormalized(v: unknown): string {
  if (v == null || v === "") return DASH;
  if (isIso(v)) return fmtStamp(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export interface Entry {
  key: string;
  value: string;
  muted?: boolean;
}

/** The NORMALIZED section — every stored scalar except the system/provenance/jsonb columns. */
export function normalizedEntries(record: Row): Entry[] {
  return Object.keys(record)
    .filter((k) => !SYSTEM_KEYS.has(k))
    .map((k) => ({ key: k, value: fmtNormalized(record[k]) }));
}

/** The PROVENANCE section — connection, source id, ingest clock, tombstone, dedup linkage. */
export function provenanceEntries(
  record: Row,
  providerLabel: string | null,
  connectorsLoading: boolean,
): Entry[] {
  const cid = record.connection_id;
  const connection =
    providerLabel != null
      ? providerLabel
      : cid == null
        ? "synthetic union"
        : connectorsLoading
          ? "…"
          : String(cid);

  const deleted = record.deleted_at;
  const tombstone = deleted == null || deleted === "" ? "— · live" : `${fmtStamp(deleted)} · tombstoned`;

  return [
    { key: "connection", value: connection, muted: providerLabel == null && cid != null },
    { key: "source_object_id", value: String(record.source_object_id ?? DASH) },
    { key: "ingested_at", value: fmtStamp(record.ingested_at) },
    { key: "deleted_at", value: tombstone, muted: true },
    { key: "dedup", value: dedupLabel(record), muted: true },
  ];
}

/** Dedup linkage, finance-aware. Non-finance tables carry no shadow columns at all. */
export function dedupLabel(record: Row): string {
  const hasShadowCol = "shadowed_by_id" in record;
  if (!hasShadowCol) return "not deduped";
  if (record.shadowed_by_id != null) return "shadowed by a merge";
  if (record.dedup_group_id != null) return "merged (winner)";
  return "not shadowed";
}

// ── headline + subtitle ─────────────────────────────────────────────────────────

const HEADLINE_FIELDS: Record<string, string[]> = {
  "finance.account": ["name"],
  "finance.transaction": ["merchant", "description"],
  "finance.holding": ["name", "symbol"],
  mail: ["subject"],
  calendar: ["summary"],
  contacts: ["display_name"],
  "health.sample": ["metric_type"],
  "health.workout": ["sport"],
  "health.sleep_session": [],
  home: ["entity_id"],
};

const HEADLINE_FALLBACK: Record<string, string> = {
  "finance.account": "Account",
  "finance.transaction": "Transaction",
  "finance.holding": "Holding",
  mail: "(no subject)",
  calendar: "(untitled)",
  contacts: "Contact",
  "health.sample": "Sample",
  "health.workout": "Workout",
  "health.sleep_session": "Sleep session",
  home: "Entity",
};

export function recordHeadline(objectKey: string, record: Row): string {
  if (objectKey === "health.sleep_session") return record.is_nap === true ? "Nap" : "Sleep session";
  for (const f of HEADLINE_FIELDS[objectKey] ?? []) {
    const v = record[f];
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return HEADLINE_FALLBACK[objectKey] ?? "Record";
}

function leadValue(objectKey: string, record: Row): string | null {
  switch (objectKey) {
    case "finance.transaction":
      return moneyOrNull(record.amount, record.currency);
    case "finance.account":
      return moneyOrNull(record.current_balance, record.currency);
    case "finance.holding":
      return moneyOrNull(record.market_value, record.currency);
    case "health.sample":
      return record.value == null ? null : `${record.value}${record.unit ? ` ${record.unit}` : ""}`;
    default:
      return null;
  }
}

/** The masthead subtitle: lead value · primaryTime · via provider — each part omitted when absent. */
export function recordSubtitle(objectKey: string, record: Row, providerLabel: string | null): string {
  const parts: string[] = [];
  const lead = leadValue(objectKey, record);
  if (lead) parts.push(lead);

  const primaryTime = objectDefByKey(objectKey)?.object.primaryTime;
  if (primaryTime) {
    const t = fmtStamp(record[primaryTime]);
    if (t !== DASH) parts.push(t);
  }

  if (providerLabel) parts.push(`via ${providerLabel}`);
  return parts.length ? parts.join(" · ") : DASH;
}
