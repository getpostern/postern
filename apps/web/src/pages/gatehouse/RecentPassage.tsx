// "Recent passage" — the event feed, the LEFT (primary, 60%) half of the bottom strip. Ported from
// `9HI-0`.
//
// This is SERVED audit truth (`/api/audit`, newest-first) and it earns its place on the glance: a
// refusal can falsify the verdict. Each row is `time · agent · tool · sector · args`, and the
// decision is EXCEPTIONS-ONLY — an admission gets no ink, an exception renders lowercase and inline
// immediately after the args (never a right-edge badge, build-notes §6).
//
// "Exception" is `decisionState(row)`, the SAME derivation the ledger uses — not `decision === "deny"`.
// That test missed the third state (#78): an allowed call whose connector-reported `outcome` is
// `error` was admitted at the door and then failed doing the work, and painting it as a silent
// admission is the exact lie #78 names. It had been fixed on the ledger and left standing here, on
// the one page whose job is to let you falsify the all-clear.

import { Link } from "react-router-dom";
import { SectorChip } from "../../marks";
import { Skeleton } from "../../kit";
import { ago } from "../../api/format";
import { isSector, type AuditRow } from "../../api/types";
import { argsWithValues, decisionState } from "../records/ledger";
import styles from "./RecentPassage.module.css";

/** How many events the glance shows — a glance, not the ledger (that is one link away). */
const GLANCE_ROWS = 6;

/**
 * Render the redacted args as a readable one-liner. The args are already scrubbed server-side
 * (central key-denylist, #9); this is display only.
 *
 * It is handed `argsWithValues`'s output, never the raw args (#106 §4): this feed printed `{ sector:
 * null }` after an export — with exactly that spacing — for a call that simply narrowed nothing. So the
 * keys that carry a value are what arrive here, and there are always at least one of them, which is why
 * there is no empty-object branch: `argsWithValues` answers `null` for that and the row draws no cell.
 */
function formatArgs(args: unknown): string {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    return `{ ${entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;
  }
  return JSON.stringify(args);
}

function PassageRow({ row }: { row: AuditRow }): JSX.Element {
  const sector = row.sector;
  // The value-bearing args, or nothing. A glance row already omits the cell when there are no args at
  // all, and "every key was empty" is the same fact — so it renders the same way rather than printing an
  // em-dash the surrounding prose has no column for (the LEDGER's table cell is where the dash belongs).
  const args = argsWithValues(row.args);
  // `admitted` is the norm and gets nothing; `denied` and `errored` are the two exceptions, and the
  // state values are already the lowercase words the glance prints.
  const state = decisionState(row);
  const exception = state === "admitted" ? null : state;
  return (
    <div className={styles.row}>
      <span className={styles.time}>{ago(row.created_at)}</span>
      <span className={styles.agent}>{row.agent_id ?? "operator"}</span>
      <span className={styles.tool}>{row.tool}</span>
      <span className={styles.detail}>
        {sector ? (
          <span className={styles.sector}>
            {isSector(sector) ? <SectorChip sector={sector} size={15} /> : null}
            <span className={styles.sectorName}>{sector}</span>
          </span>
        ) : null}
        {args != null ? <span className={styles.args}>{formatArgs(args)}</span> : null}
        {/* Each exception in its OWN ink, the same two the ledger uses: a refusal is poppy, a
            failure is marigold. One shared class for the shape, one for the colour — painting both
            in the deny ink would make the glance and the ledger disagree about which happened. */}
        {exception ? (
          <span
            className={`${styles.exception} ${exception === "denied" ? styles.denied : styles.errored}`}
          >
            · {exception}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function RecentPassage({
  rows,
  loading,
}: {
  rows: AuditRow[] | undefined;
  loading: boolean;
}): JSX.Element {
  const shown = (rows ?? []).slice(0, GLANCE_ROWS);
  return (
    <section className={styles.panel} aria-label="Recent passage">
      <div className={styles.head}>
        <span className={styles.title}>Recent passage</span>
        <span className={styles.hairline} aria-hidden="true" />
        <Link to="/ledger" className={styles.more}>
          The full ledger →
        </Link>
      </div>
      {loading ? (
        <div className={styles.rows}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={styles.row}>
              <Skeleton width="70%" height={14} />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className={styles.empty}>No passage recorded yet.</p>
      ) : (
        <div className={styles.rows}>
          {shown.map((r) => (
            <PassageRow key={r.id} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}
