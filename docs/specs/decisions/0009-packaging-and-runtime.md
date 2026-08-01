# ADR 0009 — Packaging & runtime (Docker-first, durable)

**Status:** accepted · **Date:** 2026-06-13 · **Wave:** 9A (`runnable-container`)

## Context

The gateway ran as a dev artifact: `tsx` over raw TS, no compiled build, no Dockerfile, the Console only
served via the Vite dev proxy, nothing stopped on exit (5 lifecycle handles discarded), `pool` with no
error handler (an idle-client error crashed the process), and no health probe. Not software anyone can
install + leave running. V1 packaging = **Docker compose**.

## Decision

1. **Compiled build.** `npm run build` = `tsc` → `dist/` (`.js` import extensions already in use → `node
   dist/index.js` runs natively); the run image is `npm ci --omit=dev` (no `tsx`).
2. **Multi-stage Dockerfile + `docker compose up`** (app + Postgres). Db has a `pg_isready` healthcheck;
   the app waits on it (`depends_on: condition: service_healthy`) and has a `/healthz` healthcheck. A
   **named volume persists the master key** (`/app/.pci`) — else a restart regenerates it and every
   sealed secret becomes undecryptable.
3. **PID-1 / signals.** `ENTRYPOINT` **execs** node (`sh -c "node …migrate.js && exec node …index.js"`)
   so node is PID 1 and receives `SIGTERM` directly — without `exec` the shell swallows the signal,
   graceful shutdown never runs, and `docker stop` SIGKILLs after the grace period.
4. **Graceful shutdown** (`index.ts`, idempotent + hard-timeout → `exit(1)`): stop scheduler → stop push
   → close HTTP/REST edges → close stdio → **drain audit last** (after enqueuers quiesce) → `pool.end()`.
5. **`/healthz`** (bare): liveness 200; readiness `select 1`; **503 while shutting down** (drains a probe
   from rotation). **`db.ts`** gains `pool.on('error')` (never crash), `awaitDbReady()` (boot retry),
   `closePool()`, and pool tuning.
6. **Console served same-origin.** A path-traversal-safe static handler serves `apps/web/dist` with SPA
   fallback to `index.html` (vue-router history routes resolve); `/api` misses still 404 JSON.
7. **Bind posture (security).** The container binds `0.0.0.0` INTERNALLY (required for the port map), but
   the **host publishes loopback-only** (`127.0.0.1:8787:8787`, and the db `127.0.0.1:5432:5432`). The
   no-bearer admin/key-mint surface must NOT be LAN-reachable — the Host-allowlist is a same-origin guard,
   NOT per-request auth. Deliberate LAN exposure = change the publish + set `REST_ALLOWED_HOSTS`.
8. **Migrate at boot + entrypoint**, fail-closed (ADR 0010).

## Consequences

- `docker compose up` brings up a durable, self-migrating, Console-serving gateway anyone can self-host
  locally; clean `docker compose stop`.
- npm/npx + an stdio→HTTP shim are a fast-follow (wave 11); a non-root runner user is set, distroless +
  multi-arch are later hardening.
- A pre-existing test (`bootstrap.test` "serves the REST app") asserted a non-`/api` 404 as its mounted
  smoke; the SPA fallback now serves 200 there, so it was repointed to an `/api` miss (deterministic 404)
  at merge.
