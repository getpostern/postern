// The inspector's OUTAGE region — the branch the page never had (#100 item 1).
//
// It is page-local, not a kit component: `ZeroState`'s two kinds are a closed union (`unconnected`
// needs an action, `filtered` needs the total it filtered from) and neither describes a failed
// read, and `kit/` is not owned by this unit. It also renders IN PLACE OF `<LedgerTable>` rather
// than inside its `empty` slot — column headers above an outage are furniture, and a `role="alert"`
// nested inside a `role="table"` is invalid ARIA.
//
// ONE VOICE PER SURFACE: exactly one `--state-error` accent (the 2px left rule). The headline is
// plain ink and the button is the ordinary seal affordance — painting the headline red *and* the
// rule red *and* the button red is three alarms for one fact.
//
// The button is the only interactive element here, and the retry is the only one in the four list
// states. That asymmetry IS the finding: an empty store has nothing to retry.
//
// `noun` is part of the spec-frozen signature but the spec-frozen COPY has no slot for it (both the
// headline and the reason paragraph are fixed sentences). It is accepted and deliberately not
// rendered rather than invented into a sentence the spec did not write — see the unit notes.

import styles from "./InspectorError.module.css";

export function InspectorError(p: {
  /** The object noun for the sentence ("transactions"). */
  noun: string;
  /** The served failure text, or null when the client produced no message. */
  message: string | null;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className={styles.box} role="alert">
      <div className={styles.headline}>The records could not be read</div>
      <p className={styles.reason}>
        Postern could not reach the gateway for this read. This is a failed read, not an empty store
        — nothing has been removed from your cache.
      </p>
      {/* The SERVED failure text, verbatim, and only when the client actually produced one. A
          fabricated reason would be the same class of lie as the empty store this replaces. */}
      {p.message != null ? <p className={styles.detail}>{p.message}</p> : null}
      <div className={styles.actionRow}>
        <button type="button" className={styles.action} onClick={p.onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
