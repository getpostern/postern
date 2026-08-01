// Masthead — the page header every Console page leads with.
//
// The verdict is a generated SENTENCE the page composes (exceptions-first — build-notes §14.4) and
// hands in; the Masthead never derives it. `kicker` is the small-caps section label; `meta` is the
// right-hand mono meta that sits beside it (the date on the Gatehouse, a `· 2 need you` count on
// Sources); `sub` is the italic supporting line; `right` is an optional right-hand block (the gate
// address card, a stat). Ported from `1Q-0`.

import type { ReactNode } from "react";
import styles from "./Masthead.module.css";

export function Masthead({
  kicker,
  verdict,
  sub,
  meta,
  right,
}: {
  kicker: string;
  verdict: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
}): JSX.Element {
  return (
    <header className={styles.masthead}>
      <div className={styles.lead}>
        <div className={styles.kickerRow}>
          <span className={styles.kicker}>{kicker}</span>
          {meta != null ? (
            <>
              <span className={styles.kickerDot} aria-hidden="true" />
              <span className={styles.meta}>{meta}</span>
            </>
          ) : null}
        </div>
        <h1 className={styles.verdict}>{verdict}</h1>
        {sub != null ? <p className={styles.sub}>{sub}</p> : null}
      </div>
      {right != null ? <div className={styles.right}>{right}</div> : null}
    </header>
  );
}
