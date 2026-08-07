# Postern — working notes for an agent in this repo

Neutral gateway for **Postern** (the Personal Context Gateway): connect the sectors of your life once, reach them from any agent through one surface. Read your life **and act on it** where the source allows; **no cross-domain correlation**. A faithful cache, not a derived store — the agent reasons; we authenticate, normalize, store, serve, and dispatch. Three properties decide ties: **one place** (one surface, one grant), **lightning fast** (reads from local cache in ms; actions add zero gateway overhead around the one unavoidable dispatch), **harness-agnostic** (swap the harness, keep the context, capabilities, permission and audit).

**Build for the world, not one box.** Every decision is for *all* the people who will run this. A real deployment with real accounts exists to **verify** a design against real data, never to **decide** one. When "right for this box" and "right for everyone" diverge, the holistic answer wins.

*This file is for an agent working on the code. If you are setting a gateway up for someone, read [`AGENTS.md`](AGENTS.md). If you are sending a patch, read [`CONTRIBUTING.md`](CONTRIBUTING.md).*

## Gotchas

The things that are expensive to learn the hard way. Most were.

- **Tests run ONLY against a `*_test` database.** The `*.db.test.ts` suite issues real `INSERT`/`DELETE`. A run against a live application DB wiped ~700 finance rows on 2026-06-17. A fail-closed guard in `vitest.globalSetup.ts` aborts unless `DATABASE_URL` matches `/_test$/`; **`PCI_TEST_DB=1` is a full bypass of that guard** and must never be set against a real database. Use `npm run test:db` — it brings its own throwaway Postgres and cannot touch a running gateway.
- **`npm test` needs `apps/web` deps installed** — root vitest collects the Console's `.test.tsx` files but a root-only install does not install them. Without `npm ci --prefix apps/web` (i.e. `npm run setup`) you get a wall of red suites and "Cannot find package 'react'". Never "fix" that by excluding `apps/web` from `vitest.config.ts`: it drops real tests and makes a loud failure silent.
- **The vault master key lives in the container volume, NOT in a `./.pci/master.key` on the host.** Backing up a host copy yields a tarball that fails at restore with a silent `SecretAuthError`. Extract the key from the *running* container. **Never `docker compose down -v`** — removing the volume orphans every stored credential.
- **Relative imports need `.js` extensions** (ESM + NodeNext). `npm run typecheck` enforces it.
- **`amount` is signed, negative = money out** — so `spending = amount < 0` is the provider-agnostic predicate. Plaid is positive-out and gets **negated on write**; SimpleFIN passes through. Account balances follow the same rule (a liability owed is negative everywhere). `available_balance` is left as each provider reports it.
- **`union:%` is a reserved `source_object_id` namespace** for dedup synthetics. `applyRecords` fail-closed rejects any provider record that plants or tombstones one.
- **The loopback `Host` allowlist is the only authz on the admin/OAuth/Plaid routes.** It is a same-origin/DNS-rebinding guard, not per-request auth. The `erase` confirm token is a fat-finger guard, not auth either. The bearer-gated read mirror is intentionally separate. [`SECURITY.md`](SECURITY.md) states the whole boundary.
- **This project is Apache-2.0, so a GPL/AGPL/SSPL dependency poisons the distribution.** Adding one is a licence violation, not a preference — check before you add a dep, and never resolve an audit finding by pulling in copyleft. One MPL-2.0 dependency (`ical.js`) is fine and already recorded in `THIRD-PARTY-NOTICES.md`.
- **Cloud MCP clients egress on port 443 only.** A tunnel on any other port silently TCP-resets — the client will simply never connect and tell you nothing.
- **A test that cannot fail is this repo's signature defect.** Correct code behind a vacuous guard accounts for most of the blocking review findings in its history. The only reliable check is to run the mutation: break what the test guards and confirm it goes red.

## Invariants

Violating these is how a *helpful* agent breaks the product. They change only by a new ADR.

- **Lossless gateway.** Expose whatever the credential supports — reads AND actions. Never exceed the source grant. Actions go OUT to the source, then a targeted re-sync reflects the result; they never fabricate rows.
- **Never write derived data into the store.** Annotations and derived facts are later chapters, not V0.
- **No `source_events`, no cross-*domain* semantic entity resolution, no `derived_facts`.** Deterministic *within-sector* cross-provider dedup (finance) IS in V0 — that is normalization, not the deferred kind.
- **No LLM on our side.** The agent composes queries and actions; we validate and execute deterministically.
- **`AuthContext` is the mandatory first argument** of every data-returning core function and `invokeAction`; `assertSector` denies before any SQL runs. Every read is user-scoped.
- **Only REGISTRY table and column names ever reach SQL; all values are parameterized.** Never build SQL from raw agent input. The REGISTRY is both the read contract and the ingest write allow-list.
- **Permission is DOMAIN-LEVEL only** — a granted sector covers read and act across every provider in it. No per-connector, per-action, tier, or confirmation gating. (One carve-out: Home Assistant admin/system services are denylisted from catalog and dispatch.)
- **Audit is async and detective, never preventive.** It is fire-and-forget off the response hot path. Do not await it, and do not add a confirmation prompt — both instincts are wrong here.
- **Postgres IS the cache.** No Redis, no second cache tier in V0. The only worthwhile in-memory caching is `get_schema` / `describe_context`.
- Secrets are never stored in rows — only a `secret_ref` into the vault.

## Shape

- **Control plane** (`db/schema.sql` — its header carries the domain-table template, tombstone rule and column conventions): `users` → `secrets` → `provider_credentials` (one row per consent) → `connectors` (one row per credential×sector) → `agent_grants` (default-deny) → `audit_log`.
- **`connectors.id` IS the `connection_id`** on every domain row. One credential fans out to N sector connectors — and each Plaid Item is its *own* credential, so **one bank = one connection**. There is no single "Plaid connector"; any doc implying one is wrong.
- **A new sector is a new table plus a REGISTRY entry — never a control-plane change.** No joins between domains.
- `src/core/` is the API core: seven primitives — `describeContext`, `getSchema`, `query`, `getRecord`, `fetchLive`, `listActions`, `invokeAction`. **Everything else is an adapter over core.** MCP (`src/mcp/`) maps 1:1 onto them; REST mirrors the reads plus the onboarding/admin contract. Never a second implementation.
- `query`/`get_record` are always cache-only and instant. `fetch_live` is the one read-time upstream path.

## Where the detail lives

Load these when the work calls for them, not before.

| Need | Go to |
|---|---|
| Run the tests / verify a change | skill `verify` (`.claude/skills/verify/`) |
| A connector, REGISTRY object, or migration | skill `new-connector` (`.claude/skills/new-connector/`), then `src/sdk/contract.ts` and `src/sdk/README.md` |
| The Console UI (`apps/web`) | `docs/design/soul.md` — the paper/ink constitution. Styles are CSS Modules with tokens as custom properties; inline `style={{…}}` is banned for anything a stylesheet can express (ADR 0031) |
| Freshness / sync cadence semantics | `src/core/freshness.ts` — the ONE derivation. Never re-derive it in an adapter or the FE |
| Finance cross-provider dedup | `src/core/finance-dedup.ts`, ADR 0021 / ADR 0022 |
| Why something is the way it is | `docs/specs/decisions/` — the ADRs, indexed in that directory's README |
| Installing and connecting sources | `docs/SETUP.md` |
| The trust boundary | `SECURITY.md` |
| Sending a patch | `CONTRIBUTING.md` |

## Working in here

- **Decisions are written down before they are built.** Anything that binds the build — a shape, a constraint, a rejected alternative — belongs in an ADR under `docs/specs/decisions/`, numbered next after the highest. An ADR states the *why* and what may not change without a new decision; it is not a tutorial.
- **A claim in a doc that the code has made false is a defect,** not a chore. Fix it in the same change that made it false.
- **Verify before you report done:** `npm run typecheck`, `npm test`, `npm run lint`, and `npm run test:db` for anything database-backed. Run the mutation on any test you added.
- **Optimize for the person.** Measure every decision against the three properties above and "the most convenient thing for the user."
