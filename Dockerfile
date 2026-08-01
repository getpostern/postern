# syntax=docker/dockerfile:1
#
# Multi-stage build for the Postern gateway's durable container.
#  - builder: install ALL deps (incl. tsc), compile the gateway TS -> dist/, and build the Console SPA.
#  - runner:  production deps only (no tsx / no build toolchain), compiled artifacts, non-root.
# The server migrates in-process (forward-only, fail-closed) before any edge serves — see ENTRYPOINT.

# ── Builder ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Reproducible install from the lockfile (dev deps included — tsc/vite live there).
COPY package.json package-lock.json ./
RUN npm ci

# Compile the gateway: tsc -> dist/. Relative imports already use .js extensions, so dist runs
# natively under node (no loader). tsconfig already emits (outDir:dist, rootDir:src).
# BOTH tsconfigs are needed: `npm run build` compiles tsconfig.build.json, which `extends` the root
# tsconfig.json for every compilerOption and only narrows what is emitted (no tests/fixtures in dist).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Build the Console SPA (its own package + lockfile) -> apps/web/dist, served same-origin at runtime.
# SAME-ORIGIN BY CONSTRUCTION (ADR 0035 §D4): the Console's GATEWAY_URL defaults to "" in
# apps/web/src/api/client.ts, so every request is RELATIVE and the gate's address is whatever address
# the browser reached it on (127.0.0.1:8787, a LAN IP, a tailnet name). NEVER pass VITE_GATEWAY_URL
# here — baking an absolute origin into the image is what made the Console accuse itself of being
# down at every address but one. The default lives in the client, not on this line, so no build path
# anywhere (CI, a contributor's box, a future packaging step) can re-bake one.
COPY apps/web ./apps/web
RUN cd apps/web && npm ci && npm run build

# ── Runner ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# OCI image metadata. `source` is load-bearing, not decoration: GHCR links a package to its repository
# through THIS label — without it the published package has no repo, defaults to private, and renders
# no README on its page. `licenses` is an SPDX expression (AGPL-3.0-or-later, matching LICENSE and
# both package.json files); `description`/`title`/`url` are what a registry lists the image by.
LABEL org.opencontainers.image.title="Postern" \
      org.opencontainers.image.description="Postern — the Personal Context Gateway: connect the sectors of your life once, then read them and act on them from any agent through one neutral surface." \
      org.opencontainers.image.source="https://github.com/getpostern/postern" \
      org.opencontainers.image.url="https://github.com/getpostern/postern" \
      org.opencontainers.image.documentation="https://github.com/getpostern/postern#readme" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.vendor="Postern"

# Production-only deps (omit dev: no tsx, no compilers in the runtime image).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled gateway, the built Console, and the SQL the migrator applies (db/ holds schema.sql +
# the forward-only db/migrations the entrypoint runs via dist/db/migrate.js).
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY db ./db

# Master-key dir — a named volume mounts here in compose. Pre-create + own it as `node` so the fresh
# volume inherits node ownership and first-boot key autogen (mode 0600) can write it. WITHOUT a
# persistent .pci volume a restart regenerates the key and every sealed secret becomes undecryptable.
RUN mkdir -p /app/.pci && chown -R node:node /app/.pci
USER node

ENV REST_PORT=8787
#
# ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
# │  RUN THIS IMAGE LOOPBACK-SCOPED.                                                              │
# │                                                                                              │
# │      SAFE    docker run -p 127.0.0.1:8787:8787 …     ← the address prefix is the whole point  │
# │      UNSAFE  docker run -p 8787:8787 …               ← publishes on 0.0.0.0, to your network  │
# └──────────────────────────────────────────────────────────────────────────────────────────────┘
#
# WHY IT MATTERS FOR THIS IMAGE SPECIFICALLY. Port 8787 carries the Console AND the admin surface:
# onboarding, credential paste, audit read, and `POST /api/agents`, which MINTS AN AGENT KEY with
# access to every granted sector. That group has NO per-request authentication — no bearer, no
# password, no session. What guards it is a Host-header allowlist, and a Host header is a string the
# client chooses. Anyone who can reach the port can send `Host: localhost:8787` and mint a key; it is
# one curl away, and the reply is 201 with the key in it. The allowlist is a DNS-rebinding guard —
# it stops a browser on an attacker's page from reaching you — and it was never authentication.
#
# So the ONLY thing standing between that surface and the network is the address you publish it on.
# `-p 8787:8787` with no address means 0.0.0.0: every interface, reachable from the LAN, and on Linux
# it is inserted into DOCKER-USER/nat ahead of most host firewall rules, so a UFW/firewalld "deny"
# does not stop it. `-p 127.0.0.1:8787:8787` is reachable only from the machine itself. Same for the
# MCP port: it is bearer-gated, which is real authentication, but keep it local too unless you are
# deliberately publishing it. To reach the Console from another machine, terminate an AUTHENTICATED
# tunnel or reverse proxy on loopback (`tailscale serve`, an SSH tunnel, a proxy that authenticates
# before it forwards) — never move the publish address.
#
# GIVEN THAT, the in-container bind below is 0.0.0.0 and that is correct. The code's own default is
# 127.0.0.1 (src/bootstrap.ts, src/mcp/http.ts) and stays right for `npm start` on a laptop — but
# inside a container a loopback bind is CONTAINER-loopback, so any `-p` mapping reaches nothing and
# the Console times out with no error anywhere. The security boundary is the host-side publish
# address, not the in-container bind: binding 127.0.0.1 inside would buy no safety (it is the
# publish that exposes) while breaking every correct deployment. docker-compose.yml has always set
# these two to 0.0.0.0 for exactly this reason and still does — an `environment:` value overrides an
# image ENV, so compose's behaviour is byte-identical — and it publishes on 127.0.0.1 only.
ENV REST_HOST=0.0.0.0
# Same reasoning for the MCP edge. Harmless when MCP_HTTP_PORT is unset: the edge is opt-in on the
# PORT, so with no port there is no listener for this host to apply to.
ENV MCP_HTTP_HOST=0.0.0.0
# Documentation only — EXPOSE publishes nothing and grants nothing. It records the port for tooling;
# the publish address above is the decision that matters.
EXPOSE 8787

# Start the server. `exec` so node replaces the shell as PID 1 and receives SIGTERM DIRECTLY — without
# it `docker stop` signals the shell (which doesn't forward), node never runs graceful shutdown, and the
# container hangs the grace period then SIGKILLs.
#
# NO SEPARATE MIGRATE STEP. This used to be `node dist/db/migrate.js && exec node dist/index.js`, and
# that prefix was strictly worse than nothing: migrate.js opens ONE pg.Client with no retry, so any
# gap before Postgres accepts TCP (a cold `docker run` against a starting DB; compose's `pg_isready`
# healthcheck probes the UNIX SOCKET, which can go ready before the TCP listener) killed the container
# on a race that the server itself is built to survive. src/index.ts already runs awaitDbReady()
# (30 attempts, 250ms doubling to a 5s cap) and THEN runMigrations(), fail-closed, before any edge
# serves a byte — same migrator, same advisory lock, same refusal to start on a bad migration. So the
# guarantee is unchanged and the race is gone. `node dist/db/migrate.js` still ships and still works
# as a manual/one-shot entrypoint override for an operator who wants to migrate without booting.
ENTRYPOINT ["node", "dist/index.js"]
