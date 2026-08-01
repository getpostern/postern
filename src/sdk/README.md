# `@pci/sdk` — the connector contract

A connector is the one unit of extension in pci-gateway: it **authenticates**, **syncs + normalizes**
reads into the local store, declares **strong keys** + a **sync policy**, and — where the source
supports it — declares an **action catalog** + **executes** actions. It never correlates or derives.

This module is the **stable surface** a connector author imports. Today it re-exports the compile-time
contract from `connectors/types.ts` (the physical move of those types into the SDK, and publishing this
as a real `@pci/sdk` npm package, are deferred follow-ups). The value it adds today is making the
contract **explicit and mechanically verified**: the obligations below, plus `describeConformance` — a
fixture-driven harness that asserts them against any connector.

**Two entry points, and which one you use depends on whether the file SHIPS.** The barrel
(`sdk/index.ts`) re-exports both the contract and the Vitest-based conformance harness, so importing
it from shipping connector code drags the harness into the production build — see the note below.

```ts
// In a connector's SHIPPING source (src/connectors/<provider>.ts) — the contract module, never the barrel:
import type { Connector, RawRecord, SyncContext } from "../sdk/contract.js";

// In its TEST files only (*.conformance.ts, *.conformance.test.ts) — the barrel is fine here:
import { describeConformance, type ConformanceFixtures } from "../sdk/index.js";
```

> ⚠️ **Never import `sdk/index.js` from a file that ships.** `tsconfig.build.json` keeps the barrel
> and `sdk/conformance.ts` out of `dist/` because the harness `import`s `vitest`, a devDependency the
> runtime image does not install (`npm ci --omit=dev`). But `exclude` only prunes the include glob —
> a file that an *included* file imports is pulled back into the program and emitted regardless, and
> **`import type` is enough to do it**. One such import in a connector re-emits `dist/sdk/index.js`
> and `dist/sdk/conformance.js` with `npm run build`, `npm run typecheck` and the whole suite green;
> the next person who changes that `import type` to a value import gets `ERR_MODULE_NOT_FOUND` on
> "vitest" at container boot. `src/packaging.release.test.ts` asserts the build program is clean, so
> this is now caught rather than shipped — but the fix is to import from `contract.js` in the first
> place. (Earlier revisions of this file documented the barrel for both cases; that was the bug.)

## How to add a connector (and prove it conforms)

1. Implement `Connector` (see `connectors/types.ts` for the full interface + per-member JSDoc).
2. Write representative **conformance fixtures** — a `src/connectors/<provider>.conformance.ts`
   exporting a `ConformanceFixtures` (the `RawRecord`s your `sync()` would emit: at least one live
   record per `object` per sector, plus any deletion records + `deletionPairs`). Where a `RawRecord`'s
   `raw` needs a synthetic key your `sync()` threads on (`__pci_parent` / `__pci_folder` / `__pci_metric`),
   the fixture carries it — the harness feeds the records exactly as `sync()` would.
3. Add `src/connectors/<provider>.conformance.test.ts`:
   ```ts
   describeConformance(new MyConnector(), MY_FIXTURES);
   ```
4. `npm run typecheck` + `npm test` must be green. The harness's **contract layer** runs with no DB or
   transport (pure over your fixtures + connector instance). The optional **integration layer** (below)
   drives the real `syncConnection` via your own mock.

## The contract (what the harness enforces)

### Hard — the runner enforces these today (a violator throws/breaks at runtime)

- **H1** Every emitted record's `(servedSector, rec.object ?? connector.objectType)` resolves via
  `tableForObject` to a REGISTRY entry. (Else the runner throws — no table is ever guessed.)
- **H2** `normalize()` emits **only** keys in that entry's REGISTRY `fields` allow-list.
- **H3** `normalize()` returns a **non-empty string** `source_object_id`.
- **H4** `buildUpsert` accepts the injected row — conflict target `(connection_id, source_object_id)`.
- **H5** Deletion records carry `deleted:true` and a **non-empty string** `externalId`.
- **H6** The runner injects `connection_id`/`user_id` from the context (**never** the payload),
  `raw = rec.raw`, and `deleted_at = null` on live writes. *(integration layer)*
- **H7** The cursor advances only from a **non-null** `rec.cursor`; a null run keeps the prior.
  *(integration layer)*
- **H8** `fetch_live` persists **nothing** core-side. *(integration layer)*
- **H-types** The required `Connector` members are present (compile-time; the harness adds a runtime
  presence guard).

### Soft — convention/review-only today; the harness makes them mechanical

- **S1** Errors are **secret-free** — a credential (token / app-password / access URL) never appears in
  a thrown or returned message. *(integration layer; `secretLeakFree` embeds a sentinel and proves it
  never surfaces)*
- **S2** `fetchRecordLive` stores **nothing** connector-side. *(integration layer)*
- **S3** `strongKeys` is **deterministic + stable** and returns a `Record<string,string>`.
- **S4** A read-only `execute()` **throws**; an action connector **rejects** an unknown action id.
- **S5** Action connectors **validate params** against their `ActionSpec`. *(Deferred this wave — a
  documented `it.todo`. Only Home Assistant has actions and its catalog is known-unwired per ADR 0003;
  hard-required when the read|act split + the first new action connector land.)*
- **S6** The **static** `(sector, objectType)` is a valid REGISTRY pair.
- **S7** A deletion's `externalId` uses the **same id scheme** as the live `source_object_id`, so a
  tombstone (`where source_object_id = rec.externalId`) actually hits the live row.
- **S8** A live `RawRecord.externalId` is a **non-empty string**.
- **S9** The cursor is **round-trippable** (no dup/skip when re-fed). *(integration layer)*
- **S10** `normalize` returns a **plain object** (not `null`, not an array).
- **S11** `normalize` does **not** emit the uuid PK `id`. (Note: H2 *permits* `id` — the REGISTRY lists
  it — so S11 is the real guard against leaking the gateway's own primary key.)
- **S12** `policy.mode ∈ {push, poll, on_demand}`; a `poll` policy declares a **positive**
  `defaultIntervalSec`.

The machine-readable form of this list is `CONTRACT_OBLIGATIONS` in `contract.ts`.

## The two layers

- **Contract layer (always).** Pure over your `ConformanceFixtures` + connector instance — no DB, no
  transport. Runs H1–H5, H-types, S3, S4, S6, S7, S8, S10, S11, S12. This sidesteps per-connector mock
  diversity (fetch vs an IMAP client-class vs a WS socket).
- **Integration layer (optional, `describe.skipIf(!DATABASE_URL)`).** Pass `opts.integration =
  { setup, teardown, ctx }`. `setup()` inserts the connection rows + installs your existing mock;
  `ctx()` returns a `ConformanceIntegrationCtx` (connectionId/userId/table/probe + the hook callbacks
  `runProductiveSync` / `runFetchLive` / `runLeakySync`). The harness then drives the **real**
  `syncConnection` to assert H6, H7, H8/S2, and S1 end-to-end. Reuse your `<provider>.db.test.ts`
  setup pattern, and use a **dedicated throwaway user UUID** so it never races the db-test.

**Reuse, don't fork.** The harness imports `tableForObject` / `buildUpsert` from `sync/runner.ts` and
`REGISTRY` from `core/schema.ts` — it checks the *same* logic the runner runs, so it can never drift
from production behavior.

## The Home Assistant exemption (ADR 0007)

Home Assistant is the **documented outlier**: a **push** connector that bypasses the
`sync → normalize → upsert` pipeline. `start()` opens a WebSocket and HA owns its own writes,
tombstones, and a **storing** `fetchRecordLive`. Run it with `emitsNoRecords:true` +
`fetchRecordLiveStores:true`: the harness **skips** the emit-driven contract checks
(H1–H3, H5, S7, S8, S10, S11) and still asserts H-types, S6, S12, and its action surface (S4 — HA is
action-rich via `listActions`; S5 is the deferred `it.todo`). HA's hand-rolled tests
(`ha-ws.test.ts`, `homeassistant.test.ts`, `homeassistant.db.test.ts`) remain authoritative for the
WebSocket specifics.

**Agent-authored connectors must pass this harness.** It is the gate that makes adding the Nth source
cheap and safe — the contract is explicit, and "did you honor it?" is a test, not a review opinion.
