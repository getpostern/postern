# docs/

The map of this directory — which file answers which question.

**Start at the root, not here.** [`../README.md`](../README.md) is what Postern is in a page. [`SETUP.md`](SETUP.md) is how you install it and connect your sources. Everything below is a detail one of those points at.

## Getting it running

- [`SETUP.md`](SETUP.md) — **the one to read first.** Compose up, the Console, every provider split by how much work it costs you, the redirect-URI trap, connecting an agent, and what to do when something is wrong.
- [`../setup-with-your-agent.md`](../setup-with-your-agent.md) — the same path written as a contract for an agent doing the setup: the phases in order, every human stop marked, the exact routes with body shapes, and the traps — verified end to end by a first-time user's agent on a clean machine.
- [`runbooks/plaid-onboarding.md`](runbooks/plaid-onboarding.md) — connecting banks through Plaid, end to end, including what it costs.
- [`runbooks/remote-access.md`](runbooks/remote-access.md) — reaching your gateway from away. Tailnet-private by default; the public `:443` endpoint that hosted clients require, opt-in and hardened. Read it in full before you publish anything.

## Keeping it alive

- [`runbooks/backup-restore.md`](runbooks/backup-restore.md) — the backup unit is one atomic tarball (the vault master key **and** the database dump). Apart, both are dead.
- [`runbooks/key-rotation.md`](runbooks/key-rotation.md) — rotating the vault master key in place: idempotent, resumable, fail-closed.

## How it works

- [`what-this-is.html`](what-this-is.html) — the idea in plain English: connect your life once, reach it from any agent, swap the harness without losing the context.
- [`how-it-works.html`](how-it-works.html) — the product end to end.
- [`architecture.html`](architecture.html) — the rendered architecture: invariants, ingest → store → core → adapters, the schema contract, security, repository layout. ([`ARCHITECTURE.md`](ARCHITECTURE.md) is a pointer to it and nothing more.)
- [`agent-authored-connectors.html`](agent-authored-connectors.html) — the breadth thesis: hand-build the universal core, extract the SDK and the conformance harness, then let agents author the long tail against it.

## Why it is the way it is

- [`specs/decisions/`](specs/decisions/) — **the ADRs.** Every settled architectural *why* is one of these: the shape that was chosen, the alternatives that were rejected, and the reasoning that got there. [`specs/decisions/README.md`](specs/decisions/README.md) indexes them with a one-liner and a "read this when" trigger for each. If you are about to change something structural, the ADR that covers it is the thing to read first.
- [`research/plaid-integration-deep-dive.html`](research/plaid-integration-deep-dive.html) — the Plaid API study the finance connector was built from.

## Touching the Console

- [`design/soul.md`](design/soul.md) — the Postern paper/ink constitution. Read it before changing anything in `apps/web`.
- [`design/freshness-grammar.md`](design/freshness-grammar.md) — the display vocabulary for freshness. The words are derived server-side in exactly one place; this is how they are shown.
- [`design/logo/`](design/logo/) — the door mark, in its rendered forms. Note that the mark is **not** licensed with the code — see [`../TRADEMARK.md`](../TRADEMARK.md).

## Contributing

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — setup, the test-database rule, the invariants that are decided, and connector authoring as the headline path.
- [`../SECURITY.md`](../SECURITY.md) — the honest trust boundary, and how to report a vulnerability.
- [`../CLAUDE.md`](../CLAUDE.md) — the working notes an agent needs before touching this codebase.
