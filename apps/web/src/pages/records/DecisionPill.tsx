// The decision pill (#78) — renders one of the THREE states an audit row can be. `admitted` is quiet
// (the door opened and the work succeeded); `denied` (seal) and `errored` (attention) are the
// exceptions that get ink. The distinction between allowed-and-ok and allowed-but-errored is the
// whole finding — a green "allow" on a failed call is the lie.

import type { AuditRow } from "../../api/types";
import { DECISION_LABEL, decisionState } from "./ledger";
import styles from "./DecisionPill.module.css";

/**
 * `exceptionsOnly` suppresses the "Admitted" label entirely (renders nothing) — §17.5: a column
 * whose value is the same on ~95% of rows carries no information and actively buries the two rows
 * that matter. The ledger table passes it; the one-row DRILL passes false (the default), because
 * there the label is a record field being read once, not a column repeated down a page.
 */
export function DecisionPill({
  row,
  alignRight = false,
  exceptionsOnly = false,
}: {
  row: Pick<AuditRow, "decision" | "outcome">;
  alignRight?: boolean;
  exceptionsOnly?: boolean;
}): JSX.Element | null {
  const state = decisionState(row);
  if (exceptionsOnly && state === "admitted") return null;
  const toneClass =
    state === "denied" ? styles.denied : state === "errored" ? styles.errored : styles.admitted;
  const cls = `${styles.pill} ${toneClass}${alignRight ? ` ${styles.alignRight}` : ""}`;

  return (
    <span className={cls}>
      {state === "denied" ? <span className={`${styles.dot} ${styles.dotDenied}`} aria-hidden="true" /> : null}
      {state === "errored" ? <span className={`${styles.dot} ${styles.dotErrored}`} aria-hidden="true" /> : null}
      {DECISION_LABEL[state]}
    </span>
  );
}
