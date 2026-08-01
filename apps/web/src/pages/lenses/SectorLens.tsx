// The ONE sector-lens template (build-notes §6) — masthead · THE SOURCES · WHAT AGENTS CAN DO ·
// COVERAGE · INSPECT THE RECORDS. #64: it leads with the gateway view (who you're connected to, who
// can read/act, how much is cached) and demotes the raw table to a teaser. Finance is the exception
// (§12): two provider rows + the institution run + the dedup note & trust flags, and — on the
// /sectors/finance/merges/:bankKey route — the confirm-a-merge block.
//
// This component owns ALL data reads and every SERVED derivation (freshness rollups, relative-time
// renders under the page tick); the band components it composes are pure and individually tested.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, NotServedError } from "../../api/client";
import {
  FRESHNESS_POLL_MS,
  qk,
  useAgents,
  useConnectors,
  useInvalidateConnectors,
  useInvalidateData,
  useSectorCoverage,
} from "../../api/hooks";
import { freshnessDisplay, freshnessRollup, type FreshnessDisplay } from "../../api/freshness";
import { ago, count, humanize, useTick } from "../../api/format";
import type {
  ConnectorStatus,
  FinanceBankSummary,
  FinanceDedupCandidate,
  Sector,
} from "../../api/types";
import { Skeleton, ZeroState, useToast } from "../../kit";

import { LensMasthead } from "./LensMasthead";
import { SourcesBand, type FinanceExtras, type SourceRowVM, type TrustFlag } from "./SourcesBand";
import { AgentsBand, type ActCatalog, type ReadAgent } from "./AgentsBand";
import type { ActionFilter } from "../../api/types";
import { CoverageBand } from "./CoverageBand";
import { InspectTeaser } from "./InspectTeaser";
import { MergeQuestion, type MergeSideVM } from "./MergeQuestion";
import { isKeyHolder } from "../agents/helpers";
import {
  composeVerdict,
  mergedBanks,
  providerCount as distinctProviders,
  SECTOR_NAME,
  sectorTransportCaption,
  summarizeSectorSync,
  transportLabel,
  unhealthyConnections,
} from "./lensmeta";
import { sourceGroupHref } from "../sources/model";
import { institutionIdentity, institutionRun } from "../sources/grain";
import styles from "./lens.module.css";

/** The non-finance footprint caption under THE SOURCES (structural facts, never a fetch_live promise). */
const SOURCES_NOTE: Partial<Record<Sector, string>> = {
  mail: "Envelopes only — sender, subject and snippet are cached; bodies and attachments stay at the source.",
};

export function SectorLens({
  sector,
  mergeBankKey,
}: {
  sector: Sector;
  /** Set on /sectors/finance/merges/:bankKey — inserts the confirm-a-merge block. Finance only. */
  mergeBankKey?: string;
}): JSX.Element {
  useTick(); // advance every relative label without a refetch (#62)
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const invalidateConnectors = useInvalidateConnectors();
  const invalidateData = useInvalidateData();

  const connectorsQ = useConnectors();
  const coverage = useSectorCoverage(sector);
  const agentsQ = useAgents();

  const isFinance = sector === "finance";

  /** The CAN-ACT narrowing (#58) — declared here, above every early return, so hook order is stable. */
  const [actNarrow, setActNarrow] = useState("");

  // ── the action catalog (#58) ──
  //
  // `GET /api/actions` is SERVED to the loopback Console now, and this is the read that got it wrong.
  // It used to do `const specs = await api.listActions(sector); specs.length > 0 ? …`. The wire is
  // `{ actions, count, truncated }`, so `.length` was `undefined`, `undefined > 0` is false, and EVERY
  // lens including Home reported "read-only, no actions" — with no error anywhere, because a missing
  // property is not a type error at runtime. The client's retype turned that silent wrong answer into
  // a compile error; this reads the envelope by name, which cannot fail the same way.
  //
  // `truncated` is carried THROUGH to the band, never dropped: the cap cuts an id-sorted list, so a
  // trimmed catalog can be missing a whole trailing domain, and the band offers the narrowing.
  const narrow = actNarrow.trim();
  const actFilter: ActionFilter | undefined = narrow === "" ? undefined : { domain: narrow };
  const actionsQ = useQuery<ActCatalog>({
    // The narrowing is part of the question, so it is part of the key — otherwise a narrowed answer
    // is served from the unnarrowed cache entry and the control appears to do nothing.
    queryKey: ["lens-actions", sector, narrow],
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      try {
        const catalog = await api.listActions(sector, actFilter);
        if (catalog.actions.length > 0) {
          return { kind: "catalog", specs: catalog.actions, truncated: catalog.truncated };
        }
        // An empty answer to a NARROWING says nothing about the sector's capability — calling it
        // "read-only" would be the #58 lie with a filter box in front of it.
        return narrow === "" ? { kind: "readonly" } : { kind: "narrowed-empty", narrow };
      } catch (err) {
        // The ERROR is what matters, not its sentence: `NotServedError.message` is the client's own
        // "Not served — this gateway has no route for …", which the band no longer prints to a person
        // (#106 §2c). The client contract is untouched; the arm just stops carrying the words.
        if (err instanceof NotServedError) return { kind: "not-served" };
        throw err;
      }
    },
  });

  const banksQ = useQuery<FinanceBankSummary[]>({
    queryKey: qk.financeBanks(),
    queryFn: () => api.getFinanceBanks(),
    enabled: isFinance,
    refetchInterval: FRESHNESS_POLL_MS,
    staleTime: 0,
  });

  const candidatesQ = useQuery<FinanceDedupCandidate[]>({
    queryKey: qk.financeDedupCandidates(),
    queryFn: () => api.getFinanceDedupCandidates(),
    enabled: isFinance && mergeBankKey != null,
  });

  const allConnectors = connectorsQ.data;
  const sectorConnectors = useMemo(
    () => (allConnectors ?? []).filter((c) => c.sector === sector && c.status !== "revoked"),
    [allConnectors, sector],
  );

  const [syncing, setSyncing] = useState(false);
  // Declared before any early return so hook order is stable (rules of hooks).
  const [merging, setMerging] = useState(false);
  // #100 item 6 — this used to discard every per-connection result and show an unconditional neutral
  // "Sync requested for X", with a `catch` that could never fire (`allSettled` does not reject): a
  // sector of failed logins reported success. The settled array now goes through
  // `summarizeSectorSync`, which reads the same `ok`/`error`/`timed_out` fields ConnectionDetail
  // already reads for one connection. The invalidations stay UNCONDITIONAL — a partial success
  // still moved data.
  async function onSyncNow(): Promise<void> {
    // Belt-and-braces: the masthead's button is drawn disabled when there is nothing to sync.
    if (sectorConnectors.length === 0) return;
    setSyncing(true);
    try {
      const results = await Promise.allSettled(
        sectorConnectors.map((c) => api.syncNow(c.connectionId)),
      );
      invalidateConnectors();
      invalidateData(sector);
      const summary = summarizeSectorSync(SECTOR_NAME[sector], results);
      toast.show({ message: summary.message, tone: summary.tone });
    } finally {
      setSyncing(false);
    }
  }

  // ── loading / empty ──
  if (connectorsQ.isPending) {
    return (
      <div className={styles.lens}>
        <Skeleton width="60%" height={46} />
        <Skeleton width="100%" height={220} />
        <Skeleton width="100%" height={160} />
      </div>
    );
  }
  if (connectorsQ.isError) {
    return (
      <div className={styles.lens}>
        <ZeroState
          headline="The gate isn’t answering"
          reason="The Console couldn’t read your connections just now. It will retry on its own."
          kind="unconnected"
          action={{ label: "Retry", onAct: () => void connectorsQ.refetch() }}
        />
      </div>
    );
  }
  if (sectorConnectors.length === 0) {
    return (
      <div className={styles.lens}>
        <LensMasthead
          sector={sector}
          verdict={composeVerdict({
            sector,
            connectionCount: 0,
            providerCount: 0,
            agentCount: 0,
            unhealthy: [],
            rollupState: "never_synced",
          })}
          lastSyncedLabel="never"
          transportCaption=""
          onSyncNow={onSyncNow}
          syncing={syncing}
          syncDisabledReason="Nothing to sync — no source is connected here yet."
        />
        <ZeroState
          headline={`No ${SECTOR_NAME[sector]} source connected`}
          reason={`Nothing arrives in ${SECTOR_NAME[sector]} until you connect a source. Your agents see an empty domain until then.`}
          kind="unconnected"
          action={{ label: "Connect a source", onAct: () => navigate("/connect") }}
        />
      </div>
    );
  }

  // ── masthead derivations (all served) ──
  const rollup = freshnessRollup(sectorConnectors);
  const nameOf = (c: ConnectorStatus): string => humanize(c.provider);
  const unhealthy = unhealthyConnections(sectorConnectors, freshnessDisplay, nameOf);
  // `isKeyHolder`, not `!a.revoked_at` (#100 item 4) — an expired key cannot read this domain, so
  // naming it in the CAN-READ lane claimed a reader the auth layer denies.
  const readAgents: ReadAgent[] = (agentsQ.data ?? [])
    .filter((a) => a.sectors.includes(sector) && isKeyHolder(a))
    .map((a) => ({
      agentId: a.agentId,
      lastSeen: a.last_seen_at,
      lastSeenLabel: a.last_seen_at != null ? ago(a.last_seen_at) : null,
    }));

  const verdict = composeVerdict({
    sector,
    connectionCount: sectorConnectors.length,
    providerCount: distinctProviders(sectorConnectors),
    agentCount: readAgents.length,
    unhealthy,
    rollupState: rollup.state,
  });

  // Three DIFFERENT facts, and none of them may wear another's sentence: a read still in flight, a
  // read that FAILED (500 / 403 / a dead loopback), and a gateway with no route. The old default here
  // was the not-served sentence, which was honest while the route did not exist and is a lie now — it
  // would report "this gateway has no route" for an outage and for the first paint of every lens.
  const actions: ActCatalog = actionsQ.data ?? actErrorState(actionsQ.isError, actionsQ.error);

  // ── THE SOURCES ──
  const banks = banksQ.data ?? [];
  const { rows, glossLabel, finance } = isFinance
    ? buildFinanceSources(sectorConnectors, banks, coverage.counts)
    : buildGenericSources(sectorConnectors);

  // ── confirm-a-merge (finance route) ──
  const mergeSides = mergeBankKey != null ? findMergeSides(candidatesQ.data, mergeBankKey) : undefined;
  async function onConfirmMerge(cand: FinanceDedupCandidate): Promise<void> {
    setMerging(true);
    try {
      await api.confirmDedupMerge(
        { connectionId: cand.a.connectionId, sourceObjectId: cand.a.sourceObjectId },
        { connectionId: cand.b.connectionId, sourceObjectId: cand.b.sourceObjectId },
      );
      void qc.invalidateQueries({ queryKey: qk.financeBanks() });
      void qc.invalidateQueries({ queryKey: qk.financeDedupCandidates() });
      invalidateData("finance");
      toast.show({ message: "Merged — served as one account" });
      navigate("/sectors/finance");
    } catch {
      toast.show({ message: "The merge could not be recorded", tone: "error" });
    } finally {
      setMerging(false);
    }
  }

  return (
    // data-sector sets --lens-ink to the sector's own ink (lens.module.css), which the CAN-READ
    // agent dot renders in — Paper draws that dot in the sector ink, not faded (design-law fix).
    <div className={styles.lens} data-sector={sector}>
      <LensMasthead
        sector={sector}
        verdict={verdict}
        lastSyncedLabel={ago(rollup.lastHeardAt)}
        transportCaption={sectorTransportCaption(sectorConnectors)}
        onSyncNow={onSyncNow}
        syncing={syncing}
      />

      <div className={styles.sourcesRegion}>
        <SourcesBand glossLabel={glossLabel} rows={rows} finance={finance} note={SOURCES_NOTE[sector]} />
        {mergeBankKey != null ? (
          <MergeQuestion
            sides={mergeSides ?? null}
            busy={merging}
            onConfirm={() => {
              const cand = findMergeCandidate(candidatesQ.data, mergeBankKey);
              if (cand) void onConfirmMerge(cand);
            }}
            onKeepSeparate={() => navigate("/sectors/finance")}
          />
        ) : null}
      </div>

      <AgentsBand
        readAgents={readAgents}
        actions={actions}
        narrowing={{ value: actNarrow, onChange: setActNarrow }}
      />
      <CoverageBand sector={sector} counts={coverage.counts} />
      <InspectTeaser sector={sector} />
    </div>
  );
}

/**
 * What CAN ACT says while there is no answer yet (#58 / `api/notserved.test.ts`).
 *
 * A `NotServedError` is already resolved INTO the query's data (a `not-served` arm), so anything that
 * reaches here is a genuine failure — an outage, a 403 from the loopback Host guard, a dead gateway —
 * and must not borrow the not-served sentence. The message is the SERVED one or `null`; nothing is
 * invented (the fabricated-reason trap `InspectorPage.test.tsx` pins for the inspector's outage).
 */
export function actErrorState(isError: boolean, error: unknown): ActCatalog {
  if (!isError) return { kind: "loading" };
  return { kind: "error", message: error instanceof Error && error.message ? error.message : null };
}

// ── source view-model builders (pure; exported for tests) ──

/** The generic (non-finance) sources view-model: one row per connection. */
export function buildGenericSources(connectors: ConnectorStatus[]): {
  rows: SourceRowVM[];
  glossLabel: string;
  finance: undefined;
} {
  const rows: SourceRowVM[] = connectors.map((c) => {
    const display = freshnessDisplay(c);
    return {
      key: c.connectionId,
      provider: c.provider,
      name: humanize(c.provider),
      sub: "",
      countLabel: count(c.cached_count),
      transport: transportLabel(c),
      freshness: display,
      clock: ago(display.lastHeardAt),
      manageTo: `/sources/${encodeURIComponent(c.connectionId)}`,
    };
  });
  const providerNames = [...new Set(connectors.map((c) => humanize(c.provider)))];
  const glossLabel = `${count(connectors.length)} connected · ${providerNames.join(" + ")}`;
  return { rows, glossLabel, finance: undefined };
}

/** The finance sources view-model: two provider-aggregate rows + institution run + dedup note/flags. */
export function buildFinanceSources(
  connectors: ConnectorStatus[],
  banks: FinanceBankSummary[],
  counts: Record<string, number> | undefined,
): { rows: SourceRowVM[]; glossLabel: string; finance: FinanceExtras } {
  // Group connections by provider — Plaid is N per-bank connectors, SimpleFIN is one.
  const byProvider = new Map<string, ConnectorStatus[]>();
  for (const c of connectors) {
    const g = byProvider.get(c.provider) ?? [];
    g.push(c);
    byProvider.set(c.provider, g);
  }

  const rows: SourceRowVM[] = [...byProvider.entries()].map(([provider, group]) => {
    const display = freshnessRollup(group);
    const n = group.length;
    let sub: string;
    let countLabel: string;
    if (provider === "plaid") {
      sub = `${count(n)} bank${n === 1 ? "" : "s"}, each its own connection`;
      countLabel = `${count(n)} bank${n === 1 ? "" : "s"}`;
    } else if (provider === "simplefin") {
      sub = "one link · banks chosen at SimpleFIN Bridge";
      countLabel = n === 1 ? "one link" : `${count(n)} links`;
    } else {
      sub = `${count(n)} connection${n === 1 ? "" : "s"}`;
      countLabel = `${count(n)} connection${n === 1 ? "" : "s"}`;
    }
    return {
      key: provider,
      provider,
      name: humanize(provider),
      sub,
      countLabel,
      transport: transportLabel(group[0]),
      freshness: display,
      clock: ago(display.lastHeardAt),
      // A provider aggregate has no single connection page; its per-bank connections nest on Sources
      // — so Manage lands ON that provider's group there rather than at the top of the page (#112).
      manageTo: sourceGroupHref(group[0]),
    };
  });

  const MAX_SHOWN = 9;
  // #111, second consumer. `banks` is ONE ROW PER ACCOUNT IDENTITY (canonical institution × last-4 ×
  // currency), so its length is an ACCOUNT count wearing an institution's field name — which is how
  // this lens printed an ACCOUNT count under the word "institutions", over far fewer banks, and repeated the
  // same institution once per card. `institutionRun` is the ONE fold (grain.ts), keyed on the stable
  // `orgDomain` rather than on a display string, because counting distinct strings is right on one box
  // and wrong for anyone whose provider spells a bank two ways. Its docstring already says every
  // surface saying "institutions" reads it from here; this lens was the surface that did not, and the
  // fold shipping in `pages/sources/` while this file kept its own derivation is exactly the
  // three-places problem #91 is about.
  const run = institutionRun(banks);
  const institutions = run.slice(0, MAX_SHOWN).map((i) => i.name);
  const moreCount = Math.max(0, run.length - MAX_SHOWN);
  // The overflow must count and land on the SAME grain, or "and N more" promises institutions and
  // delivers account rows. Hidden = every bank belonging to an institution past the shown run, so the
  // landing below still resolves through a real hidden CONNECTION (#112) while the number above it
  // counts institutions.
  const hiddenIds = new Set(run.slice(MAX_SHOWN).map((i) => i.id));
  const hiddenBanks = banks.filter((b) => hiddenIds.has(institutionIdentity(b)));

  // Where "and N more →" lands (#112). Precisely: the group holding the first hidden bank whose
  // connection THIS SECTOR actually serves — which is NOT always the first hidden institution. Two
  // reasons, both ordinary: a bank the wire names may have no connector in this list at all (an
  // errored read, a revoked row), and a DEDUPED bank contributes several providers, so the scan can
  // pick the SimpleFIN side of a merged bank where the Plaid side came first. That is the right
  // behaviour — the reader is being sent to a real group holding a real hidden connection, and
  // picking one side of a merge over the other is not a fact this surface is entitled to decide.
  // A bank names its providers with each one's connectionId, so this is a lookup, never a
  // re-derivation of dedup — and when nothing hidden resolves to a connector, it falls back to the
  // bare page rather than to a dead fragment.
  const byConnection = new Map(connectors.map((c) => [c.connectionId, c]));
  const moreFrom = hiddenBanks
    .flatMap((b) => b.providers)
    .map((p) => byConnection.get(p.connectionId))
    .find((c): c is ConnectorStatus => c != null);
  const moreTo = moreFrom ? sourceGroupHref(moreFrom) : "/sources";

  const merged = mergedBanks(banks);
  const mergedNote =
    merged.length > 0
      ? `${count(merged.length)} account${merged.length === 1 ? "" : "s"} deduped — ${merged
          .map((b) => b.institution)
          .join(", ")}, served as one.`
      : null;

  const trustFlags: TrustFlag[] = [
    ...banks
      .filter((b) => b.possibleDuplicate?.confirmable)
      .map((b): TrustFlag => ({ kind: "possible", institution: b.institution, bankKey: b.bankKey })),
    // #100 item 7 — the backend has always computed and served `unmergedDuplicate` (the alias gap:
    // same mask, ≥2 disagreeing canonical institutions) and NO surface in apps/web read it after the
    // port. This restores a served signal; it invents nothing, and nothing is computed client-side.
    // A card may legitimately carry both `unmergedDuplicate` and `classConflict` — different facts
    // about different pairs — so both rows render; they are not de-duplicated.
    ...banks
      .filter((b) => b.unmergedDuplicate)
      .map((b): TrustFlag => ({ kind: "unmerged", institution: b.institution, bankKey: b.bankKey })),
    ...banks
      .filter((b) => b.classConflict)
      .map((b): TrustFlag => ({ kind: "conflict", institution: b.institution })),
    ...banks
      .filter((b) => b.confirmationSuspended)
      .map((b): TrustFlag => ({
        kind: "suspended",
        institution: b.institution,
        reason: b.confirmationSuspended!.reason,
      })),
  ];

  const accounts = counts?.["finance.account"];
  const pCount = distinctProviders(connectors);
  const glossLabel =
    `${count(pCount)} provider${pCount === 1 ? "" : "s"} · ${count(connectors.length)} connection${connectors.length === 1 ? "" : "s"}` +
    (accounts != null ? ` · ${count(accounts)} account${accounts === 1 ? "" : "s"}` : "") +
    ` across ${count(run.length)} institution${run.length === 1 ? "" : "s"}`;

  return { rows, glossLabel, finance: { institutions, moreCount, moreTo, mergedNote, trustFlags } };
}

// ── confirm-a-merge join: bankKey EQUALITY only, zero FE dedup logic (build-notes §12.3) ──

/** The candidate whose flagged pair spans this bankKey (either side). */
export function findMergeCandidate(
  candidates: FinanceDedupCandidate[] | undefined,
  bankKey: string,
): FinanceDedupCandidate | undefined {
  return (candidates ?? []).find((c) => c.aBankKey === bankKey || c.bBankKey === bankKey);
}

/** The two candidate sides for the confirm block, only from served fields (balance/class are NOT
 *  on the candidate wire, so they are not shown). Returns null when no pair matches the key. */
export function findMergeSides(
  candidates: FinanceDedupCandidate[] | undefined,
  bankKey: string,
): [MergeSideVM, MergeSideVM] | null {
  const cand = findMergeCandidate(candidates, bankKey);
  if (!cand) return null;
  const currency = cand.currency ?? undefined;
  const sideVM = (s: FinanceDedupCandidate["a"]): MergeSideVM => {
    const parts: string[] = [];
    if (currency) parts.push(currency);
    parts.push(s.mask ? `••••${s.mask}` : "no last-4 published");
    return {
      providerLabel: `via ${humanize(s.provider)}`,
      name: s.name ?? s.institutionName ?? "Unnamed account",
      detail: parts.join(" · "),
    };
  };
  return [sideVM(cand.a), sideVM(cand.b)];
}

export type { FreshnessDisplay };
