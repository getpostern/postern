// "Who came through" — the per-agent roll-up, the RIGHT (40%) half of the bottom strip. Ported from
// `9S0-0`.
//
// DEGRADATION (program plan §3, build-notes §16.6 — the most pervasive of the four seams). Agent
// "passage" (last-seen) IS SERVED now — `listAgents` carries `last_seen_at` off the audit trail
// (`src/rest/admin.ts`, commit 8529bd3). The three-way it types against is unchanged, because the
// three answers are still genuinely different: `undefined` = the gateway did not tell us (a box
// running an older build than this Console), `null` = served and this key has never come through,
// a string = a real instant.
//
// Two rules survive that landing, and neither is cosmetic:
//   - The value is NEVER reduced from the /api/audit feed. That feed is newest-first, capped at
//     1000, so a quiet agent — real, but a week idle — falls off the end and would render "never":
//     false, not approximate, and fine in every fixture (build-notes §16.6). We refuse that lie on
//     the home page of a product whose whole premise is a truthful audit trail.
//   - `undefined` renders as ABSENCE, not as a sentence (#106 §2a). See `passageOf`.

import { Link } from "react-router-dom";
import { Skeleton } from "../../kit";
import { ago } from "../../api/format";
import type { Agent } from "../../api/types";
import { isKeyHolder } from "../agents/helpers";
import styles from "./WhoCameThrough.module.css";

/**
 * The passage cell: the honest three-way on the field, with the unserved arm rendering NOTHING.
 *
 * `null` means SERVED AND NEVER USED and still prints `never`; a string still prints a relative time.
 * The third answer — the gateway did not tell us — used to print *"passage not yet served"* on the home
 * page, once per key-holding agent (#106 §2a). That is our word "served" and our build status, on the
 * one screen a person looks at to know whether their gate is alright, in place of a fact. An absent
 * cell claims nothing, which is exactly what we know. Hiding an unserved value is not the same as
 * claiming there is none: the agent's row is still here, complete, from the register.
 */
function passageOf(a: Agent): string | null {
  if (a.last_seen_at === undefined) return null;
  if (a.last_seen_at === null) return "never";
  return ago(a.last_seen_at);
}

function AgentRow({ agent }: { agent: Agent }): JSX.Element {
  const passage = passageOf(agent);
  return (
    <div className={styles.row}>
      <span className={styles.agent}>{agent.agentId}</span>
      {passage != null ? <span className={styles.passage}>{passage}</span> : null}
    </div>
  );
}

export function WhoCameThrough({
  agents,
  loading,
}: {
  agents: Agent[] | undefined;
  loading: boolean;
}): JSX.Element {
  // An EXPIRED key is not a key-holder (#100 item 4) and is not re-surfaced here as a third row
  // treatment: the Gatehouse is a glance verdict and an expired key cannot falsify it — it is
  // config, and the full register (which labels `expired`) is one click away behind "All agents →".
  const holders = (agents ?? []).filter((a) => isKeyHolder(a));
  return (
    <section className={styles.panel} aria-label="Who came through">
      <div className={styles.head}>
        <span className={styles.title}>Who came through</span>
        <span className={styles.hairline} aria-hidden="true" />
        <Link to="/agents" className={styles.more}>
          All agents →
        </Link>
      </div>
      {loading ? (
        <div className={styles.rows}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={styles.row}>
              <Skeleton width="60%" height={14} />
            </div>
          ))}
        </div>
      ) : holders.length === 0 ? (
        <p className={styles.empty}>
          No agents hold keys. <Link to="/agents/new" className={styles.emptyLink}>Mint a key →</Link>
        </p>
      ) : (
        <div className={styles.rows}>
          {holders.map((a) => (
            <AgentRow key={a.agentId} agent={a} />
          ))}
        </div>
      )}
    </section>
  );
}
