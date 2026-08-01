// AttentionBanner — one shell, drawn from `FEA-0`. The cause and detail are served; the button is
// supplied by the PAGE and this component never chooses a custody flow itself. Per the degradation
// contract (program plan §3), when `reconnect_kind` is not on the wire the page passes the fallback
// action (`Manage this connection →`) or `null`; a banner with two different needed actions passes
// `action: null` and points with a count in its `note` instead of picking one (build-notes §14.3).

import type { ReactNode } from "react";
import styles from "./AttentionBanner.module.css";

export function AttentionBanner({
  cause,
  detail,
  action,
  note,
}: {
  cause: ReactNode;
  detail?: ReactNode;
  action?: { label: string; onAct: () => void } | null;
  note?: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.banner} role="status">
      <div className={styles.text}>
        <div className={styles.cause}>{cause}</div>
        {detail != null ? <div className={styles.detail}>{detail}</div> : null}
      </div>
      <div className={styles.spacer} />
      {note != null ? <div className={styles.note}>{note}</div> : null}
      {action ? (
        <button type="button" className={styles.action} onClick={action.onAct}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
