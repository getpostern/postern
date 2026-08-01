# ADR 0007 — Connector SDK + conformance harness

**Status:** accepted · **Date:** 2026-06-13 · **Wave:** 8 (`pci-sdk` ‖ `push-ingest`)

## Context

The connector is the gateway's one extension point, but its contract was split: compile-time types
(`src/connectors/types.ts`) captured only the *shape*, while a layer of **runtime obligations** lived
as tribal knowledge the runner silently enforces or assumes (normalize emits only REGISTRY columns;
deletions carry `externalId`; `source_object_id` non-empty; cursor round-trips; read-only ⇒ `actions:[]`
+ `execute` throws; secrets never in errors; …). Correctness was per-connector hand-rolled tests +
adversarial review. The long game — **agent-authored connectors** ("earned, not assumed") — is unsafe
without an explicit contract and a mechanical pass/fail gate. With 7 hand-built connectors spanning the
real diversity (bounded/unbounded, poll/push, single/multi-object, OAuth/static/IMAP, read/act), the
rule of three is satisfied: there's enough to generalize from.

## Decision

1. **Extract `src/sdk/` as the stable contract surface.** `contract.ts` re-exports the Connector
   types (`types.ts` stays the physical source for now — a later, import-touching move) + exports
   machine-readable `CONTRACT_OBLIGATIONS`; `README.md` states the obligations in prose for an author.
2. **A fixture-driven conformance harness** `describeConformance(connector, fixtures, opts)` asserts
   the **8 hard** (runner-enforced) + the **soft** obligations. **Two layers:** a *contract layer*
   (always; fixture-driven; transport-agnostic — sidesteps the per-connector mock diversity of
   fetch/IMAP-client/WS-socket) and an optional *integration layer* (drives the real `syncConnection`
   via the connector's own mock + a DB, gated on `DATABASE_URL`).
3. **Reuse, don't fork.** The harness imports the real `tableForObject`/`buildUpsert` (`runner.ts`) +
   `REGISTRY` (`schema.ts`), so a check can never drift from what the runner actually does.
4. **Non-invasive.** No connector was rewritten — the harness ran across all 7 and they **conform
   as-is** (zero corrective fixes). Home Assistant is a documented exemption (`emitsNoRecords`: an
   empty-`sync()` push connector that owns its own writes) — it still asserts the type/policy/action
   obligations.
5. **Internal module now; `@pci/sdk` package + the agent-authoring sandbox later.** Scaffolding, not
   concrete: the seam is established; publishing it + the execution sandbox is the Phase-3 flywheel.

## Consequences

- Every connector — existing and future — is held to a *mechanical* bar; "green harness" = "won't
  corrupt the cache, won't leak secrets, deletions truthful, routes correctly."
- A future/community/AI connector author imports the contract, implements the interface, and runs the
  harness until green — no tribal knowledge, no maintainer review for contract-conformance.
- This is the **prerequisite for agent-authored connectors** (the Phase-3 moat): an agent can iterate
  against a pass/fail gate safely.
- Follow-ups (recorded, non-blocking): a vacuous-pass guard when `live:[]` on a non-exempt connector;
  consume-or-drop the latent `fetchRecordLiveStores` opt; S9 (cursor round-trip) asserted not just
  listed; the physical `types.ts → sdk` move; publishing `@pci/sdk`.
