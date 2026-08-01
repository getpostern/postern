// CoverageStrip — big figure + small-caps label, repeated. A figure of `undefined` is LOADING and
// renders a Skeleton, never an em-dash (#60): the fix for the hero-size dash is the skeleton, not a
// wrong-but-fast number. Coverage figures are `query()` counts (service truth), never a sum of
// per-connection `cached_count` (which triple-counts a deduped finance account — spec §Counts).

import type { ReactNode } from "react";
import { Skeleton } from "./Skeleton";
import styles from "./CoverageStrip.module.css";

export function CoverageStrip({
  items,
}: {
  items: { label: string; value?: number | string; sub?: ReactNode }[];
}): JSX.Element {
  return (
    <div className={styles.strip}>
      {items.map((item, i) => (
        <div className={styles.item} key={`${item.label}-${i}`}>
          <div className={styles.figure}>
            {item.value === undefined ? (
              <Skeleton width="72px" height={38} />
            ) : typeof item.value === "number" ? (
              item.value.toLocaleString("en-US")
            ) : (
              item.value
            )}
          </div>
          <div className={styles.label}>{item.label}</div>
          {item.sub != null ? <div className={styles.sub}>{item.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
