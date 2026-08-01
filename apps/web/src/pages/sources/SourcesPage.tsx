// Sources — the all-sectors connections ledger (1FN-0 · FQ4-0).
//
// Structure (build-notes §6): a header for the credential/app you'd remove to kill them all, with its
// connections nested. Fan-out credentials (iCloud → mail·calendar·contacts) and the Plaid app (→ N
// banks) nest their rows; single-connection providers stay flat. Finance is joined from the
// banks-by-institution wire (#33). No AttentionBanner band here — on Sources the rows ARE the banner
// (§14.3 rule 1); the masthead sentence goes exceptions-first and the header meta counts what needs
// you. Freshness is read from `freshnessDisplay`, never recomputed.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Masthead } from "../../shell";
import { ConfirmBar, Skeleton, useToast } from "../../kit";
import { InstitutionMark, ProviderTile } from "../../marks";
import {
  useConnectors,
  useFinanceBanks,
  useInvalidateConnectors,
  useInvalidateData,
} from "../../api/hooks";
import { api } from "../../api/client";
import { freshnessDisplay } from "../../api/freshness";
import { plural } from "../../api/format";
import type { FinanceBankSummary, Sector } from "../../api/types";
import {
  cadenceCell,
  coverageNoun,
  groupConnectors,
  groupHealth,
  groupUnhealthyCount,
  lastHeardCell,
  plaidGroupCadence,
  providerDisplay,
  providerSub,
  providerTileId,
  sourceGroupAnchorId,
  sourcesSummary,
  SECTOR_LABEL,
  type Cell,
  type ProviderGroup,
} from "./model";
// The ONE revoked filter, beside the ONE tally the masthead's two numbers come from (#91).
import { liveConnectors } from "./grain";
import { readOauthReturn, withoutOauthReturn, oauthReturnToast } from "./oauthReturn";
import { plaidBankRows, simplefinInstitutions, type PlaidBankRow } from "./financeModel";
import styles from "./SourcesPage.module.css";

const SECTOR_RANK: Record<Sector, number> = {
  mail: 0,
  calendar: 1,
  contacts: 2,
  finance: 3,
  health: 4,
  home: 5,
};

/** How many Plaid bank rows show before the "Show the other N banks →" expander. */
const PLAID_PREVIEW = 4;

// ── shared cells ───────────────────────────────────────────────────────────

function CoverageCell({ text }: { text: string }): JSX.Element {
  return <div className={`${styles.colCoverage} ${styles.cellCoverage}`}>{text}</div>;
}
function CadenceCell({ cell }: { cell: Cell }): JSX.Element {
  return (
    <div className={`${styles.colCadence} ${styles.cellCadence} ${cell.alarm ? styles.cellAlarm : ""}`}>
      {cell.text}
    </div>
  );
}
function HeardCell({ cell }: { cell: Cell }): JSX.Element {
  return (
    <div className={`${styles.colHeard} ${styles.cellHeard} ${cell.alarm ? styles.cellAlarm : ""}`}>
      {cell.text}
    </div>
  );
}
function ManageCell({
  connectionId,
  reconnect = false,
}: {
  connectionId: string;
  reconnect?: boolean;
}): JSX.Element {
  // reconnect_kind is not served (#89/#73): a broken row's "Reconnect →" cannot know the custody
  // flow, so it navigates to the connection's own page (the "Manage this connection →" fallback)
  // rather than guessing.
  return (
    <div className={styles.colManage}>
      <Link
        to={`/sources/${encodeURIComponent(connectionId)}`}
        className={`${styles.manageLink} ${reconnect ? styles.manageStrong : ""}`}
      >
        {reconnect ? "Reconnect →" : "Manage →"}
      </Link>
    </div>
  );
}

// ── the small-caps column header ────────────────────────────────────────────

function LedgerHead(): JSX.Element {
  return (
    <div className={styles.head}>
      <div className={styles.marker} />
      <div className={`${styles.headName} ${styles.headLabel}`}>Credential · connection</div>
      <div className={`${styles.colCoverage} ${styles.headLabel}`}>Coverage</div>
      <div className={`${styles.colCadence} ${styles.headLabel}`}>Cadence</div>
      <div className={`${styles.colHeard} ${styles.headLabel}`}>Last heard</div>
      <div className={`${styles.colManage} ${styles.headLabel}`}>Manage</div>
    </div>
  );
}

// ── the group header's dot + meta + actions ─────────────────────────────────

function GroupDot({ health }: { health: "ok" | "partial" | "down" }): JSX.Element {
  const cls = health === "ok" ? styles.dotOk : health === "partial" ? styles.dotPartial : styles.dotDown;
  return <div className={`${styles.dot} ${cls}`} aria-hidden="true" />;
}

// ── a fan-out credential group (iCloud / Microsoft / Google) ────────────────

function FanoutGroup({
  group,
  anchorId,
  arrived,
  onRemove,
}: {
  group: ProviderGroup;
  /** The landing anchor for "and N more →" (#112) — see `sourceGroupAnchorId`. */
  anchorId: string;
  /** True while this is the group the reader was sent to — the arrival mark (#112). */
  arrived: boolean;
  onRemove: (g: ProviderGroup) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const health = groupHealth(group.connectors);
  const tileId = providerTileId(group.provider);
  const sorted = [...group.connectors].sort(
    (a, b) => (SECTOR_RANK[a.sector as Sector] ?? 9) - (SECTOR_RANK[b.sector as Sector] ?? 9),
  );

  // Header meta: healthy names the fan-out; down names the served problem (in seal); partial counts.
  //
  // Every count-with-noun goes through `plural` (#92). Both sector clauses read n > 1 today only
  // because `groupConnectors` sets kind="fanout" above one sector — the same borrowed safety that let
  // the Plaid header ship "feeds 1 banks", so neither is left depending on the grouping rule.
  let meta: string;
  let metaDown = false;
  if (health === "ok") {
    meta = `feeds ${plural(group.connectors.length, "sector")}`;
  } else if (health === "down") {
    const rep = group.connectors.find((c) => freshnessDisplay(c).caption) ?? group.connectors[0];
    const d = freshnessDisplay(rep);
    meta = d.caption || "needs you";
    metaDown = true;
  } else {
    const held = groupUnhealthyCount(group.connectors);
    meta = `feeds ${plural(group.connectors.length, "sector")} · ${group.connectors.length - held} flowing, ${held} held`;
  }

  return (
    // `tabIndex={-1}` = the arrival target (#112 — see the page's arrival effect): programmatic focus
    // only, never a new tab stop, and unconditional so focusability cannot drift from the mark.
    <div className={`${styles.group} ${arrived ? styles.arrived : ""}`} id={anchorId} tabIndex={-1}>
      <div className={styles.credHead}>
        <div className={styles.provIcon}>
          {tileId ? <ProviderTile provider={tileId} size={24} /> : null}
        </div>
        <div className={styles.credTitle}>
          <div className={styles.credName}>{providerDisplay(group.provider)}</div>
          <div className={styles.credSub}>{providerSub(group.provider)}</div>
        </div>
        <div className={styles.credSpacer} />
        <div className={`${styles.credMeta} ${metaDown ? styles.credMetaDown : ""}`}>{meta}</div>
        <GroupDot health={health} />
        <button
          type="button"
          className={`${styles.credAction} ${health !== "ok" ? styles.credActionStrong : ""}`}
          onClick={() => navigate(`/sources/${encodeURIComponent(sorted[0].connectionId)}`)}
        >
          Reconnect
        </button>
        <span className={styles.credActionSep} aria-hidden="true">
          ·
        </span>
        <button
          type="button"
          className={styles.credAction}
          onClick={() => onRemove(group)}
          disabled={!group.credentialId}
          aria-disabled={group.credentialId ? undefined : true}
        >
          Remove
        </button>
      </div>

      {sorted.map((c) => (
        <div className={styles.row} key={c.connectionId}>
          <div className={styles.marker}>
            <span className={styles.dash} aria-hidden="true" />
          </div>
          <div className={styles.rowName}>{SECTOR_LABEL[c.sector as Sector] ?? c.sector}</div>
          <CoverageCell text={coverageNoun(c.sector, c.cached_count)} />
          <CadenceCell cell={cadenceCell(c)} />
          <HeardCell cell={lastHeardCell(c)} />
          <ManageCell connectionId={c.connectionId} />
        </div>
      ))}
    </div>
  );
}

// ── the Plaid group (one app, many bank connections) ────────────────────────

function BankRow({ bank }: { bank: PlaidBankRow }): JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.marker}>
        <span className={styles.dash} aria-hidden="true" />
      </div>
      <div className={styles.bankName}>
        {/* `orgDomain` is the stable identifier the mark resolves on (marks/institutions.ts rule 1);
            dropping it here demotes the row to the display-name fallback. */}
        <InstitutionMark institution={bank.institution} orgDomain={bank.orgDomain} size={22} />
        <span className={styles.bankNameText}>{bank.institution}</span>
        {bank.mask ? <span className={styles.bankMask}>••••{bank.mask}</span> : null}
        {bank.mergedNote ? <span className={styles.bankMerged}>{bank.mergedNote}</span> : null}
      </div>
      <CoverageCell text={bank.coverage} />
      {/* The bank's own inherited schedule — displaced only by a consent lapse (§18.2). */}
      <CadenceCell cell={bank.cadence} />
      <HeardCell cell={bank.lastHeard} />
      <ManageCell connectionId={bank.connectionId} reconnect={bank.needsReconnect} />
    </div>
  );
}

function PlaidGroup({
  group,
  anchorId,
  arrived,
  banks,
  banksError,
}: {
  group: ProviderGroup;
  anchorId: string;
  arrived: boolean;
  banks: FinanceBankSummary[];
  banksError: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const health = groupHealth(group.connectors);
  // The connectors themselves, not just their ids: each bank row inherits its own connector's
  // cadence cell (§18.2), which an id set cannot supply.
  const rows = useMemo(() => plaidBankRows(banks, group.connectors), [banks, group.connectors]);
  const shown = expanded ? rows : rows.slice(0, PLAID_PREVIEW);
  const hidden = rows.length - shown.length;

  // THE #92 SITE. One connected bank printed "feeds 1 banks" on the live Console — reachable at n = 1
  // today, because `pages/sources/model.ts` draws the Plaid group whenever there is at least one Plaid
  // connector. Both branches go through the ONE count-with-noun rule (`plural`, api/format.ts).
  let meta: string;
  if (health === "ok") {
    meta = `feeds ${plural(group.connectors.length, "bank")} · ${plaidGroupCadence(group.connectors)}`;
  } else {
    const held = groupUnhealthyCount(group.connectors);
    meta = `feeds ${plural(group.connectors.length, "bank")} · ${group.connectors.length - held} flowing, ${held} lapsed`;
  }

  return (
    // `tabIndex={-1}` = the arrival target (#112 — see the page's arrival effect): programmatic focus
    // only, never a new tab stop, and unconditional so focusability cannot drift from the mark.
    <div className={`${styles.group} ${arrived ? styles.arrived : ""}`} id={anchorId} tabIndex={-1}>
      <div className={styles.credHead}>
        <div className={styles.provIcon}>
          <ProviderTile provider="plaid" size={24} />
        </div>
        <div className={styles.credTitle}>
          <div className={styles.credName}>Plaid</div>
          <div className={styles.credSub}>{providerSub("plaid")}</div>
        </div>
        <div className={styles.credSpacer} />
        <div className={styles.credMeta}>{meta}</div>
        <GroupDot health={health} />
        <Link to="/connect/plaid" className={styles.credAction}>
          Add a bank
        </Link>
        <span className={styles.credActionSep} aria-hidden="true">
          ·
        </span>
        <Link to="/settings" className={styles.credAction}>
          Edit app
        </Link>
      </div>

      {shown.map((bank) => (
        <BankRow bank={bank} key={bank.rowKey} />
      ))}

      {/* An errored banks read leaves `plaidBankRows` empty, so the header would sit over nothing.
          Say what is missing and what is still true (§7) rather than rendering an empty group. */}
      {banksError && rows.length === 0 ? (
        <div className={styles.moreRow}>
          <div className={styles.marker} />
          <div className={styles.bankReadFailed}>
            Bank names couldn&rsquo;t be read. {group.connectors.length} Plaid{" "}
            {group.connectors.length === 1 ? "connection is" : "connections are"} still linked —
            reload to try again.
          </div>
        </div>
      ) : null}

      {hidden > 0 ? (
        <div className={styles.moreRow}>
          <div className={styles.marker} />
          <button type="button" className={styles.moreButton} onClick={() => setExpanded(true)}>
            Show the other {hidden} {hidden === 1 ? "bank" : "banks"} →
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── a flat single-connection provider (SimpleFIN / Whoop / Apple Health / HA / Gmail) ──

function FlatGroup({
  group,
  anchorId,
  arrived,
  banks,
  banksError,
}: {
  group: ProviderGroup;
  anchorId: string;
  arrived: boolean;
  banks: FinanceBankSummary[];
  banksError: boolean;
}): JSX.Element {
  const c = group.connectors[0];
  const tileId = providerTileId(group.provider);
  const isSimplefin = group.provider === "simplefin";
  // A failed banks read yields no institutions, and `simplefinInstitutions` would answer a derived
  // "0 accounts" beside a healthy dot. Fall back to the connector's OWN served row count — a real
  // number from a read that succeeded, not a zero from one that did not (§7).
  const orgs = useMemo(
    () => (isSimplefin && !banksError ? simplefinInstitutions(banks, c.connectionId) : null),
    [isSimplefin, banksError, banks, c.connectionId],
  );
  // Converted to `plural` alongside the four #92 sites: byte-identical output, one fewer hand-rolled
  // guard in the file that shipped the missed one.
  const coverage = orgs ? plural(orgs.totalAccounts, "account") : coverageNoun(c.sector, c.cached_count);

  return (
    // `tabIndex={-1}` = the arrival target (#112 — see the page's arrival effect): programmatic focus
    // only, never a new tab stop, and unconditional so focusability cannot drift from the mark.
    <div className={`${styles.group} ${arrived ? styles.arrived : ""}`} id={anchorId} tabIndex={-1}>
      <div className={styles.flatHead}>
        <div className={styles.provIcon}>
          {tileId ? <ProviderTile provider={tileId} size={26} /> : null}
        </div>
        <div className={styles.flatTitle}>
          <div className={styles.flatName}>{providerDisplay(group.provider)}</div>
          <div className={styles.credSub}>{providerSub(group.provider)}</div>
        </div>
        <CoverageCell text={coverage} />
        <CadenceCell cell={cadenceCell(c)} />
        <HeardCell cell={lastHeardCell(c)} />
        <ManageCell connectionId={c.connectionId} />
      </div>

      {/* INSTITUTION-grained, not card-grained (#111): the wire serves one row per institution × card,
          so this line named Amex once per card and then said "One link carries all 3". Both the run and
          the number come from the one institution tally. */}
      {orgs && orgs.institutions.length > 0 ? (
        <div className={styles.institutions}>
          <div className={styles.marker} />
          <div className={styles.institutionsBody}>
            <div className={styles.institutionsList}>
              <span className={styles.institutionsNames}>
                {orgs.institutions.map((i) => i.name).join(" · ")}
              </span>
              {orgs.anyMerged ? (
                <span className={styles.institutionsMerged}>(merged above)</span>
              ) : null}
            </div>
            <div className={styles.institutionsBridge}>
              One link carries{" "}
              {orgs.institutions.length === 1 ? "it" : `all ${orgs.institutions.length}`} — which banks
              are in it is chosen at SimpleFIN Bridge ↗
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── the page ─────────────────────────────────────────────────────────────────

export function SourcesPage(): JSX.Element {
  const connectorsQ = useConnectors();
  const banksQ = useFinanceBanks();
  const invalidateConnectors = useInvalidateConnectors();
  const invalidateData = useInvalidateData();
  const toast = useToast();

  const [removeGroup, setRemoveGroup] = useState<ProviderGroup | null>(null);

  const removeMutation = useMutation({
    mutationFn: (g: ProviderGroup) => {
      // The group represents ONE proven credential (grouped by the served credentialId, not by the
      // provider string) and its connectors ARE that credential's connectors — so revoking exactly
      // `g.credentialId` matches the blast radius the ConfirmBar showed. A group with no resolved
      // credentialId is never offered Remove (see FanoutGroup), so this is defensive only.
      if (!g.credentialId) {
        return Promise.reject(new Error("This credential could not be resolved — open the connection to remove it."));
      }
      return api.revokeCredential(g.credentialId);
    },
    onSuccess: (res) => {
      setRemoveGroup(null);
      invalidateConnectors();
      invalidateData();
      toast.show({ tone: "ok", message: `Revoked ${providerDisplay(res.provider)} — ${res.revokedConnectors.length} disconnected.` });
    },
    onError: (err) => {
      toast.show({ tone: "error", message: err instanceof Error ? err.message : "Revoke failed." });
    },
  });

  // ── the consent return (#96 §1.5) ────────────────────────────────────────
  // A completed OAuth consent 302s here carrying `credential_id` + `provider` (ids only, never a
  // token). Nothing read them until 2026-07-25, so a consent that HAD created the credential looked
  // like a failure. We announce the sectors the gateway ACTUALLY activated, then strip the params.
  const [searchParams, setSearchParams] = useSearchParams();
  const oauthReturn = readOauthReturn(searchParams);
  const announced = useRef(false);

  useEffect(() => {
    if (!oauthReturn || announced.current) return;
    // Wait for the SERVED truth before naming sectors — announcing off an empty cache would report
    // "granted no sectors" for every successful consent. An ERRORED read is the same trap wearing a
    // different mask: `data` is undefined, so the labels come out empty and we would tell the user
    // to go fix the scopes on an app whose consent in fact SUCCEEDED (the 302 is the last statement
    // of `oauthCallback` — the credential and its connectors exist). "We failed to read" is not
    // "there is nothing there". Leave `announced` UNSET so a recovered read still announces.
    if (connectorsQ.isLoading || connectorsQ.isError) return;
    announced.current = true;
    // `status === "active"` only: a scope-reduced re-consent PAUSES the uncovered siblings
    // (oauth-routes.ts), and a paused sector is not something this consent covers.
    const labels = liveConnectors(connectorsQ.data ?? [])
      .filter((c) => c.credentialId === oauthReturn.credentialId && c.status === "active")
      .map((c) => SECTOR_LABEL[c.sector as Sector] ?? c.sector);
    toast.show(oauthReturnToast(oauthReturn.provider, labels));
    // Strip the params so a refresh cannot re-announce a consent that already landed.
    setSearchParams(withoutOauthReturn(searchParams), { replace: true });
    // Deps are the RETURN's identity plus BOTH gates, deliberately narrow: `searchParams` and
    // `connectorsQ.data` change identity on every settle, and the effect is already idempotent by
    // construction — the `announced` ref makes a re-render inert however react-query lands.
    // `isError` must be a dep: a failed read that later succeeds flips only that flag (`isLoading`
    // stays false once the query has settled once), and without it the recovered read would never
    // announce at all.
  }, [oauthReturn?.credentialId, oauthReturn?.provider, connectorsQ.isLoading, connectorsQ.isError]);

  const groups = useMemo(() => {
    // credentialId is served on every list row (core toStatus), so grouping by the true credential
    // boundary is synchronous — no detail fetch, no resolution race. groupConnectors keys non-Plaid
    // by that served credentialId and Plaid by app (its Items each own a credential; §12.1).
    //
    // `liveConnectors` first: `revokeCredential` deliberately KEEPS the connector rows and the list
    // serves them, so without the filter a removed connection paints a green dot and a cadence it is
    // not on (#96 §5). A revoked connector is gone, not unhealthy — the Gatehouse hides it too.
    return connectorsQ.data ? groupConnectors(liveConnectors(connectorsQ.data)) : [];
  }, [connectorsQ.data]);
  const summary = useMemo(() => sourcesSummary(groups), [groups]);

  // ── the arrival (#112) ───────────────────────────────────────────────────
  // A surface that links to one provider's group lands here with that group's id in the fragment.
  //
  // The SCROLL has to be ours: the group does not exist at the moment the fragment is applied — it
  // appears when the connections read settles — so the browser's own scroll-to-fragment finds
  // nothing. Hence the effect, and hence the group count in its deps: the effect must re-run when the
  // group finally renders.
  //
  // ONCE PER FRAGMENT, not once per re-run. `groups.length` in the deps made every change in group
  // count a second arrival: land via "and N more →", scroll off to a different group, remove a
  // credential — the count drops, the effect fires again and the viewport is yanked back to a
  // fragment the reader left on purpose. The ref is the fix; the dep stays, because without it a
  // group that appears after the first run is never scrolled to at all.
  //
  // FOCUS travels with the scroll. A scroll alone is invisible to a non-sighted reader — nothing is
  // announced and nothing moves — so the group is a `tabIndex={-1}` target (programmatic focus, NOT
  // a new tab stop) and gets focus with `preventScroll`, letting the browser's own scroll positioning
  // stand rather than fighting it.
  //
  // The HIGHLIGHT reads the same fragment through the router instead of through CSS `:target`. That
  // was the first shape of this and it is the trap: react-router navigates with `history.pushState`,
  // whose effect on the document's target element is inconsistent across engines, so the mark would
  // silently do nothing on some browsers — and be untestable here either way, since jsdom applies no
  // stylesheet. Read through the router it is one comparison, verifiable, and identical everywhere.
  //
  // HOW LONG THE MARK STANDS, decided: for as long as the fragment does — until the reader navigates
  // (a link, a back, a Remove that lands them elsewhere). It is deliberately NOT scroll-tracked. A
  // scroll listener that cleared the fragment would be ambient behaviour reacting to the reader, and
  // this design's answer to motion is stillness (soul §7); it would also throw away a durable
  // address, so a reload or a shared URL would no longer arrive anywhere. No timer and no fade for
  // the same reason.
  const { hash } = useLocation();
  const arrivedId = hash.startsWith("#") ? hash.slice(1) : hash;
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!arrivedId) {
      scrolledTo.current = null;
      return;
    }
    if (scrolledTo.current === arrivedId) return;
    const el = document.getElementById(arrivedId);
    if (!el) return; // the group has not rendered yet — the connections read is still in flight
    scrolledTo.current = arrivedId;
    // jsdom implements no layout, so `scrollIntoView` is absent there — the guard keeps a component
    // test from failing on the environment rather than on the behaviour it is checking. `focus` does
    // exist in jsdom, which is what makes the announcement half assertable.
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
  }, [arrivedId, groups.length]);

  const banks = banksQ.data ?? [];
  // Errored AND empty, never errored alone. `useFinanceBanks` POLLS (api/hooks.ts refetchInterval),
  // and react-query KEEPS the last good `data` while flipping `isError` on a failed refetch — which
  // is the commonest way this flag is ever true here, more common than the initial-load failure. On
  // `isError` alone we would print "Account counts and bank names are missing below" directly above
  // the bank names, and throw away a real cached "3 accounts" for the connector's coarser
  // `cached_count`. A stale bank list is still the truth we last heard; only an EMPTY one is a
  // missing answer (#96 §7).
  const banksError = banksQ.isError && banks.length === 0;

  // The count chip prints FIGURES, unlike the italic sentence beside it: the design spells structural
  // counts in prose and prints them in the mono meta (`1L1-0`: "7 providers · 24 connections").
  //
  // `sources` is the grain module's name for this number; "providers" is this page's noun for it, and
  // the Gatehouse prints the very same tally as "sources" (#91). Both nouns go through the ONE
  // count-with-noun rule (`plural`, #92) — hand-rolled, this chip read "1 providers · 4 connections"
  // for the ordinary new-user shape, one credential fanned across four sectors, which is the same
  // defect as "feeds 1 banks" one section below on this same page.
  const countLine = (
    <span className={styles.count}>
      {plural(summary.sources, "provider")} · {plural(summary.connections, "connection")}
      {summary.needsYou > 0 ? (
        <>
          {" · "}
          <span className={styles.countNeed}>{summary.needsYou} need you</span>
        </>
      ) : null}
    </span>
  );

  return (
    <div className={styles.page}>
      <Masthead
        kicker="The gate"
        verdict="Sources"
        sub={connectorsQ.isLoading ? "Reading your connections…" : summary.sentence}
        right={
          <div className={styles.mastheadRight}>
            <Link to="/connect" className={styles.addSource}>
              Add a source
            </Link>
            {connectorsQ.isLoading ? <Skeleton width="180px" height={16} /> : countLine}
          </div>
        }
      />

      {/* The banks read is a SECOND read; when it fails the connections themselves are still true,
          so we say exactly what is missing rather than rendering its absence as zero (§7). */}
      {banksError && !connectorsQ.isError ? (
        <div className={styles.errorNote}>
          Postern couldn&rsquo;t read your bank accounts.{" "}
          {banksQ.error instanceof Error ? `${banksQ.error.message} ` : ""}
          Account counts and bank names are missing below — your connections themselves are
          unaffected.
        </div>
      ) : null}

      {connectorsQ.isError ? (
        <div className={styles.errorNote}>
          The gateway didn&rsquo;t answer the connections read.{" "}
          {connectorsQ.error instanceof Error ? connectorsQ.error.message : ""}
        </div>
      ) : connectorsQ.isLoading ? (
        <div className={styles.loadingBlock}>
          <Skeleton lines={4} height={20} />
        </div>
      ) : groups.length === 0 ? (
        <ZeroSources />
      ) : (
        <div className={styles.table}>
          <LedgerHead />
          {groups.map((g) => {
            // Two same-provider credential groups share a provider string, so the credentialId is the
            // stable key; Plaid's group (undefined credentialId) keys on the provider.
            const key = g.credentialId ?? g.provider;
            // The landing anchor (#112), derived from a MEMBER of the group rather than from the
            // group's own fields — that is the same input the linking surfaces have (they hold
            // connections, never groups), so the two cannot key differently. Every member of a group
            // yields the same id by construction; `model.test.ts` pins that over every group shape.
            const anchorId = sourceGroupAnchorId(g.connectors[0]);
            return g.kind === "fanout" ? (
              <FanoutGroup key={key} group={g} anchorId={anchorId} arrived={anchorId === arrivedId} onRemove={setRemoveGroup} />
            ) : g.kind === "plaid" ? (
              <PlaidGroup
                key={key}
                group={g}
                anchorId={anchorId}
                arrived={anchorId === arrivedId}
                banks={banks}
                banksError={banksError}
              />
            ) : (
              <FlatGroup
                key={key}
                group={g}
                anchorId={anchorId}
                arrived={anchorId === arrivedId}
                banks={banks}
                banksError={banksError}
              />
            );
          })}
        </div>
      )}

      {removeGroup ? (
        // KEYED BY TARGET (#134 fix round, B1): this is ONE conditional slot serving whichever
        // group is being removed. Without the key, clicking Remove on group B while group A's
        // confirm is open RE-RENDERS the same ConfirmBar instance — the mount scroll never
        // re-fires (the bar sits off-screen, the original symptom) and worse, an armed typed
        // token for A survives into B's confirm. The key is the same credential identity the
        // ledger groups by, so a retarget is a REMOUNT: scrolled again, typed box empty, disarmed.
        <div className={styles.confirmHost} key={removeGroup.credentialId ?? removeGroup.provider}>
          <ConfirmBar
            verb={`Revoke ${providerDisplay(removeGroup.provider)}`}
            consequence={`Revoke the ${providerDisplay(removeGroup.provider)} credential`}
            blastRadius={`Disconnects ${removeGroup.connectors
              .map((c) => SECTOR_LABEL[c.sector as Sector] ?? c.sector)
              .join(", ")} and deletes the shared credential from the vault. This cannot be undone.`}
            requireTyped={providerDisplay(removeGroup.provider)}
            busy={removeMutation.isPending}
            onConfirm={() => removeMutation.mutate(removeGroup)}
            onCancel={() => setRemoveGroup(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

function ZeroSources(): JSX.Element {
  return (
    <div className={styles.loadingBlock}>
      <div className={styles.zeroNote}>
        No sources connected yet. Add one to give an agent something to read.
      </div>
      <Link to="/connect" className={styles.addSource}>
        Add a source
      </Link>
    </div>
  );
}
