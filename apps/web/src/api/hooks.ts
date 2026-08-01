// TanStack Query hooks over the typed RestClient — and the ONE polling/invalidation contract (#62).
//
// The rule: **freshness must advance on a watched screen.** Anything that carries a `freshness`
// tuple polls on an interval and is stale-on-arrival, so a landed sync or a dying push stream shows
// up without navigating away. Relative LABELS advance separately and without a network call, via
// `useTick` — a second hand is not a reason to hit the gateway.
//
// Query keys live in `qk` so a mutation can invalidate exactly what it affected. Pages own their
// mutations (phase 2), but the invalidation targets are frozen here — otherwise seven page groups
// each invent a key shape and pause/resume stops updating the list it changed.

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import {
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  SECTOR_OBJECTS,
  isAggregateResult,
  type AuditFilters,
  type QueryBody,
  type Sector,
} from "./types";

/** How often a freshness-bearing query re-reads the gateway. Loopback + a cache-only read, so this
 *  is cheap; the number is a legibility choice, not a load one. */
export const FRESHNESS_POLL_MS = 15_000;
/** The ledger moves slower and is heavier; 30s keeps it live without churn. */
export const AUDIT_POLL_MS = 30_000;

/** Every query key the Console uses. One place, so invalidation can never miss a surface. */
export const qk = {
  healthz: () => ["healthz"] as const,
  connectors: () => ["connectors"] as const,
  connector: (id: string | undefined) => ["connector", id] as const,
  financeBanks: () => ["finance", "banks"] as const,
  financeDedupCandidates: () => ["finance", "dedup-candidates"] as const,
  agents: () => ["agents"] as const,
  audit: (filters: AuditFilters) => ["audit", filters] as const,
  data: (sector: string | undefined, body: QueryBody) => ["data", sector, body] as const,
  record: (sector: string | undefined, id: string | undefined) => ["record", sector, id] as const,
  coverage: (sector: Sector) => ["coverage", sector] as const,
  exposure: () => ["exposure"] as const,
} as const;

/** Gateway liveness — polled so the shell's gate-status footer stays honest. */
export function useHealthz() {
  return useQuery({
    queryKey: qk.healthz(),
    queryFn: () => api.healthz(),
    refetchInterval: FRESHNESS_POLL_MS,
    retry: false,
  });
}

/**
 * The enriched connector list (status · freshness · scopes · policy · cadence).
 * Polls, and is stale-on-arrival so returning to the tab always re-reads: this list is where a
 * dead push stream or a landed sync becomes visible.
 */
export function useConnectors() {
  return useQuery({
    queryKey: qk.connectors(),
    queryFn: () => api.listConnectors(),
    refetchInterval: FRESHNESS_POLL_MS,
    staleTime: 0,
  });
}

/** One connection's enriched status + per-table row counts. Same freshness posture as the list. */
export function useConnector(id: string | undefined) {
  return useQuery({
    queryKey: qk.connector(id),
    queryFn: () => api.getConnector(id as string),
    enabled: Boolean(id),
    refetchInterval: FRESHNESS_POLL_MS,
    staleTime: 0,
  });
}

/** The finance banks-by-institution view (#33). Carries per-Item health, so it polls too. */
export function useFinanceBanks() {
  return useQuery({
    queryKey: qk.financeBanks(),
    queryFn: () => api.getFinanceBanks(),
    refetchInterval: FRESHNESS_POLL_MS,
    staleTime: 0,
  });
}

/**
 * The gate's own address and exposure state (ADR 0035 §D1).
 *
 * **Deliberately does NOT poll**, and that is not an oversight: this changes only when the operator
 * changes it, and the one value that could drift under the Console — what the process is *serving* —
 * cannot change without a restart, which ends the session anyway. Polling it would be a heartbeat on
 * a value that has no heartbeat. Every mutation calls `useInvalidateExposure()` instead.
 */
export function useExposure() {
  return useQuery({ queryKey: qk.exposure(), queryFn: () => api.getExposure() });
}

/** Re-read the exposure state after publishing or unpublishing. */
export function useInvalidateExposure() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.exposure() });
  };
}

/** The agent grants (never returns key material). */
export function useAgents() {
  return useQuery({ queryKey: qk.agents(), queryFn: () => api.listAgents() });
}

/**
 * The append-only audit trail, newest first — ONE page of rows, no paging facts.
 *
 * Seven served filters apply now (`AuditFilters`): `sector` and the `before` cursor landed with #61.
 * There is still no total count. This hook returns rows only, so it cannot tell a caller whether older
 * rows exist — that fact rides in response headers and needs `api.auditPage` (see `AuditPage`). A pager
 * built on this hook plus `auditHitCeiling()` would be guessing.
 */
export function useAudit(filters: AuditFilters = {}) {
  return useQuery({
    queryKey: qk.audit(filters),
    queryFn: () => api.audit(filters),
    refetchInterval: AUDIT_POLL_MS,
    staleTime: 0,
  });
}

/**
 * True when the returned page is exactly as long as the ceiling that produced it — i.e. older matching
 * rows probably exist beyond this page. Behaviour is unchanged, but **one premise it was written on is
 * no longer true**: since #61 those older rows CAN be reached, with the `before` keyset cursor
 * (`api.auditPage` → `AuditPage.nextCursor`). A surface that still says "unreachable" is now wrong.
 *
 * It also remains an INFERENCE, and a weaker one than the wire now offers: `AuditPage.hasMore` is
 * authoritative (a server-side limit+1 probe), so an exactly-full FINAL page reports end-of-history
 * there while this helper reports "more". Prefer `hasMore`; keep this only for the rows-only `useAudit`
 * path, where a false positive is the safe direction — it over-warns rather than implying completeness.
 */
export function auditHitCeiling(rows: unknown[] | undefined, filters: AuditFilters = {}): boolean {
  if (!rows) return false;
  const requested = Math.min(filters.limit ?? AUDIT_LIMIT_DEFAULT, AUDIT_LIMIT_MAX);
  return rows.length >= requested;
}

/** Operator inspector read over one sector. Cache-only and instant server-side — it keeps the
 *  default 30s staleTime and does NOT poll: rows are not a freshness signal (two clocks). */
export function useDataQuery(sector: string | undefined, body: QueryBody = {}) {
  return useQuery({
    queryKey: qk.data(sector, body),
    queryFn: () => api.queryData(sector as string, body),
    enabled: Boolean(sector),
  });
}

/** One cached row, full `raw` included (the record drill). */
export function useRecord(sector: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: qk.record(sector, id),
    queryFn: () => api.getRecord(sector as string, id as string),
    enabled: Boolean(sector) && Boolean(id),
  });
}

/**
 * Sector coverage figures — one `count` aggregate per REGISTRY object in the sector.
 *
 * **This deliberately departs from the audit's recommendation (#60), and the reason is
 * correctness.** #60 proposes summing the connectors list's `cached_count` for a zero-round-trip
 * first paint. `cached_count` counts live rows per CONNECTION, which for finance includes both
 * pristine provider rows AND the synthetic union row of a deduped account — so one
 * cross-provider-merged account counts three times. `query()` serves one (`shadowed_by_id is
 * null`). Summing `cached_count` therefore reports a figure no agent will ever see, and is the
 * likely root of the unexplained 435-row disagreement the audit flagged.
 *
 * So coverage is service truth: what an agent reads, dedup-correct. The em-dash-at-hero-size defect
 * is fixed by `counts` being `undefined` while loading (the caller renders a `<Skeleton>`), not by
 * taking the wrong number quickly. `cached_count` keeps its one documented job: the honest
 * "Syncing… (N)" first-sync pill.
 *
 * @returns `counts` keyed by REGISTRY object ("finance.account", "mail", …); `undefined` until
 *          every object has answered, so a partial figure is never rendered as a total.
 */
export function useSectorCoverage(sector: Sector): {
  counts: Record<string, number> | undefined;
  isLoading: boolean;
} {
  const objects = SECTOR_OBJECTS[sector];
  const results = useQueries({
    queries: objects.map((object) => ({
      queryKey: [...qk.coverage(sector), object],
      queryFn: () => api.queryData(object, { aggregate: { fn: "count" as const } }),
    })),
  });

  const isLoading = results.some((r) => r.isPending);
  if (isLoading || results.some((r) => r.data === undefined)) {
    return { counts: undefined, isLoading };
  }

  const counts: Record<string, number> = {};
  results.forEach((r, i) => {
    const res = r.data;
    if (!res || !isAggregateResult(res)) return;
    // count with no groupBy → groups is exactly [{ group: {}, value }]. pg may hand back a string
    // for a numeric aggregate, so coerce once, here.
    const raw = res.groups[0]?.value;
    counts[objects[i]] = raw == null ? 0 : Number(raw);
  });
  return { counts, isLoading: false };
}

/**
 * The invalidation half of the polling contract.
 *
 * Every connection mutation (pause · resume · sync-now · cadence · sync-window · disconnect ·
 * revoke · reconnect) must call this with the connection it touched. Polling alone is not enough:
 * a 15s gap between clicking Pause and the row saying "Paused" reads as a broken button.
 *
 * `connectionId` is optional because some mutations (disconnect, revoke-credential) change the
 * whole list; passing it additionally refreshes that one connection's detail query.
 */
export function useInvalidateConnectors() {
  const qc = useQueryClient();
  return (connectionId?: string) => {
    void qc.invalidateQueries({ queryKey: qk.connectors() });
    void qc.invalidateQueries({ queryKey: qk.financeBanks() });
    if (connectionId) void qc.invalidateQueries({ queryKey: qk.connector(connectionId) });
  };
}

/** Invalidate the agent register after mint / rotate / patch / revoke / delete. */
export function useInvalidateAgents() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.agents() });
  };
}

/**
 * Invalidate cached rows after anything that changes what is stored — a sync-now that upserted, an
 * erase, a disconnect. Coverage figures ride along, since they are `query()` counts.
 */
export function useInvalidateData() {
  const qc = useQueryClient();
  return (sector?: string) => {
    void qc.invalidateQueries({ queryKey: sector ? ["data", sector] : ["data"] });
    void qc.invalidateQueries({ queryKey: ["coverage"] });
  };
}
