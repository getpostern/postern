// SubHead — the sub-page header shared by Mint, Agent-detail, and Connect-claude.ai (Paper
// 5KL-0/5US-0/5XS-0): a seal back-link to /agents above the frozen <Masthead>. The back-link is a
// real <Link> (keyboard-reachable, inherited focus ring), not a styled div.

import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Masthead } from "../../shell";
import styles from "./SubHead.module.css";

export function SubHead({
  kicker,
  verdict,
  sub,
}: {
  kicker: string;
  verdict: ReactNode;
  sub?: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.head}>
      <Link className={styles.back} to="/agents">
        ← Agents &amp; keys
      </Link>
      <Masthead kicker={kicker} verdict={verdict} sub={sub} />
    </div>
  );
}
