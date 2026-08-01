// SectionRule — a small-caps label, a hairline that fills the row, and an optional right-hand
// gloss. Ported from `2B-0` (the "The Sectors · six connected · nothing stale" register header).
//
// The measured artboard renders the gloss in mono; build-notes §15.2 / the spec describe it as an
// "italic gloss". The gloss is a `ReactNode`, so a page may pass italic content; the default slot
// styling follows what the file actually renders. (Reported as a design/spec wording mismatch.)

import type { ReactNode } from "react";
import styles from "./SectionRule.module.css";

export function SectionRule({ label, gloss }: { label: string; gloss?: ReactNode }): JSX.Element {
  return (
    <div className={styles.rule}>
      <span className={styles.label}>{label}</span>
      <span className={styles.hairline} aria-hidden="true" />
      {gloss != null ? <span className={styles.gloss}>{gloss}</span> : null}
    </div>
  );
}
