// Skeleton — the load placeholder (#76). Covers a value while it loads so a coverage figure never
// renders a bare em-dash at hero size (#60). No animation by design (matter, not energy).

import styles from "./Skeleton.module.css";

export function Skeleton({
  lines = 1,
  width = "100%",
  height = 16,
}: {
  lines?: number;
  width?: string;
  height?: number;
}): JSX.Element {
  const n = Math.max(1, lines);
  return (
    <span className={styles.stack} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className={styles.bar}
          // The last line of a multi-line block is shortened, as running text would be.
          style={{ width: n > 1 && i === n - 1 ? "62%" : width, height }}
        />
      ))}
    </span>
  );
}
