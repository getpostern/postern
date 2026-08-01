// Per-sector static configuration + the pure derivations the six sector lenses share.
//
// Everything here is either a COMPILE-TIME contract (the REGISTRY object list and its column hints —
// the same kind of shape `api/types.ts`'s SECTOR_OBJECTS already encodes, not a synthesised served
// value) or a pure function over SERVED data (the verdict sentence, the coverage figures, the
// transport caption). Nothing derives freshness, staleness, custody, or the action catalog — those
// come off the wire (the laws) or degrade honestly (the §3 contract).

import type { ConnectorStatus, FinanceBankSummary, Sector, SyncNowResult } from "../../api/types";
import type { FreshnessDisplay } from "../../api/freshness";
import { count } from "../../api/format";
// The sector-scoped zero-agents phrase lives beside its global sibling (`agentsClause`) so the two
// concepts cannot drift. This is the SECOND cross-page-group import in `pages/` (LensMasthead's
// SECTOR_META is the first); both directories are owned by this unit, so it is legal here — but the
// clean home for the shared editorial vocabulary is `api/` or `marks/`, and that hoist is #91's.
import { sectorAgentsClause } from "../gatehouse/helpers";

/** The display name that leads the masthead, per sector. */
export const SECTOR_NAME: Record<Sector, string> = {
  finance: "Finance",
  mail: "Mail",
  calendar: "Calendar",
  contacts: "Contacts",
  health: "Health",
  home: "Home",
};

/** One coverage figure the COVERAGE band renders — an object's `query()` count under a label, with an
 *  optional static explanatory sub. The sub is NEVER a balance/market value: a per-account balance
 *  would turn the lens into a net-worth dashboard (build-notes §12.4), so those mock lines are dropped
 *  and only structural explanations survive.
 *
 *  **A sub is for the person, not for us (#106 §1).** It survives only if it tells the reader
 *  something about their own data that they could not see from the figure and the label. Two did not
 *  and are gone: the signed-amount convention (verbatim from this repo's `CLAUDE.md` gotchas, written
 *  for agents working on the code) and the holdings scope note (ADR 0022's — and false as well as
 *  internal, because the store does carry `market_value`; declining to *show* a balance here is a
 *  display choice, not an absence). The agent-facing texts are a separate set of strings on a separate
 *  surface (`src/core/schema.ts`, published by `get_schema`) and are correct where they are: two
 *  audiences, two texts. */
export interface CoverageObject {
  /** The REGISTRY object key `useSectorCoverage` counts against. */
  object: string;
  label: string;
  /** Static explanatory copy, or "" — never a served content value, never a note to ourselves. */
  sub: string;
}

/**
 * The coverage objects per sector. Object keys mirror `SECTOR_OBJECTS` in `api/types.ts` (the read
 * contract's shape). Labels + subs are the artboards' own copy, minus the two mock content lines the
 * finance lens carried ("across 19 institutions" is served from banks and stays; "$1.9M market value"
 * is a balance and is dropped per §12.4).
 */
export const SECTOR_COVERAGE: Record<Sector, CoverageObject[]> = {
  finance: [
    { object: "finance.account", label: "Accounts", sub: "" },
    { object: "finance.transaction", label: "Transactions", sub: "" },
    { object: "finance.holding", label: "Holdings", sub: "" },
  ],
  mail: [{ object: "mail", label: "Envelopes", sub: "sender · subject · snippet — bodies stay at the source" }],
  calendar: [{ object: "calendar", label: "Events", sub: "" }],
  contacts: [{ object: "contacts", label: "Contacts", sub: "" }],
  health: [
    { object: "health.sample", label: "Samples", sub: "" },
    { object: "health.workout", label: "Workouts", sub: "" },
    { object: "health.sleep_session", label: "Sleep sessions", sub: "" },
  ],
  home: [{ object: "home", label: "Entities", sub: "the live state of every device" }],
};

/**
 * The COVERAGE band's right-hand gloss — the footprint fact. Finance/home/etc. cache every row;
 * mail caches only the envelope inside a recency window (unbounded source, ADR 0017). Both are served
 * truths about how the connector stores, not content.
 */
export function footprintGloss(sector: Sector): string {
  return sector === "mail"
    ? "cached as metadata — a recency window"
    : "cached in full — a bounded source";
}

// `INSPECT_COLUMN_HINTS` USED TO LIVE HERE AND IS DELETED (#107 §2, operator ruling). It was a
// hardcoded per-sector list of column names that the teaser printed BELOW the "Open the inspector"
// link — the schema of a table nobody had opened yet. Two things were wrong with it and only one was
// cosmetic: the names were furniture a person cannot act on, AND the map was a hand-typed shadow of
// the REGISTRY that could silently drift from the columns the inspector actually renders (the
// inspector derives its own from `pages/inspector/registry.ts`). Do not re-add it — and note that its
// second reason has EXPIRED without changing the ruling: `get_schema` IS reachable now
// (`GET /api/operator/schema`), so "serve the real contract instead" is no longer blocked, it is simply
// still the wrong place. The published field list lives one click in, on the inspector's own schema
// peek (`pages/inspector/InspectorPage.tsx`, #82), where a person asked for it. The operator's words
// were about the SURFACE, not the source: "column names are not a teaser for anything — they are
// furniture that a person cannot act on."

/** The INSPECT-teaser supporting line — the same "raw cache, for verification not analysis" copy the
 *  artboards carry (this is the gateway-not-dashboard framing #64 leads with). */
export const INSPECT_SUB =
  "The raw cache — for verification, not analysis. Every row cached, exactly as the source served it.";

/**
 * A connection's transport descriptor for the sources-row cadence cell and the masthead caption —
 * derived ONLY from the served `policy_mode` / `push_kind` / cadence. It deliberately says nothing
 * about read-vs-act, and still must not: that answer belongs to the action catalog, which the CAN ACT
 * block reads for real now (`GET /api/actions`, #58). Asserting "read-only" from a TRANSPORT mode was
 * never a read of the catalog — it was a guess dressed as one, which is the whole of #58.
 */
export function transportLabel(c: ConnectorStatus): string {
  if (c.policy_mode === "push") {
    return c.push_kind === "webhook" ? "device push" : "push stream";
  }
  if (c.policy_mode === "poll") {
    const secs = c.sync_interval_sec ?? c.default_interval_sec;
    const cadence = secs != null ? cadenceLabel(secs) : null;
    return cadence ? `every ${cadence} · poll` : "poll";
  }
  return "on demand";
}

/** Whole-unit cadence rendering ("2h", "15m", "7d") for a poll interval in seconds. Coarse on
 *  purpose — a cadence chip is a legibility choice, not a stopwatch. */
export function cadenceLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * The masthead's one-line transport caption for the whole sector, composed from the served modes of
 * its connections. No read/act prefix — that claim belongs to CAN ACT, which reads the real catalog.
 * Empty when there are no connections.
 */
export function sectorTransportCaption(connectors: ConnectorStatus[]): string {
  if (connectors.length === 0) return "";
  const modes = new Set(connectors.map((c) => c.policy_mode));
  if (modes.size === 1) {
    const only = [...modes][0];
    if (only === "push") {
      const kinds = new Set(connectors.map((c) => c.push_kind ?? "stream"));
      if (kinds.size === 1) return [...kinds][0] === "webhook" ? "device push" : "push stream";
      return "push";
    }
    if (only === "poll") {
      const cadences = new Set(
        connectors.map((c) => cadenceLabel(c.sync_interval_sec ?? c.default_interval_sec ?? 0)),
      );
      if (cadences.size === 1 && ![...cadences][0].length) return "polls";
      return cadences.size === 1 ? `polls every ${[...cadences][0]}` : "polls";
    }
    return "on demand";
  }
  return "mixed sources";
}

/**
 * The generated masthead verdict SENTENCE — exceptions-first (build-notes §14.4). It changes SHAPE
 * when something is wrong (it leads with the exceptions and demotes the healthy summary to the last
 * clause) rather than appending a warning to an unchanged sentence.
 *
 * Every input is served: the freshness rollup (the server's state words), the connection count, the
 * distinct-provider count, the granting-agent count, and the list of unhealthy connections with the
 * word the API served for each. Nothing here derives a state.
 */
export function composeVerdict(input: {
  sector: Sector;
  connectionCount: number;
  providerCount: number;
  agentCount: number;
  unhealthy: { name: string; label: string }[];
  rollupState: FreshnessDisplay["state"];
}): string {
  const { connectionCount, providerCount, agentCount, unhealthy } = input;

  if (connectionCount === 0) {
    return "Nothing is connected here yet.";
  }

  const conn = `${count(connectionCount)} connection${connectionCount === 1 ? "" : "s"}`;
  const behind =
    providerCount > 1 ? ` behind ${count(providerCount)} providers` : providerCount === 1 ? " behind one provider" : "";
  // ONE sector-scoped phrase, shared with the Gatehouse sector card (#100 item 10).
  const read = ` · ${sectorAgentsClause(agentCount)}`;

  if (unhealthy.length > 0) {
    const names = unhealthy.map((u) => u.name).join(", ");
    const lead =
      unhealthy.length === 1
        ? `${unhealthy[0].name} needs you (${unhealthy[0].label.toLowerCase()}).`
        : `${count(unhealthy.length)} need you: ${names}.`;
    return `${lead} Everything else is flowing — ${conn}${behind}${read}.`;
  }

  return `${conn}${behind}, all flowing${read} — nothing needs you.`;
}

/**
 * The connections that need the operator, and the word the API served for each (never derived). The
 * healthy state (`ok`) and the merely-quiet states never appear — they are not exceptions. Used both
 * by the verdict sentence and by the attention banner the lens raises.
 */
export function unhealthyConnections(
  connectors: ConnectorStatus[],
  displayOf: (c: ConnectorStatus) => FreshnessDisplay,
  nameOf: (c: ConnectorStatus) => string,
): { name: string; label: string; connectionId: string }[] {
  const OUT: { name: string; label: string; connectionId: string }[] = [];
  for (const c of connectors) {
    const d = displayOf(c);
    if (d.tone === "error" || d.tone === "attention") {
      OUT.push({ name: nameOf(c), label: d.label ?? d.state, connectionId: c.connectionId });
    }
  }
  return OUT;
}

/** Distinct provider count across a sector's connections (finance's "behind two providers"). */
export function providerCount(connectors: ConnectorStatus[]): number {
  return new Set(connectors.map((c) => c.provider)).size;
}

// ── the sector "Sync now" outcome (#100 item 6) ───────────────────────────────
//
// The lens fired one `api.syncNow` per connection, awaited `Promise.allSettled`, and then showed an
// UNCONDITIONAL neutral toast: "Sync requested for Finance" — over three failed logins if that is
// what happened. Its `catch` could never fire, because `allSettled` does not reject; it was dead
// code that looked like error handling. `ConnectionDetail.tsx` already reads `ok`/`error` correctly
// for ONE connection; this is the same reading, reduced over N.

export interface SyncSummary {
  tone: "ok" | "error";
  message: string;
}

/** A settled outcome is a FAILURE iff it rejected, or the value says `ok === false`, or it carries a
 *  non-empty `error`, or it timed out. `ran === false` is NOT a failure: a push connection
 *  legitimately answers `ran:false, ok:true` with a note (src/core/lifecycle.ts). */
function isFailure(r: PromiseSettledResult<SyncNowResult>): boolean {
  if (r.status === "rejected") return true;
  const v = r.value;
  return v.ok === false || (v.error != null && v.error !== "") || v.timed_out === true;
}

/** The first failure's reason, resolved in a fixed order. NEVER an empty string, never
 *  `String(undefined)` — a toast that says "could not sync — undefined" is its own defect. */
function reasonOf(r: PromiseSettledResult<SyncNowResult>): string {
  if (r.status === "rejected") {
    return r.reason instanceof Error && r.reason.message
      ? r.reason.message
      : "the gateway did not answer";
  }
  const v = r.value;
  if (v.error != null && v.error !== "") return v.error;
  if (v.timed_out === true) return "timed out — the sync is still running";
  return "the connector reported a failure";
}

/**
 * Reduce the per-connection `Promise.allSettled` outcomes of a sector "Sync now" into ONE honest
 * toast.
 */
export function summarizeSectorSync(
  sectorName: string,
  results: PromiseSettledResult<SyncNowResult>[],
): SyncSummary {
  const total = results.length;
  if (total === 0) {
    // Unreachable from the page today (the caller guards on an empty sector), but the function is
    // total so a future caller cannot fall off the end of it.
    return { tone: "ok", message: `Nothing to sync in ${sectorName}` };
  }

  const failures = results.filter(isFailure);
  const failed = failures.length;

  if (failed === 0) {
    const values = results.map((r) => (r as PromiseFulfilledResult<SyncNowResult>).value);
    // An event-driven sector pulled nothing because there is nothing to pull — reporting that as a
    // sync of 0 rows would make every Home Assistant sync look like a no-op failure.
    if (values.every((v) => v.ran === false)) {
      return {
        tone: "ok",
        message: `${sectorName} is event-driven — these sources push to Postern; there is nothing to pull.`,
      };
    }
    const upserted = values.reduce((n, v) => n + (v.upserted ?? 0), 0);
    return { tone: "ok", message: `${sectorName} synced — ${upserted} updated` };
  }

  const firstReason = reasonOf(failures[0]);
  if (failed === total) {
    return { tone: "error", message: `${sectorName} could not sync — ${firstReason}` };
  }
  return {
    tone: "error",
    message: `Synced ${total - failed} of ${total} — ${failed} failed: ${firstReason}`,
  };
}

/** The finance banks that are a cross-provider MERGE served as one — the deduped set the sources-band
 *  note names. A merged bank arrives via more than one provider AND carries a dedup group. Merged rows
 *  get NO warning marker (build-notes §12.3); this list only powers the evidence note. */
export function mergedBanks(banks: FinanceBankSummary[]): FinanceBankSummary[] {
  return banks.filter((b) => b.dedupGroupId != null && b.providers.length > 1);
}
