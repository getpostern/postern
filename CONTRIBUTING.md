# Contributing to Postern

Thank you for being here. This file is short on ceremony and long on the things that are genuinely expensive to learn the hard way — most of them were learned that way.

## Get set up

```bash
npm run setup          # npm ci at the root AND in apps/web — both, always
npm run typecheck      # ESM + NodeNext; this is the gate that catches import mistakes
npm test               # the unit suite
```

**`npm run setup`, not `npm ci`.** The root Vitest config collects the Console's `.test.tsx` files, but a root-only install does not install React. Skip the `apps/web` half and you get a wall of red suites and "Cannot find package 'react'" — which looks like a broken repository and is not. If you ever find yourself tempted to "fix" that by excluding `apps/web` from `vitest.config.ts`: don't. It drops real tests and turns a loud failure into a silent one.

To run the gateway itself while you work on it, layer the dev compose file over the quickstart one — it is an **overlay**, not a standalone file, and it replaces the published image with a build from your working tree:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env   # once; compose refuses to start without it
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Running the database-backed suite

**The `*.db.test.ts` suite issues real `INSERT` and `DELETE`. Run it only against a disposable database.**

```bash
npm run test:db
```

That is the supported path and the only one you should need. It brings up a throwaway Postgres of its own — separate container, separate port, no volume — so it cannot see, contend with, or damage a real gateway running on the same machine. That matters more here than in most projects: a self-hoster develops on the machine they deploy on, so the `db` container next to you may be somebody's live gateway holding real financial, health and mail data.

`npm test` alone needs no database at all: with `DATABASE_URL` unset the DB-gated tests self-skip.

> **Why the guard exists.** On **2026-06-17** the DB suite was run against the live application database. It deleted a seeded credential and the foreign-key cascade took roughly **700 finance rows** with it. A fail-closed preflight in `vitest.globalSetup.ts` now aborts the entire run unless `DATABASE_URL` names a database ending in `_test`. There is an override, `PCI_TEST_DB=1`, and it is a **complete bypass of that guard**. Nothing in normal development needs it. Do not set it, do not suggest it in a review, and do not add a second one. See [ADR 0015](docs/specs/decisions/0015-test-db-isolation.md).

## The rules that bite

**Relative imports need a `.js` extension.** This is ESM with NodeNext resolution, so `import { x } from "./thing.js"` — even though the file on disk is `thing.ts`. `npm run typecheck` enforces it, which is why typecheck runs before tests and not after.

**Only registry table and column names ever reach SQL, and every value is parameterized.** Never build a query string from agent input. The schema registry (`src/core/schema.ts`) is both the read contract the agent sees *and* the write allow-list the ingest path enforces — it is one list, on purpose, and widening it widens both.

**`amount` is signed and negative means money out.** Provider-agnostic: Plaid is positive-out and gets negated on write, SimpleFIN passes through. Account balances follow the same rule — a liability owed is negative everywhere. `available_balance` deliberately does not: it is left exactly as each provider reports it. If you touch a finance connector, this is the invariant most likely to be silently broken by a "cleanup".

**Migrations take `max(version) + 1`.** They are forward-only, immutable, checksum-guarded and applied under an advisory lock; there are no down migrations. Editing a migration that has already been applied anywhere does nothing except break the checksum. And **`0015` is permanently reserved** — a renumbering left that slot empty, and back-filling it would make the sequence ambiguous for every install that already skipped it. Take the next free number after the highest, always. See [ADR 0010](docs/specs/decisions/0010-migrations.md).

**A test that cannot fail is worse than no test.** This repository's signature defect is correct code sitting behind a vacuous guard — a fixture that makes an assertion unreachable, a condition true in every environment, a pair of tests green apart and red together. The only reliable check is to **run the mutation**: break the thing the test guards, and confirm the test goes red. If it doesn't, the test is decoration.

## The best thing you can contribute: a connector

Connectors are the extension surface, and the one place where breadth actually comes from. A new source is a connector plus a schema-registry entry plus a migration — **never** a control-plane change, and never a join between domains.

Start here, in this order:

1. **`src/sdk/contract.ts`** — the compile-time contract a connector implements: authenticate, sync and normalize, declare strong keys and a sync policy, and where the source allows it, declare an action catalog and execute actions. Import the *contract* module from shipping code, never the `sdk/index.js` barrel (that drags the Vitest-based harness into the production build — `src/sdk/README.md` explains exactly how, and it is subtler than it sounds).
2. **The conformance harness** — `describeConformance` is fixture-driven and mechanically passes or fails a connector against those obligations. It is the gate that makes a connector you did not write trustworthy. See [ADR 0007](docs/specs/decisions/0007-connector-sdk-conformance.md).
3. **The `new-connector` skill** (`.claude/skills/new-connector/`) — the full walkthrough for a connector, a registry object or a migration. **The `verify` skill** (`.claude/skills/verify/`) is the verification gate: typecheck, the unit suite, the DB-backed suite. Both ship in this repository and both are worth reading whether or not you drive an agent with them.

A hard-won rule from that path: **capture one real provider response as a golden fixture during your first exploration, and fail loudly at the boundary.** A connector built entirely against a faked transport can ship green and store zero rows against the real service — one shipped that way because a library returned camelCase where the protocol used kebab-case, and the mismatch was handled by a silent skip. A changed-object with no body, or a multiget whose response count does not match the request, must be an error, not a `continue`.

## Things that are decided, and what it takes to change them

Some of these will look like obvious improvements. They were considered; the reasoning is written down, and the place to reverse one is a new ADR in `docs/specs/decisions/`, not a pull request that quietly does it.

- **No LLM runs inside the gateway.** The agent reasons; we validate and execute deterministically.
- **No derived data is written into the store.** Postern is a faithful cache. Deterministic *within-sector* cross-provider deduplication is normalization and is in scope; cross-*domain* semantic entity resolution is not.
- **Permission is domain-level only.** A granted sector covers read and act across every provider in it. No per-connector, per-action or per-call gating, and no confirmation prompts.
- **Audit is asynchronous and detective.** It is fire-and-forget, off the response hot path. Do not await it.
- **Postgres is the cache.** No Redis, no second cache tier.
- **`AuthContext` is the mandatory first argument** of every data-returning core function and of `invokeAction`.

[`CLAUDE.md`](CLAUDE.md) carries the same list in the form an agent working in this repository needs; the indexed ADRs at [`docs/specs/decisions/`](docs/specs/decisions/) carry the reasoning behind each one.

## Sending a patch

1. Open an issue first for anything larger than a fix — it is cheaper to disagree about a design in an issue than in a diff.
2. Branch, and keep the change to one concern.
3. Green means `npm run typecheck`, `npm test`, `npm run lint`, and `npm run test:db` if you touched anything database-backed. Say in the PR which of those you ran.
4. Explain **why**, not just what. If a review is going to ask "why not the simpler thing?", answer it in the description.
5. If your change makes a statement in `CLAUDE.md`, an ADR, `docs/SETUP.md` or `setup-with-your-agent.md` false, fix it in the same PR. A document that is ahead of or behind the code is a defect, not a chore.

### Developer Certificate of Origin

Contributions are accepted under the **[Developer Certificate of Origin 1.1](https://developercertificate.org/)**. There is no CLA and no copyright assignment. Sign off every commit:

```bash
git commit -s -m "your message"
```

which appends `Signed-off-by: Your Name <your@email>`. That line is your statement that you wrote the change, or have the right to submit it, under the project's license.

### License of your contribution

Inbound is the same as outbound: **Apache-2.0**. By submitting, you agree your contribution is licensed under it — section 5 of the licence says the same thing, and the sign-off is how you state it deliberately. The Postern name and door mark are not licensed with the code — see [`TRADEMARK.md`](TRADEMARK.md).

## Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
