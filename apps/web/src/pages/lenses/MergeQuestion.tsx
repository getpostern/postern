// Finance — confirm a merge (G14-0). The confirm-a-merge flow is the finance lens with THIS block
// inserted into THE SOURCES band; the route is /sectors/finance/merges/:bankKey.
//
// The principle (build-notes §12.3): do NOT ask a question without showing the evidence to answer it.
// Both candidate rows are shown side by side under VIA PLAID / VIA SIMPLEFIN with the fields the
// dedup engine actually served (name · institution · currency · last-4-or-"no last-4 published"). The
// engine never merges on a resemblance; the operator settles it. "They're the same" is an ink outline
// (an offer, not a seal); both answers are reversible. Balance/class are NOT on the candidate wire, so
// they are not shown — the margin note is honest about which field is missing.

import type { ReactNode } from "react";
import styles from "./MergeQuestion.module.css";

/** One side of the candidate pair, with only the served fields rendered. */
export interface MergeSideVM {
  /** "via Plaid" / "via SimpleFIN". */
  providerLabel: string;
  name: string;
  /** The served detail line: currency + last-4, or "no last-4 published". */
  detail: string;
}

export function MergeQuestion({
  sides,
  onConfirm,
  onKeepSeparate,
  busy = false,
}: {
  /** The two candidate sides (a, b). When null, there is nothing to confirm for this key. */
  sides: [MergeSideVM, MergeSideVM] | null;
  onConfirm: () => void;
  onKeepSeparate: () => void;
  busy?: boolean;
}): JSX.Element {
  if (sides === null) {
    return (
      <div className={styles.block}>
        <div className={styles.question}>Nothing to confirm here.</div>
        <p className={styles.explain}>
          This pair is no longer awaiting a decision — it may already be merged, or the flag cleared on
          its own.
        </p>
        <div className={styles.answer}>
          <button type="button" className={styles.keepBtn} onClick={onKeepSeparate}>
            Back to the sources
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.block}>
      <div className={styles.question}>Is this the same account, seen twice?</div>
      <p className={styles.explain}>
        One provider publishes no last-4, so the engine will not guess — it never merges on a
        resemblance. You can settle it. Answer once and it stays answered.
      </p>

      <div className={styles.candidates}>
        <Candidate side={sides[0]} />
        <Candidate side={sides[1]} />
        <div className={styles.margin}>
          The institution and currency agree; only the last-4 that would prove it is missing.
        </div>
      </div>

      <div className={styles.answer}>
        <button type="button" className={styles.confirmBtn} onClick={onConfirm} disabled={busy}>
          {busy ? "Merging…" : "They’re the same account"}
        </button>
        <button type="button" className={styles.keepBtn} onClick={onKeepSeparate} disabled={busy}>
          Keep them separate
        </button>
        <span className={styles.spacer} />
        <span className={styles.reversible}>
          Either answer is reversible, from the account&rsquo;s own page.
        </span>
      </div>
    </div>
  );
}

function Candidate({ side }: { side: MergeSideVM }): JSX.Element {
  return (
    <div className={styles.candidate}>
      <div className={styles.candLabel}>{side.providerLabel}</div>
      <div className={styles.candName}>{side.name}</div>
      <div className={styles.candDetail}>{side.detail as ReactNode}</div>
    </div>
  );
}
