// One sector card on the Gatehouse register. Ported from `Card Finance` (`3ON-0`) and its five
// siblings.
//
// The card can FALSIFY the verdict (a source here going stale is what the glance exists to catch), so
// it earns its place (#63). Everything on it is SERVED:
//   - coverage figure  ← useSectorCoverage (the query() aggregate — service truth, dedup-correct,
//                         NEVER a sum of per-connection cached_count which triple-counts a merged
//                         finance account, #60). `undefined` while loading → <Skeleton>, never an
//                         em-dash at figure size.
//   - each source's freshness ← the SERVED renderer (freshnessDisplay). Healthy is quiet (its
//                         caption, no badge); an exception shows its toned word. No timestamp is
//                         compared here.
//   - "read by N agents" ← grants (config, complete), passed down from the register.
//
// The card is one of the two surfaces where the sector IS THE SUBJECT, so it renders the full
// <SectorSpecimen> — the botanical drawing with stem and leaves — under its Latin binomial, NOT a
// scaled <SectorChip> (build-notes §11.3 two tiers; the substitution §19.1 post-mortems). The slot
// below is 40×48: taller than wide, because it was always laid out for a stemmed plant.
//
// There is NO dot top-right. It carried the sector's own ink and was defended as identity-not-state
// — but two sector inks ARE state inks (`--sector-finance` is `--state-attention`, `--sector-calendar`
// is `--state-ok`), so a healthy gate showed an amber dot on Finance in the canonical status
// position, beside a masthead reading "nothing needs your attention". The proof it was noise: the
// needs-attention board carried the same six dots, unchanged. A colour may encode identity OR state,
// never both (§17.1) — and nothing is lost, because the card already names its sector three times
// (specimen, name, binomial), while `ok` earns no badge at all (§14.1a).
//
// "can act" (home only) is the architectural fact that home's connector exposes actions; the action
// COUNT ("12 actions") needs the unserved catalog (#89/§16.2) and is deliberately withheld.

import { Link } from "react-router-dom";
import { SectorSpecimen, ProviderTile } from "../../marks";
import { Skeleton } from "../../kit";
import { count } from "../../api/format";
import { useSectorCoverage } from "../../api/hooks";
import { sourceGroupHref } from "../sources/model";
import type { ConnectorStatus, Sector } from "../../api/types";
import {
  SECTOR_META,
  groupSectorSources,
  providerMark,
  sectorAgentsClause,
  type SectorSourceGroup,
} from "./helpers";
import styles from "./SectorCard.module.css";

/** ONE row per PROVIDER, not per connection (#100 item 8). A 14-bank Plaid user used to get
 *  fourteen rows all reading "Plaid"; now the count cell carries what the repetition was trying to
 *  say, and only when there is more than one connection behind the name. */
function SourceRow({ group }: { group: SectorSourceGroup }): JSX.Element {
  const d = group.display;
  const mark = providerMark(group.provider);
  return (
    <div className={styles.source}>
      <span className={styles.sourceIcon}>
        {mark ? <ProviderTile provider={mark} size={18} /> : null}
      </span>
      <span className={styles.sourceName}>{group.name}</span>
      {/* NO per-provider connection count here (operator, 2026-07-26: "looks sloppy and breaks
          uniformity on the home page"). It rendered only when a provider had MORE THAN ONE
          connection, so exactly one row on one card grew a middle element every other row lacks —
          Plaid's "2 connections" crowding the freshness clause while iCloud and Microsoft sat clean.
          A conditional column is a uniformity break by construction.
          Nothing is lost: Home is a VERDICT, not a dashboard (soul.md §11), the verdict line above
          already names both grains ("Eight sources · fourteen connections", #91), and the per-provider
          nuance — "N banks, each its own connection" — has room on Sources and on the lens, which is
          what the previous comment here already conceded. */}
      {d.label != null ? (
        <span className={styles.sourceState} data-tone={d.tone}>
          {d.label}
        </span>
      ) : (
        <span className={styles.sourceFresh}>{d.caption || "connected"}</span>
      )}
    </div>
  );
}

export function SectorCard({
  sector,
  connectors,
  readByAgents,
}: {
  sector: Sector;
  connectors: ConnectorStatus[];
  readByAgents: number;
}): JSX.Element {
  const meta = SECTOR_META[sector];
  const { counts } = useSectorCoverage(sector);

  const primary = counts?.[meta.primaryObject];
  const extra = meta.extra ? counts?.[meta.extra.object] : undefined;
  const { groups, moreCount, moreFrom } = groupSectorSources(connectors);
  // #112: the overflow link lands ON the first hidden provider's group on Sources, never at the top
  // of the page. The target is DERIVED from that connection — `sourceGroupHref` is the same function
  // the Sources page renders its ids from, so the two cannot key differently. The bare fallback is
  // unreachable while `moreCount > 0` (a hidden group always has a connection) and exists so a
  // future grouping change degrades to today's behaviour instead of to a dead link.
  const moreTo = moreFrom ? sourceGroupHref(moreFrom) : "/sources";

  return (
    <div className={styles.card}>
      {/* #107 §1 — the sector's HEAD opens its lens. The operator: "Sectors are not clickable on the
          home page. They should be." The lens is the correct drill-down (its masthead, sources band,
          coverage strip and teaser are the expansion of exactly what this card summarises) and it was
          already built and routed — the nav rail was the only thing in the Console that reached it.

          WHAT THE LINK WRAPS, and why the card is not wrapped whole. It wraps the head — the
          specimen, the sector name, the binomial — which is the first option #107 lists. Nothing is
          removed by it: both inner links still work, and every string BELOW the head stays selectable
          and copyable with the mouse.

          A stretched `position:absolute; inset:0` overlay was the first shape of this fix and it is
          the trap. An `<a>` covering the padding box takes the whole card's text away from the mouse:
          an anchor is draggable, so mouse-down-and-drag starts a link drag instead of a selection,
          and a right-click answers with the link menu — so the coverage figure, each provider row and
          its freshness word, and "read by N agents" all stop being selectable, which the plain-div
          card allowed. Wrapping the card in a real anchor is the same loss plus invalid markup: the
          zero-state "add one →" and the overflow "and N more →" would nest inside it, and browsers
          repair a nested anchor by splitting the outer one.

          The accessible name is the link's OWN TEXT ("Finance Cumulus nummorum") — no `aria-label`
          invents one, and the specimen adds nothing to it (<SectorSpecimen> is aria-hidden). */}
      <Link to={`/sectors/${sector}`} className={styles.head}>
        <span className={styles.specimen}>
          <SectorSpecimen sector={sector} />
        </span>
        <span className={styles.headText}>
          <span className={styles.name}>{meta.name}</span>
          <span className={styles.latin}>{meta.latin}</span>
        </span>
      </Link>

      <div className={styles.rule} aria-hidden="true" />

      <div className={styles.sources}>
        {connectors.length === 0 ? (
          <Link to="/connect" className={styles.noSource}>
            No source connected — add one →
          </Link>
        ) : (
          <>
            {groups.map((g) => (
              <SourceRow key={g.provider} group={g} />
            ))}
            {moreCount > 0 ? (
              <Link to={moreTo} className={styles.moreSources}>
                and {moreCount} more <span aria-hidden="true">→</span>
              </Link>
            ) : null}
          </>
        )}
      </div>

      <div className={styles.rule} aria-hidden="true" />

      <div className={styles.foot}>
        <span className={styles.coverage}>
          {counts === undefined ? (
            <Skeleton width="132px" height={14} />
          ) : (
            <>
              {count(primary ?? 0)} {meta.noun}
              {meta.extra ? ` · ${count(extra ?? 0)} ${meta.extra.noun}` : ""}
            </>
          )}
        </span>
        <span className={styles.readBy}>
          {/* One sentence per concept (#100 item 10): zero readers is "no agents hold keys here",
              never the un-English "read by 0 agents" this cell used to compute. */}
          {sectorAgentsClause(readByAgents)}
          {meta.canAct ? <span className={styles.canAct}> · can act</span> : null}
        </span>
      </div>
    </div>
  );
}
