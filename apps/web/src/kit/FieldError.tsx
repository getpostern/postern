// FieldError — the three connect-form failures (build-notes §14.1d), and the taxonomy matters more
// than the styling because only one of them is ours:
//   shape    — WE rejected it before spending a round-trip. Seal, caught as they type.
//   provider — THEY answered no. Our plain sentence, and their string quoted VERBATIM in mono. We
//              never paraphrase a provider error: an invented message is a guess in the provider's
//              voice, and the literal string is exactly what the operator needs to search for.
//   already  — nobody's failure. No seal, no red; it just says what will happen.

import type { ReactNode } from "react";
import styles from "./FieldError.module.css";

export type FieldErrorKind =
  | { kind: "shape"; message: ReactNode }
  | { kind: "provider"; ourSentence: string; theirString: string }
  | { kind: "already"; message: ReactNode };

export function FieldError(p: FieldErrorKind): JSX.Element {
  if (p.kind === "shape") {
    return <div className={styles.shape}>{p.message}</div>;
  }
  if (p.kind === "already") {
    return <div className={styles.already}>{p.message}</div>;
  }
  return (
    <div className={styles.provider}>
      <span className={styles.providerBar} aria-hidden="true" />
      <div className={styles.providerText}>
        <div className={styles.ourSentence}>{p.ourSentence}</div>
        {/* <code>, so the provider's literal string is monospaced and rendered untouched. */}
        <code className={styles.theirString}>{p.theirString}</code>
      </div>
    </div>
  );
}
