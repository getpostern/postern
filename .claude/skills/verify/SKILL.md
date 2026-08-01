---
name: verify
description: Run this repo's verification gate — typecheck, the unit suite, the DB-backed suite. Load before running tests, pointing DATABASE_URL anywhere, or reporting a unit done.
---

# Verification gate

This file is the one place the repo's verification commands are written down. Other skills point here rather than restating them. Run the ones your change can reach; run all five before declaring a unit done.

| Command | Covers | Note |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` over **`src/` only** — `tsconfig.json:include` is `["src"]` | Never sees `apps/web`. Green here says nothing about the Console. |
| `npm run typecheck --prefix apps/web` | The Console's own `tsc --noEmit` | Its own tsconfig, its own React types. Worth running whenever you touched `apps/web`. |
| `npm run build --prefix apps/web` | `tsc --noEmit && vite build` | The bundle proof on top of the typecheck. This is the Console leg of a merge gate. |
| `npm test` | `vitest run` over the whole repo, including `apps/web/**/*.test.tsx` | DB suites skip without `DATABASE_URL` — see below. |
| `npm run test:db` | The whole DB-backed suite, against **a throwaway Postgres of its own** | Needs no `db:up`, no compose file, and **works from a worktree**. Brings up its own container (`pci-throwaway-testdb`, port `55432`, **no volume**) and starts the runtime if needed. |
| `npm run test:db:file -- <path>` | **One** DB-backed file, same throwaway | ~2 s instead of ~40 s for all 170. Anything after `--` reaches vitest, so `-t "name"` works too. |
| `npm run test:db:reap` | Removes the throwaway container | Nothing persists in it anyway; this is just disk. |

CI runs, in this order: `npm ci` · `npm ci --prefix apps/web` · `npm run typecheck` · `npm run typecheck --prefix apps/web` · `npm run build` · `npm run migrate` · `npm test` · `npm run lint` · `npm audit --omit=dev --audit-level=high`. Read `.github/workflows/ci.yml` — it is the authoritative sequence.

## The test-DB guard — the detail behind the CLAUDE.md rule

CLAUDE.md states the rule (disposable `*_test` DB only; `PCI_TEST_DB=1` is a full bypass). What it doesn't carry, and what makes the rule concrete:

**Which suite does the damage.** `src/rest/admin.db.test.ts` drives the revoke/erase paths, deleting seed-user `provider_credentials` and FK-cascading every domain row beneath them. On **2026-06-17 a run against the live `pci` database destroyed ~700 real finance rows** that way (ADR `docs/specs/decisions/0015-test-db-isolation.md`).

**Where the guard is, and where it is wired — two different files.** The check itself is `assertDisposableTestDb` at `vitest.globalSetup.ts:66`. The **wiring** is not in that file at all: `vitest.config.ts:13` is the `globalSetup: ["./vitest.globalSetup.ts"]` line that makes vitest run it once before any test module and abort the whole run on a non-`_test` DB name. Inside `vitest.globalSetup.ts` the entry point vitest calls is `export default function setup()` at `:226`, which runs the ordered `PREFLIGHTS` list (`:174`) via `runPreflights` (`:209`). *(Line numbers drift — if one of these does not land on what this sentence says, `grep -n` the symbol and correct this line. A citation that has slid is how a reader concludes the guard moved or vanished.)*

**The scope of the bypass, stated once.** `PCI_TEST_DB=1` disables the guard entirely, everywhere — not just on the mini. Nothing in this repo needs it: CI sets a `*_test` `DATABASE_URL` instead (`.github/workflows/ci.yml`). Do not set it. If the guard is refusing a run, the DB name is the thing to fix.

And don't hand-assemble a `DATABASE_URL`: `npm run test:db` hardcodes `postgres://pci:pci@localhost:5432/pci_test`, creates it, migrates it, runs the suite.

Parallel worktree children need a **unique** `*_test` DB each, not this shared one — mechanics in `../merge-and-reconcile/references/worktree-setup.md`.

## Children run their own DB tests now — against a database that is nobody's production

⚠️ **CHANGED 2026-07-26 by operator ruling.** The former rule — *children never start Docker; the DB gate belongs to the mother* — is **lifted**. Children may run `npm run test:db` and `test:db:file` themselves.

**Why it changed.** Under the old rule a child could WRITE db-backed tests but never RUN them, so every wave shipped cells marked *"written but unrun by me"*. That is how a test-that-cannot-fail gets authored: on 2026-07-26 the **security-critical** cell of `remote-access-observed` had a self-contradictory fixture — it seeded the stranger set with the very address it then asserted had never been reached — and the throw made **four assertions below it unreachable**, including the one guarding the 409 refusal. A capable agent wrote that purely because it was working blind (#123).

**What makes it safe now** — `scripts/test-db.sh` (read its header; it is the honest description):

- **It brings its own Postgres.** A separate container on port **55432**, with **no volume**, created by the script. Operator's constraint, and the reason: *"as long as it is test, and they are not messing up with a production instance of postern running on the same machine."* A self-hoster develops on the machine they deploy on, so `postern-db-1` is not a dev container there — it is their **live gateway's database**. The script never starts, stops, connects to, or reads it, and asserts that it isn't about to.
- **`docker exec`, never `docker compose`.** Compose does not resolve from a worktree ("no configuration file provided") — that was the technical blocker all along.
- **A database per branch**, so parallel children never share one. Concurrent callers on one database truncate each other's rows; four #43-family flakes were exactly that. `main` keeps `pci_test`, so every existing instruction still means what it meant.
- **The name is fail-closed** to `^[a-z0-9_]+_test$` and can never be `pci`, and `assertDisposableTestDb` in `vitest.globalSetup.ts` still runs as an independent second layer.

**Still true, and still binding:** never live `pci` · **never `PCI_TEST_DB=1`** · never a hand-assembled `DATABASE_URL` (hard-denied — a run against live `pci` destroyed ~700 real finance rows on 2026-06-17, ADR 0015). The script builds the DSN so no caller ever types one.

**The mother still runs the full gate on the merged tree** — a child's green run on its own branch does not compose with its siblings'.

## A green `npm test` proves less than it looks

With no `DATABASE_URL`, DB-gated suites **skip** — they do not fail. Measured 2026-07-24 on `main`:

- No DB: **113 files pass, 34 skip (147)** · **1641 tests pass, 416 skip, 1 todo (2058)**.
- With a `*_test` DB: all 147 files run.

A skip count far below 34 means the DB suites actually ran — check what database they ran against. A skip count of 34 in a run you *believed* was DB-backed means Docker is down or the env var didn't reach vitest.

## The CI footgun

`apps/web` is a separate npm project with its own lockfile, but root vitest **collects its `.test.tsx` files** (`vitest.config.ts` adds only `.claude/**` to vitest's default excludes). Without `npm ci --prefix apps/web`, every Console suite dies on `Cannot find package 'react'` and the run is red. This killed CI for 12 days — 50 consecutive red runs — because the failure looks like a dependency glitch rather than a missing install step.

The fix is the install step, which is now `.github/workflows/ci.yml:59`. **Do not "fix" it by excluding `apps/web` in `vitest.config.ts`** — that drops real tests and turns a loud failure into a silent one.

Same trap locally, but it no longer arrives in costume: `assertConsoleDepsInstalled` in `vitest.globalSetup.ts` runs beside the test-DB guard and aborts the run with one sentence naming the fix. `npm ci --prefix apps/web` — or `npm run setup`, which does both installs.

**What "runs" covers, measured not asserted.** Both preflights fire on every entry path that resolves the **root** vitest config — `npm test`, `npx vitest` (run or watch) from the repo root, `npm run test:db` / `test:db:file`, an IDE runner pointed at the root, and a worktree (a repo root of its own). They do **not** fire when vitest resolves a *different* config: `cd apps/web && npx vitest run <file>` loads `apps/web/vite.config.ts`, which declares no `globalSetup`, so `vitest.globalSetup.ts` is never imported and **neither** preflight runs — including the destructive-DB one. Probed 2026-07-26 with a marker inside the entry point: root run → printed, `apps/web` run → not printed. Nothing under `apps/web` is a `*.db.test.*` and no Console test opens a pool, and `apps/web/package.json` has no `test` script, so that path reaches no destructive suite **today**; it is one `apps/web/**/*.db.test.ts` away from doing so. Do not restate this as "every entry path" — an asserted property the topology does not have is binding-in-error.

**Cost of the no-bypass Console preflight, stated plainly.** Before it existed, a fresh clone with only the root install still ran the ~136 backend files (the 29 Console suites went red). Now the run aborts before the first test module, so **zero** tests execute — including a single backend file that has nothing to do with the Console. There is no env override, by design (#94 asked for none). The remedy is one command and ~1 s: `npm run setup`, or `npm ci --prefix apps/web`.

## Debugging a red CI run

`gh run list`, then `gh run view <id> --log-failed`. The log is flooded with per-query stderr instrumentation, so the real failure is buried — grep for `Cannot find\|FAIL\|Failed Suites` to find it fast.
