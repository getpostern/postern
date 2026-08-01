#!/usr/bin/env bash
#
# Run the DB-backed suite against a THROWAWAY POSTGRES OF ITS OWN — from anywhere, including a
# worktree, without the caller ever typing DATABASE_URL, and WITHOUT TOUCHING THIS PROJECT'S
# `db` CONTAINER AT ALL.
#
# WHY IT BRINGS ITS OWN DATABASE
# -----------------------------------------------------------
# The rule it obeys: a test run must never touch a production instance of Postern running
# on the same machine. A self-hoster develops on the machine they deploy on, so
# `postern-db-1` is not a dev container there — it is their LIVE gateway's database,
# holding real financial, health and mail data. Creating test databases inside that instance would
# put a `create database` and a full migration one guard-failure away from it, and would contend for
# its connections while a real gateway serves.
#
# So: a SEPARATE container, a SEPARATE port, NO volume (ephemeral by construction). This is the same
# shape that rule requires. It cannot see the project's `db` container, its
# volumes, or its data, and stopping/removing it can never affect a running gateway.
#
# WHY IT EXISTS AT ALL
# ---------------------------
# Until today a worktree child could WRITE db-backed tests but never RUN them, so every wave shipped
# cells marked "written but unrun by me". That is how a test-that-cannot-fail gets authored: on
# 2026-07-26 the SECURITY-critical cell of `remote-access-observed` had a self-contradictory fixture
# and the resulting throw made FOUR assertions below it — including the one guarding the 409 refusal
# — permanently unreachable. A capable agent wrote that purely because it was working blind.
#
# `docker compose` is deliberately not used: it does not resolve from a worktree (no compose file
# there — "no configuration file provided"). Plain `docker run`/`docker exec` are cwd-independent.
#
# SAFETY — layered, because this is the command class that once destroyed real data. Stated in the
# order the script APPLIES them, because that is the part that decides whether they mean anything: a
# refusal that runs after the thing it refuses is not a guard. (It used to run after the boot block.)
#   a) BEFORE any `docker` command runs at all — before `--reap`, before any start or create — the
#      project's own database container name and its published port (5432) are REFUSED. So on the
#      topology this repo ships, this script cannot start, stop, remove, connect to or read the
#      project's `db` container. The name test covers compose's generated `<project>-db-1` /
#      `<project>_db_1` shapes, not just this project's, since the project name is a local choice.
#   b) The database name must match ^[a-z0-9_]+_test$ and may never be `pci`. Fail-closed, here.
#   c) Once its Postgres answers, and BEFORE it creates or migrates anything, the script enumerates
#      that cluster's databases and refuses if it finds one that is not `postgres`, a template, or a
#      `*_test`. A live gateway's cluster holds `pci`; a throwaway this script owns never holds
#      anything else. This is the layer that covers what (a)'s literals cannot: a self-hoster who set
#      `container_name:` or republished the port can still POINT the env overrides at their own live
#      cluster, and no name/port literal would know. That case is not structurally impossible — it is
#      refused before the first write, which is the honest claim. Precisely: a container that gets
#      past (a) may be STARTED and READ (it has to answer before it can be interrogated); what (c)
#      guarantees is that nothing is created in it and no migration runs.
#   d) Its Postgres is a container this script owns, on its own port, with no volume, so nothing it
#      does there can persist or contend with a running gateway.
#   e) The caller never supplies a DSN; this script builds it. `DATABASE_URL=` is hard-denied for a
#      reason: a run against live `pci` wiped ~700 real finance rows on 2026-06-17 (ADR 0015).
#   f) `assertDisposableTestDb` in vitest.globalSetup.ts still runs and still aborts on a non-`_test`
#      name. This script does not replace that guard; it feeds it a safe value.
#
# The two `PCI_TESTDB_*` overrides below exist so a second port/name is available when 55432 or the
# default name is taken. They are the only way to reach anything but this script's own throwaway, so
# every guard above is written to keep working while they do their job. One residual they carry, since
# an unstated one is worse than a known one: (a) and (c) inspect the CONTAINER (`docker exec`), while
# the DSN handed to migrate and vitest dials `PCI_TESTDB_PORT` on the HOST. A container's published
# port is fixed when it is created, so setting `PCI_TESTDB_PORT` to something the named container does
# NOT publish points the DSN at whatever else listens there. Set the pair together, or `--reap` first.
#
# Usage:
#   scripts/test-db.sh                          # whole suite
#   scripts/test-db.sh src/foo.db.test.ts       # one file
#   scripts/test-db.sh --reap                   # remove the throwaway container and stop
set -euo pipefail

IMAGE="postgres:16"                                   # matches docker-compose.yml's db service
CONTAINER="${PCI_TESTDB_CONTAINER:-pci-throwaway-testdb}"
PORT="${PCI_TESTDB_PORT:-55432}"                      # NOT 5432 — that is where a real gateway lives
LOCK="${TMPDIR:-/tmp}/pci-testdb-boot.lock"

# ── SAFETY (a): assert we are not pointed at the project's own database, BEFORE anything runs ─────
# This block must stay above EVERY docker invocation, including `--reap` (which is `docker rm -f`) and
# the boot block (whose `docker start` would START a stopped live gateway's database). It sat below
# the boot block until 2026-07-26; the header's own safety claim was false for exactly that reason.
# Container names: compose derives `<project>-db-1` from the directory, so the literal below is only
# this checkout's spelling of it — match the shape, not one project's name.
case "$CONTAINER" in
  db|*-db-[0-9]*|*_db_[0-9]*|postern-db-1)
    echo "REFUSED: '$CONTAINER' is the shape of a compose-managed database container, which on a" >&2
    echo "         self-hosted box is a LIVE gateway's database. Nothing was started, stopped or read." >&2
    echo "         Pick any other name for PCI_TESTDB_CONTAINER." >&2
    exit 1;;
esac
if [ "$PORT" = "5432" ]; then
  echo "REFUSED: 5432 is where this project publishes its own Postgres. Nothing was started or read." >&2
  echo "         PCI_TESTDB_PORT must be some other port; the default 55432 is already one." >&2
  exit 1
fi

if [ "${1:-}" = "--reap" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "removed $CONTAINER" || echo "nothing to remove"
  exit 0
fi

# ── the database name: derived from the branch so parallel children never share one ──────────────
# Concurrent callers on ONE database truncate each other's rows — four flakes of one family were exactly
# that. `main` keeps the historic `pci_test`, so the mother's gate still means what it always meant.
if [ -n "${PCI_TEST_DB_NAME:-}" ]; then
  DB="$PCI_TEST_DB_NAME"
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "HEAD" ]; then
    DB="pci_test"
  else
    SLUG="$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/_/g; s/^_//; s/_$//')"
    DB="pci_$(printf '%s' "$SLUG" | cut -c1-45)_test"
  fi
fi

# ── SAFETY (b): fail closed on anything not obviously disposable ─────────────────────────────────
case "$DB" in
  pci|postgres|template0|template1) echo "REFUSED: '$DB' is not a disposable test database." >&2; exit 1;;
esac
if ! printf '%s' "$DB" | grep -Eq '^[a-z0-9_]+_test$'; then
  echo "REFUSED: database name '$DB' must match ^[a-z0-9_]+_test\$ — the guard that exists because a" >&2
  echo "         run against live 'pci' destroyed ~700 real finance rows on 2026-06-17 (ADR 0015)." >&2
  exit 1
fi

# ── bring up OUR postgres, serialised so N children do not race the runtime ──────────────────────
# `mkdir` is the portable atomic lock: whoever wins starts things, the rest wait for the result.
if ! docker exec "$CONTAINER" pg_isready -U pci -q >/dev/null 2>&1; then
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    docker info >/dev/null 2>&1 || {
      echo "==> starting the container runtime"
      colima start >/dev/null 2>&1 || open -a Docker >/dev/null 2>&1 || true
      for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
    }
    if ! docker start "$CONTAINER" >/dev/null 2>&1; then
      echo "==> creating throwaway postgres '$CONTAINER' on :$PORT (no volume — nothing persists)"
      docker run -d --name "$CONTAINER" \
        -e POSTGRES_USER=pci -e POSTGRES_PASSWORD=pci -e POSTGRES_DB=postgres \
        -p "127.0.0.1:$PORT:5432" --tmpfs /var/lib/postgresql/data "$IMAGE" >/dev/null
    fi
  else
    echo "==> another run is starting the test database; waiting"
  fi
  for _ in $(seq 1 90); do docker exec "$CONTAINER" pg_isready -U pci -q >/dev/null 2>&1 && break; sleep 2; done
fi
docker exec "$CONTAINER" pg_isready -U pci -q >/dev/null 2>&1 || {
  echo "ERROR: throwaway postgres '$CONTAINER' never became ready. Nothing was run." >&2; exit 1; }

# ── SAFETY (c): prove the cluster we reached is disposable, BEFORE creating or migrating in it ────
# (a) is a name/port test, so it only knows the topology this repo ships. This one asks the cluster
# what it holds: a throwaway this script owns holds `postgres` and `*_test` databases and nothing
# else, while a live gateway's cluster holds `pci`. Fail-closed — if the enumeration itself fails we
# cannot claim the cluster is disposable, so we refuse rather than write into an unknown.
# The `PCI_SCAN:` sentinel is deliberate: a check that treats "no output" as "clean" passes when the
# query never ran (psql does not exit non-zero for every SQL error), which is this repo's signature
# defect. Silence is now a REFUSAL, not a pass. psql's own stderr is left un-captured so you see why.
SCAN="$(docker exec "$CONTAINER" psql -U pci -d postgres -tAc \
     "select 'PCI_SCAN:' || coalesce(string_agg(datname, ' ' order by datname), '') from pg_database
        where not datistemplate and datname <> 'postgres' and datname !~ '_test\$'" || true)"
SCAN="$(printf '%s' "$SCAN" | tr -s '[:space:]' ' ' | sed 's/^ *//; s/ *$//')"
case "$SCAN" in
  "PCI_SCAN:") ;;                                     # nothing but postgres, templates and *_test
  "PCI_SCAN:"*)
    echo "REFUSED: '$CONTAINER' holds database(s) that are not disposable test databases:" \
         "${SCAN#PCI_SCAN:}" >&2
    echo "         A throwaway this script owns only ever holds 'postgres' and *_test — a cluster with" >&2
    echo "         anything else is somebody's real Postgres (a live gateway's holds 'pci'). Nothing" >&2
    echo "         was created or migrated. PCI_TESTDB_* is pointed at a database that is not ours." >&2
    exit 1;;
  *)
    echo "REFUSED: could not enumerate the databases in '$CONTAINER', so it cannot be shown to be a" >&2
    echo "         disposable test cluster. Nothing was created or migrated." >&2
    exit 1;;
esac

docker exec -i "$CONTAINER" psql -U pci -d postgres -c "create database $DB" >/dev/null 2>&1 || true
echo "==> $DB on $CONTAINER:$PORT (throwaway)"
DATABASE_URL="postgres://pci:pci@localhost:$PORT/$DB" npm run --silent migrate

# ── run ───────────────────────────────────────────────────────────────────────────────────────────
# `--no-file-parallelism` STAYS, and is now a BACKSTOP rather than the fix. What
# changed: the two collisions that made the wave-A gate answer differently on each run are fixed at
# the source, with a cross-file test mutex on the table each pair fights over
# (src/test-support/advisory-lock.ts) — `oauth_bridge_clients` for the two bridge suites and
# `gateway_exposure` for the three exposure suites. Both were mutation-verified by forcing the overlap
# and un-sharing the key: RED 3/3, then GREEN 3/3 with the same fixture. So those files are now correct
# under EITHER mode, which matters because this flag only covers THIS entry path — an IDE runner or a
# bare `npx vitest` with DATABASE_URL set has always run them in parallel.
#
# Why the flag is not removed yet, stated plainly instead of assumed away: ONE known global-state cell
# remains — `src/gateway/exposure-config.db.test.ts` "the address is never treated as a secret" reads
# `count(*) from secrets` before and after and asserts NO delta, which any concurrently inserting file
# breaks. Its honest fix is not obvious (a vault row cannot be attributed to a writer from SQL), so it
# is recorded, not guessed at. And nobody has yet soaked the WHOLE db set in parallel, so the unknown
# remainder is unmeasured. A gate that answers differently on each run is worse than a slow one; the
# serialized suite runs in ~11s, so this costs approximately nothing. Remove it only WITH a soak.
DATABASE_URL="postgres://pci:pci@localhost:$PORT/$DB" npx vitest run --no-file-parallelism "$@"
