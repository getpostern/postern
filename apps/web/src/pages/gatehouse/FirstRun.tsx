// First run — the cold-start gate, when nothing has been connected yet. Ported from `36T-0`.
//
// This is a WELCOME, not a void (build-notes §14.1e): the whole gate being empty is the one empty
// state that is not a zero-state sheet. Hero (the identity door + one call to action) · how-it-works
// (three steps, the product's promise in plain words) · the waiting strip (all six sectors, dimmed —
// "present in the vocabulary, absent from your setup", the §11.3 dimmed treatment). No mock numbers
// live here: it renders only when the connectors list is genuinely empty.

import { Link } from "react-router-dom";
import { PosternMark, SectorChip } from "../../marks";
import { SECTORS } from "../../api/types";
import styles from "./FirstRun.module.css";

// The three captions are deliberately NOT one sentence shape. They were three byte-identical
// `clause — clause` slots, each taking its dash in the same syntactic position, which is the
// clearest AI-writing tell there is: parallel slots with identical grammar read as a template, not
// as writing (§18.2). Corrected on the plate (36T-0) and re-ported verbatim — if you edit one, do
// not restore the parallelism.
const STEPS = [
  {
    n: "1",
    title: "Connect a source",
    body: "You link the account at its source, once, then hand over the token.",
  },
  {
    n: "2",
    title: "Postern keeps it",
    body: "It lands in a local cache and stays fresh. Reads serve in milliseconds.",
  },
  {
    n: "3",
    title: "Any agent reads it",
    body: "Only with the permission you grant. Every touch is written to the ledger.",
  },
];

export function FirstRun(): JSX.Element {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <PosternMark size={57} />
        <h1 className={styles.headline}>Your gate is new.</h1>
        <p className={styles.sub}>
          Nothing has passed through yet. Connect the first sector of your life — money, mail,
          calendar, contacts, health, home — and Postern begins keeping it, ready for any agent you
          allow.
        </p>
        <Link to="/connect" className={styles.cta}>
          Add your first source
        </Link>
      </section>

      <div className={styles.divider} aria-hidden="true" />

      <section className={styles.steps} aria-label="How it works">
        {STEPS.map((s) => (
          <div key={s.n} className={styles.step}>
            <span className={styles.stepNum}>{s.n}</span>
            <span className={styles.stepTitle}>{s.title}</span>
            <span className={styles.stepBody}>{s.body}</span>
          </div>
        ))}
      </section>

      <section className={styles.waiting} aria-label="Waiting to be connected">
        <span className={styles.waitingLabel}>Waiting</span>
        {SECTORS.map((s) => (
          <SectorChip key={s} sector={s} dimmed label />
        ))}
      </section>
    </div>
  );
}
