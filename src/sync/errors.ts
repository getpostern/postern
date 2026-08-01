// Shared sync error taxonomy: the retryable-vs-terminal signal a connector raises and the runner
// classifies. A connector throws RetryableError for a TRANSIENT failure (HTTP 5xx-after-retries,
// 429-after-retries, network/timeout) — one where resuming from the persisted cursor on the next
// poll is expected to converge.
//
// RetryableError is the connector's OWN, AUTHORITATIVE declaration: `classifySyncError`
// (./retryability.ts) checks it FIRST and returns "transient" whatever the message says. The runner
// then retries the run in place (bounded, jittered) and — if it is still failing when the budget is
// spent — writes status='syncing' rather than status='error', so the Console reads "Syncing…"
// instead of a false "needs you". Any error the classifier cannot vouch for stays terminal ->
// status='error'.
//
// THIS IS THE SHAPE EVERY CONNECTOR SHOULD CONVERGE ON (#99, ADR 0034). Today only
// src/connectors/microsoft.ts throws it, so retryability.ts carries a per-provider MESSAGE vocabulary
// as a bridge for the rest. Throwing RetryableError from your own transient paths retires your
// connector's entry in that table — a proposed SDK obligation (src/sdk/contract.ts).
//
// Messages must remain secret-free (status/condition only) — they are surfaced to the operator and
// persisted (masked) into connectors.last_error.

/** A transient, resumable sync failure: the scheduler should retry; status reads 'syncing'. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}
