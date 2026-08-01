// PlaceholderBody — the marked not-yet-ported page body. Every route in the table renders its real
// chrome (the rail, the shell) around one of these, naming the phase-2 group that owns it. A page
// child replaces only its own directory, and the route already exists — that is the seam that makes
// seven-way parallelism safe.

import styles from "./PlaceholderBody.module.css";

export function PlaceholderBody({ unit }: { unit: string }): JSX.Element {
  return (
    <div className={styles.body}>
      <div className={styles.kicker}>The Console · in progress</div>
      <div className={styles.headline}>This page is being ported.</div>
      <p className={styles.note}>
        Its chrome is live; its body arrives with the page group that owns it.
      </p>
      <span className={styles.unit}>{unit}</span>
    </div>
  );
}
