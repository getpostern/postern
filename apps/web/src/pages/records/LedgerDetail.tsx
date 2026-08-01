// The per-row drill (#78) — the whole audit record, shown truthfully. It mirrors the row; it never
// summarises. Opens in-flow when a ledger row is activated, is Escape-dismissible, and takes focus
// so a keyboard user lands inside it (the row that opened it is a real button via LedgerTable).

import { useEffect, useRef } from "react";
import type { AuditRow } from "../../api/types";
import { isSector } from "../../api/types";
import { SectorChip } from "../../marks";
import { DecisionPill } from "./DecisionPill";
import { decisionState, prettyArgs } from "./ledger";
import styles from "./LedgerDetail.module.css";

/** A full, readable timestamp for the drill (the list shows only the time-of-day). */
function fullTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LedgerDetail({ row, onClose }: { row: AuditRow; onClose: () => void }): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Land focus inside the panel on open, and let Escape close it — a keyboard user who activated a
  // row is now reading its detail, not lost at the top of the table.
  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const denied = decisionState(row) === "denied";

  return (
    <section className={styles.card} role="region" aria-labelledby="ledger-detail-heading">
      <div className={styles.head}>
        <h2 id="ledger-detail-heading" className={styles.kicker} tabIndex={-1} ref={headingRef}>
          Ledger entry
        </h2>
        <button type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>

      <div className={styles.grid}>
        <span className={styles.label}>Time</span>
        <span className={`${styles.value} ${styles.mono}`}>{fullTime(row.created_at)}</span>

        <span className={styles.label}>Agent</span>
        <span className={`${styles.value} ${styles.mono}`}>{row.agent_id ?? "—"}</span>

        <span className={styles.label}>Tool</span>
        <span className={`${styles.value} ${styles.mono}`}>{row.tool}</span>

        <span className={styles.label}>Sector</span>
        <span className={styles.value}>
          {row.sector && isSector(row.sector) ? (
            <span className={styles.sectorCell}>
              <SectorChip sector={row.sector} />
              <span className={styles.sectorName}>{row.sector}</span>
            </span>
          ) : (
            <span className={styles.faded}>—</span>
          )}
        </span>

        <span className={styles.label}>Decision</span>
        <span className={styles.value}>
          <DecisionPill row={row} />
        </span>

        {denied ? (
          <>
            <span className={styles.label}>Deny reason</span>
            <span className={`${styles.value} ${styles.mono}`}>{row.deny_reason ?? "—"}</span>
          </>
        ) : null}

        <span className={styles.label}>Outcome</span>
        <span className={`${styles.value} ${styles.mono}`}>{row.outcome ?? "—"}</span>

        <span className={styles.label}>Result count</span>
        <span className={`${styles.value} ${styles.mono}`}>
          {row.result_count == null ? "—" : String(row.result_count)}
        </span>

        <span className={styles.label}>Request id</span>
        <span className={`${styles.value} ${styles.mono}`}>{row.request_id ?? "—"}</span>
      </div>

      <div>
        <div className={styles.argsLabel}>Args (redacted, verbatim)</div>
        <pre className={styles.argsBlock}>{prettyArgs(row.args)}</pre>
      </div>
    </section>
  );
}
