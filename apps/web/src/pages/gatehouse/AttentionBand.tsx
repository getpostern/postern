// The NEEDS ATTENTION band — exceptions-first. Ported from `48G-0` (one down) and `4LK-0` (multi).
//
// Healthy is quiet: this band renders ONLY when a connection's SERVED freshness is in an actionable
// tone (helpers.needsAttention). One <AttentionBanner> per broken connection, worst-first — each row
// is one connection with one action, so each carries its own button (the "count, don't pick" rule,
// build-notes §14.3, applies only when ONE banner spans MANY actions, which never happens here).
//
// DEGRADATION (program plan §3): `reconnect_kind` is NOT served (#89), so the button never guesses
// which of the four custody flows applies — it falls back to `Manage this connection →`, routing to
// the one page that holds every reconnect affordance. The cause + the seal detail sentence are both
// SERVED (provider·sector, and freshnessDisplay's caption).

import { useNavigate } from "react-router-dom";
import { AttentionBanner } from "../../kit";
import { ProviderTile } from "../../marks";
import { humanize } from "../../api/format";
import { freshnessDisplay } from "../../api/freshness";
import type { ConnectorStatus } from "../../api/types";
import { bySeverity, providerMark } from "./helpers";
import styles from "./AttentionBand.module.css";

export function AttentionBand({ connectors }: { connectors: ConnectorStatus[] }): JSX.Element | null {
  const navigate = useNavigate();
  if (connectors.length === 0) return null;

  const ordered = [...connectors].sort(bySeverity);

  return (
    <section className={styles.band} aria-label="Needs attention">
      <div className={styles.header}>
        <span className={styles.label}>Needs attention</span>
        <span className={styles.count}>{ordered.length}</span>
      </div>
      <div className={styles.rows}>
        {ordered.map((c) => {
          const d = freshnessDisplay(c);
          const mark = providerMark(c.provider);
          return (
            <AttentionBanner
              key={c.connectionId}
              cause={
                <span className={styles.cause}>
                  {mark ? <ProviderTile provider={mark} size={20} /> : null}
                  {humanize(c.provider)} · {humanize(c.sector)}
                </span>
              }
              detail={d.caption}
              action={{
                label: "Manage this connection →",
                onAct: () => navigate(`/sources/${c.connectionId}`),
              }}
            />
          );
        })}
      </div>
    </section>
  );
}
