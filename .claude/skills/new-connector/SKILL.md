---
name: new-connector
description: Add or change a source connector, a REGISTRY object, or a migration. Load before writing anything in src/connectors/, src/core/schema.ts, or db/migrations/.
---

# Adding or changing a connector

## The contract is already code — read it, don't re-derive it

`src/sdk/contract.ts` → `CONTRACT_OBLIGATIONS` is the machine-readable contract (H1–H8 + H-types enforced by the runner; S1–S12 convention, made mechanical by the harness). `src/sdk/README.md` is its prose mirror and carries the 4-step "how to add a connector (and prove it conforms)" recipe — follow that, and read the per-member JSDoc in `src/connectors/types.ts` rather than any summary of it.

The harness is `describeConformance` from `src/sdk/index.js`: a **contract layer** (pure, no DB, no transport, drives your `ConformanceFixtures`) plus an optional **integration layer** that drives the real `syncConnection` through your own mock to prove H6/H7/H8/S1/S2. `src/connectors/icloud-calendar.conformance.ts` + `.conformance.test.ts` is the smallest complete pair to model on; the Home Assistant exemption (a push connector that owns its own writes) is documented in the README.

**⚠️ `docs/agent-authored-connectors.html:151` renders a `Connector` interface with three members (`sync`/`normalize`/`strongKeys`). That is positioning material for readers, NOT the contract.** The real interface is `src/connectors/types.ts:131` and has twelve members. Build from the HTML and you build the wrong thing.

## The golden-fixture rule — the one that has actually bitten

Faked-transport tests cannot catch a real provider's response *shape*. They assert that your code handles the shape your fake emits, which is the shape your code already expects. That is a tautology, and it shipped a connector that stored zero rows.

The iCloud DAV connector passed its whole suite green and then stored **0 rows** against real iCloud: `dav-core` read bodies off the on-the-wire kebab key `calendar-data`, but tsdav camelCases response elements to `calendarData` and CDATA-wraps the body as `{_cdata: "..."}`. Only the live smoke caught it. The fix and the warning now live at `src/connectors/dav-core.ts:255`.

So, for any new source:

- **Capture ONE real provider response during recon and commit it as a golden fixture.** Recon means an actual authenticated call against the real API before you write the parser — not the vendor docs' example payload, which is frequently idealized or stale.
- **Fail LOUD at the parse boundary.** A changed object that arrives without a body, or a multiget whose result count doesn't match the hrefs requested, is an **error** — never a silent `continue`/skip. A silent skip turns a shape mismatch into "synced ok, 0 rows", which no test and no dashboard will flag. (This hardening is still owed on `dav-core` itself — see the #26 line in `docs/BACKLOG.md`.)
- **Live-smoke before you call it done.** Green tests are necessary and not sufficient for a connector; row counts against the real account are the acceptance signal.

## What a connector declares

- **`policy: SyncPolicy`** on the class — `mode` (`push` | `poll` | `on_demand`), `pushKind` for push, `defaultIntervalSec` for poll, and `minIntervalSec`, the floor for user cadence overrides. **A floor needs cited evidence in the comment beside it** — the provider's own rate-limit or budget doc and the arithmetic. `src/connectors/simplefin.ts:226` and `src/connectors/whoop.ts:293` are the shape to copy.
- **`actions: ActionSpec[]`** — `[]` for read-only, and then `execute()` throws (S4). A surface too dynamic to enumerate statically implements `listActions()` and serves it **from cache**, never a live call (Home Assistant is the proving case).
- **`strongKeys()`** — deterministic and stable across runs (S3). Recorded now, used by chapter-3 resolution later.
- **Cache footprint** — this is the connector's choice, and the sync engine doesn't change either way. Bounded sources (finance, home, calendar, contacts, health) cache every row in full. Unbounded sources (mail; later Drive/Notion) cache only the envelope, bounded by the per-connection recency window the runner threads in as `SyncContext.windowDays`, and fetch bodies on demand via `fetchRecordLive`.

## Wiring a new provider in

Register the connector in `src/bootstrap.ts:33` — the registry is keyed by `provider`, so a credential that fans out to several sectors registers **one** composite entry whose sub-connectors branch on `ctx.sector` (`apple` → mail+calendar+contacts is the worked case; microsoft and google are the same pattern).

Onboarding is a separate seam and it is UI-first: a paste-a-token provider needs a REST route (`POST /api/onboard/apple` at `src/rest/admin.ts:218` is the fan-out exemplar) plus a Console tile; an OAuth provider goes through the BYO-app flow and needs its scope→sector mapping in `sectorsForScopes` (`src/rest/oauth-routes.ts:72`). A connector that can only be connected by editing a file or an env var is a product gap, not a shipped connector.

## Honest state of the gate

There are **10 `*.conformance.test.ts` suites for 12 connector classes** — `apple` (the composite) and `apple-health` have none, and nothing currently fails because of it. Passing conformance is a strong convention and a review expectation; it is **not** yet mechanically enforced. Write the suite anyway; a missing one is a merge-gate argument you will lose.

## REGISTRY objects, domain tables, migrations

`references/registry-and-migration.md`.

## Gate

Typecheck, the unit suite, and the DB-backed suite for anything DB-backed — commands and the test-DB rules are the `verify` skill's. Then the live smoke above, which no local gate can substitute for.
