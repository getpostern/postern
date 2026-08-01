// The Gatehouse — the glance verdict. Ported from `Overview — the Gatehouse` (`1-0`) and its two
// attention variants (`3WB-0`, `48W-0`) and first-run (`36T-0`).
//
// It is a VERDICT, never a launchpad or a dashboard (#63): it does not analyse the user's content,
// and nothing on it is a second interactive copy of a rail page. The test every element passed to
// earn its place: can it FALSIFY the verdict sentence? The masthead sentence, the sector cards, and
// the passage feed can (freshness, a refusal). A grants TABLE cannot — it restates config, identical
// every visit — so grants are ONE masthead clause counting agents, linked to Agents & keys (#63,
// decision 10.2). There is no grants table here.
//
// Freshness advances on screen because the hooks poll (useConnectors, #62) and relative labels tick
// via useTick — nothing here re-derives a state word.

import { Link } from "react-router-dom";
import { Skeleton } from "../../kit";
import { Masthead, SectionRule } from "../../shell";
import { useTick, ago } from "../../api/format";
import { freshnessRollup } from "../../api/freshness";
import { useConnectors, useAgents, useAudit } from "../../api/hooks";
import { SECTORS } from "../../api/types";
import type { ConnectorStatus } from "../../api/types";
import { isKeyHolder } from "../agents/helpers";
import {
  needsAttention,
  composeHeadline,
  agentsClause,
  verdictLead,
} from "./helpers";
// The two grains, the ONE tally, and the ONE revoked filter both this page and Sources read (#91).
import { liveConnectors, numberWord, sourceCounts, type GrainCounts } from "../sources/grain";
import { GateAddress } from "./GateAddress";
import { AttentionBand } from "./AttentionBand";
import { SectorCard } from "./SectorCard";
import { RecentPassage } from "./RecentPassage";
import { WhoCameThrough } from "./WhoCameThrough";
import { FirstRun } from "./FirstRun";
import styles from "./GatehousePage.module.css";

/** The kicker's live date-time — the client clock, formatted the way the artboard reads it
 *  ("Tuesday · 21 July 2026 · 6:04 PM"). `useTick` (a minute is plenty) keeps it current. */
function nowLabel(): string {
  const d = new Date();
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${weekday} · ${date} · ${time}`;
}

/**
 * The exceptions-first sub sentence (build-notes §14.4). The healthy summary is demoted to the last
 * clause when something is wrong, never deleted. The agents clause is the ONE grants surface.
 *
 * The lead names BOTH grains (`verdictLead`, off the shared tally) — the port rendered a connection
 * count under the word "source" and then subtracted the attention count from it (#91). The attention
 * clause stays deliberately NOUN-LESS: it follows "connections", so it inherits that noun, and its
 * number is the one the band beneath prints in its own header.
 */
function VerdictSub({
  counts,
  attentionCount,
  agentCount,
  lastHeard,
}: {
  counts: GrainCounts;
  attentionCount: number;
  agentCount: number;
  lastHeard: string | null;
}): JSX.Element {
  const agents = (
    <Link to="/agents" className={styles.agentsLink}>
      {agentsClause(agentCount)}
    </Link>
  );

  if (attentionCount === 0) {
    return (
      <>
        {verdictLead(counts)}
        {lastHeard ? ` · last heard ${ago(lastHeard)}` : ""} · {agents} · nothing needs your
        attention.
      </>
    );
  }

  return (
    <>
      {verdictLead(counts)} · {numberWord(attentionCount)} need{attentionCount === 1 ? "s" : ""} your
      attention · {agents}.
    </>
  );
}

/** The register's small-caps gloss — "six connected · nothing stale", exceptions-first. */
function registerGloss(connectedSectors: number, attentionCount: number): string {
  const left = `${numberWord(connectedSectors)} connected`;
  const right =
    attentionCount === 0
      ? "nothing stale"
      : `${numberWord(attentionCount)} need${attentionCount === 1 ? "s" : ""} you`;
  return `${left} · ${right}`;
}

export function Gatehouse(): JSX.Element {
  useTick(60); // advance the kicker clock and the relative labels without a refetch (#62)

  const connectorsQ = useConnectors();
  const agentsQ = useAgents();
  const auditQ = useAudit();

  const cs: ConnectorStatus[] | undefined = connectorsQ.data;
  const agents = agentsQ.data;
  // `isKeyHolder`, not `!a.revoked_at` (#100 item 4): the auth layer denies an EXPIRED key too, so
  // counting one here claimed a reader the gate would turn away.
  const agentCount = agents ? agents.filter((a) => isKeyHolder(a)).length : 0;

  // ── loading (connectors not yet in) ──
  if (connectorsQ.isLoading || cs === undefined) {
    return (
      <div className={styles.page}>
        <Masthead
          kicker="The Gatehouse"
          meta={nowLabel()}
          verdict={<Skeleton width="460px" height={92} />}
          sub={<Skeleton width="360px" height={20} />}
          right={<GateAddress />}
        />
      </div>
    );
  }

  // ── error ──
  if (connectorsQ.isError) {
    return (
      <div className={styles.page}>
        <Masthead
          kicker="The Gatehouse"
          meta={nowLabel()}
          verdict={<>The gate is unreachable.</>}
          sub={<>Could not read the connections. The gateway may be down — check the footer status.</>}
          right={<GateAddress />}
        />
      </div>
    );
  }

  const live = liveConnectors(cs);

  // ── first run: nothing connected yet ──
  if (live.length === 0) {
    return (
      <div className={styles.page}>
        <FirstRun />
      </div>
    );
  }

  const attention = live.filter(needsAttention);
  // The two grains, from the ONE tally the Sources masthead reads (#91): a real gate has fewer
  // sources than connections (one iCloud credential feeds three sectors; each Plaid Item is its own
  // credential), so `live.length` alone can only ever name one of the two — and it named it "sources".
  const counts = sourceCounts(live);
  const lastHeard = freshnessRollup(live).lastHeardAt;
  const { headlineTop, headlineBottom } = composeHeadline(attention.length);
  const connectedSectors = SECTORS.filter((s) => live.some((c) => c.sector === s)).length;

  return (
    <div className={styles.page}>
      <Masthead
        kicker="The Gatehouse"
        meta={nowLabel()}
        verdict={
          <>
            {headlineTop}
            <br />
            {headlineBottom}
          </>
        }
        sub={
          <VerdictSub
            counts={counts}
            attentionCount={attention.length}
            agentCount={agentCount}
            lastHeard={lastHeard}
          />
        }
        right={<GateAddress />}
      />

      <AttentionBand connectors={attention} />

      <section className={styles.register} aria-label="The sectors">
        <SectionRule label="The Sectors" gloss={registerGloss(connectedSectors, attention.length)} />
        <div className={styles.cards}>
          {SECTORS.map((sector) => (
            <SectorCard
              key={sector}
              sector={sector}
              connectors={live.filter((c) => c.sector === sector)}
              readByAgents={
                agents
                  ? agents.filter((a) => isKeyHolder(a) && a.sectors.includes(sector)).length
                  : 0
              }
            />
          ))}
        </div>
      </section>

      <div className={styles.strip}>
        <div className={styles.stripLeft}>
          <RecentPassage rows={auditQ.data} loading={auditQ.isLoading} />
        </div>
        <div className={styles.stripRight}>
          <WhoCameThrough agents={agentsQ.data} loading={agentsQ.isLoading} />
        </div>
      </div>
    </div>
  );
}
