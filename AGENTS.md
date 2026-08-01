# AGENTS.md — the setup contract

**Audience: an agent setting up Postern on behalf of the person who owns the box.** Not a contributor guide — if you are here to change the code, read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CLAUDE.md`](CLAUDE.md) instead.

You can drive nearly all of this over loopback HTTP. What you cannot do is register an OAuth application on someone's behalf, click their consent screen, or build a Shortcut on their phone. This document marks every step so you know which is which, and states the traps that have actually cost time — each one measured against the running code, not inferred from the shape of the API.

## Before anything else

**There is no OpenAPI document, no JSON schema endpoint, and no generated client.** The routes below are the contract, and they were read off the route registrations in `src/rest/index.ts` and the zod body schemas in `src/rest/admin.ts`, `src/rest/oauth-routes.ts`, `src/rest/plaid-routes.ts`, `src/rest/lifecycle-routes.ts`, `src/rest/erase-routes.ts` and `src/rest/exposure-routes.ts`. If you need certainty about a body shape, read the zod object — it is a dozen lines and it is the truth.

**The admin surface has no authentication.** Every route in the table below except the five bearer-mirror reads is guarded only by a loopback `Host`-header allowlist, which is a DNS-rebinding guard, not authorization. Reaching the port *is* the authorization. Practical consequences for you:

- You can call all of it with no credential. That is the design, not a lapse.
- `POST /api/agents` mints a key with access to whatever sectors you name, in one request, and returns it in the response body. Treat that response like a password.
- `GET /api/export` returns the entire store, unscoped by any grant. `POST /api/erase` is a real hard delete with no undo; its `confirm` token is a fat-finger guard, not auth.
- **Never propose widening the bind address or adding a hostname to `REST_ALLOWED_HOSTS` to make something convenient.** The allowlist widens what is *accepted*; it adds no identity check. [`SECURITY.md`](SECURITY.md) states the boundary.

Assume `http://localhost:8787` below. It is `REST_PORT`, and it moves.

## The ordered path

| # | step | who |
|---|---|---|
| 1 | `POSTGRES_PASSWORD=$(openssl rand -hex 24) docker compose up -d` | **agent** |
| 2 | Poll `GET /healthz` until `{"status":"ok"}`. Migrations run inside boot, so a 503 here is "not ready", not "broken" | **agent** |
| 3 | Obtain each provider secret — app-specific passwords, SimpleFIN setup tokens, Home Assistant tokens | **human** |
| 4 | Paste-class sources: `POST /api/credentials` then `POST /api/connectors` (or `POST /api/onboard/apple` for iCloud, which does both) | **agent** |
| 5 | OAuth-class sources: read the redirect URI from `GET /api/oauth/:provider/app` **first** | **agent** |
| 6 | Register the provider application and enter that exact redirect URI | **human** |
| 7 | `POST /api/oauth/:provider/app` with the client id (and secret where required) | **agent** |
| 8 | `GET /api/oauth/:provider/start` → open `authorizationUrl` in the person's browser | **agent** (opening); **human** (approving) |
| 9 | The callback creates one connector per covered sector. Confirm with `GET /api/connectors` | **agent** |
| 10 | Plaid: create the developer account and copy the keys | **human** |
| 11 | Plaid: `POST /api/plaid/app` → `POST /api/plaid/hosted-link` → open `hostedLinkUrl` | **agent** |
| 12 | Plaid: authenticate each bank in that hosted page | **human** |
| 13 | Plaid: `POST /api/plaid/poll` with the `linkToken` until `complete` | **agent** |
| 14 | Apple Health: `POST /api/credentials` (`provider: "apple_health"`) → `POST /api/connectors` (`sector: "health"`) → `POST /api/connectors/:connectionId/webhook` for the ingest URL and secret | **agent** |
| 15 | Apple Health: build the iPhone Shortcut that POSTs to that endpoint with that secret | **human** |
| 16 | `POST /api/connectors/:connectionId/sync` per connection, then watch `GET /api/connectors` for freshness | **agent** |
| 17 | `POST /api/agents` to mint the scoped key | **agent** |
| 18 | Put the key into the client's MCP config | **agent**, if it can write its own config; otherwise **human** |
| 19 | Publishing the gateway to the public internet, if a hosted client needs it | **human** — this is a consent decision, and the API enforces it with `acknowledged: true` |

Steps 3, 6, 10, 12, 15 and 19 are the irreducible human ones. Everything else is HTTP.

## The routes

Every path is registered in `src/rest/index.ts`. Bodies are JSON, capped at **1 MB** — except the push-ingest route, which allows **25 MB** because device exports are legitimately multi-megabyte. A validation failure is a 400 with a safe message; a non-loopback `Host` is a 403; an unknown path is a 404 and a wrong method is a 405 with an `allow` header.

### Onboarding

| method + path | body | notes |
|---|---|---|
| `POST /api/credentials` | `{ provider, secret, username?, instanceUrl?, purpose? }` | Static-token onboarding. → `201 { credentialId, provider, status }`. The secret is sealed and never echoed. `username` is mandatory for `gmail` (the full address). `instanceUrl` is read only by Home Assistant. SimpleFIN setup tokens are claimed to an access URL before sealing |
| `POST /api/connectors` | `{ credentialId (uuid), sector }` | → `201 { connectionId, sector, provider, status }`. The provider is copied from the credential, not from the body |
| `POST /api/onboard/apple` | `{ appleId, appSpecificPassword }` | One transaction: one `apple` credential plus **three** connectors (mail, calendar, contacts) |
| `GET /api/connectors` | — | Every connection, enriched with status and the derived freshness tuple |
| `GET /api/connectors/:connectionId` | — | One connection in detail |
| `DELETE /api/connectors/:connectionId` | `{ confirmToken? }` | Disconnect. The credential and its vault secret go only when its **last** connector goes |

### OAuth (`:provider` ∈ `google` \| `microsoft` \| `whoop`)

| method + path | body | notes |
|---|---|---|
| `GET /api/oauth/:provider/app` | — | → `{ provider, configured, clientId, confidential, redirectUri }`. **`redirectUri` is the single source of that string** — read it, never compose it |
| `POST /api/oauth/:provider/app` | `{ clientId, clientSecret? }` | The secret is sealed. Required for `google` and `whoop`; **rejected** for `microsoft` (public/PKCE client) |
| `DELETE /api/oauth/:provider/app` | — | Clears the configured app and its sealed secret |
| `GET /api/oauth/:provider/start` | — | → `{ authorizationUrl }`. 400 `ConfigError` if no client id resolves |
| `GET /api/oauth/:provider/callback` | — | The provider redirects here. Creates the credential and its connectors, then 302s into the Console |

### Plaid

| method + path | body | notes |
|---|---|---|
| `GET /api/plaid/app` | — | Configuration status; the secret never leaves the vault |
| `POST /api/plaid/app` | `{ clientId, clientSecret, env: "sandbox" \| "production" }` | All three required. Only the exact string `production` leaves the sandbox |
| `DELETE /api/plaid/app` | — | Clears it |
| `POST /api/plaid/hosted-link` | — | → `{ linkToken, hostedLinkUrl }`. No DB write; the link token is short-lived and is not a credential |
| `POST /api/plaid/poll` | `{ linkToken }` | → `{ complete, connections: [{ connectionId, itemId, institutionName, health }] }`. Idempotent — an already-consumed token is skipped |
| `POST /api/plaid/relink` | `{ connectionId (uuid) }` | Update-mode link for a broken Item |
| `POST /api/plaid/link-token` · `POST /api/plaid/exchange` | — · `{ public_token }` | The legacy single-Item pair. Prefer hosted-link |

### Agent keys and grants

| method + path | body | notes |
|---|---|---|
| `POST /api/agents` | `{ agentId, sectors: string[], expiresInDays? }` | → `201 { agentId, sectors, key, expires_at }`. **The key is returned once.** Re-posting the same `agentId` is a rotate: it replaces the key and kills every OAuth-bridge token derived from the old one, in the same transaction |
| `GET /api/agents` | — | Never returns the key hash. Carries `last_seen_at` and per-sector `last_read_at` |
| `PATCH /api/agents/:agentId` | `{ sectors?, expiresInDays? }` | Both optional; a body with neither is a 400. `expiresInDays` is tri-state: **absent** leaves the deadline alone, a number sets it, explicit `null` clears it |
| `POST /api/agents/:agentId/revoke` | — | Immediate; cached MCP sessions are swept, not left to expire |
| `DELETE /api/agents/:agentId` | — | Only after revoke |
| `GET /api/audit` | — | Newest-first; `limit` defaults to 100 and caps at 1000 |

### Lifecycle, data control, and the operator reads

| method + path | body | notes |
|---|---|---|
| `POST /api/connectors/:connectionId/sync` | — | Sync now; bounded wait |
| `POST /api/connectors/:connectionId/pause` · `/resume` | — | |
| `POST /api/connectors/:connectionId/sync-window` | `{ days: number \| null }` | Mail recency window. `null` = all history. Changing it resets the cursor |
| `POST /api/connectors/:connectionId/sync-interval` | `{ interval_sec: number \| null }` | Strict body — an unknown extra key is a 400. `null` restores the connector default; the floor is connector-declared |
| `POST /api/connectors/:connectionId/webhook` | — | → `201 { ingestUrl, secret }`. Mints or rotates the push-ingest secret; returned once |
| `POST /api/credentials/:credentialId/revoke` | — | |
| `POST /api/erase` | `{ scope: "connection" \| "sector" \| "all", connectionId?, sector?, confirm }` | Hard delete, no undo. `confirm` must match a server-resolved value for the scope |
| `GET /api/export` | — | The whole store, unscoped |
| `POST /api/data/:sector` · `GET /api/data/:sector/:id` | query body · — | The Console's inspector: `query` / `get_record` as the box owner, all sectors, no grant filter |
| `GET /api/actions` | — | The action catalog — `{ actions, count, truncated }`. Dispatches nothing |
| `GET /api/operator/context` · `GET /api/operator/schema` · `POST /api/operator/fetch_live` | — · — · fetch-live body | The three primitives that otherwise exist only behind a bearer, served to loopback |
| `GET /api/finance/banks` · `GET /api/finance/dedup-candidates` · `POST /api/finance/dedup-confirmations` · `DELETE /api/finance/dedup-confirmations/:id` | — | Cross-provider dedup inspection and ground-truth confirmation |
| `GET /api/exposure` · `POST /api/exposure` · `DELETE /api/exposure` | — · `{ publicUrl, acknowledged: true }` · — | Publishing the gateway. `acknowledged` must be literally `true`; `publicUrl` must be a bare `https://` origin — no path, no port |

### The two surfaces that are *not* loopback-only

| method + path | gate |
|---|---|
| `GET /api/context` · `GET /api/schema` · `POST /api/query` · `GET /api/records/:sector/:id` · `POST /api/fetch_live` | Bearer, per request, grant-scoped, audited. This is the REST mirror of the agent reads |
| `POST /api/ingest/:connectionId` | The per-connection webhook secret, constant-time, fail-closed. Deliberately reachable so a device can push |
| `GET /healthz` | None — a probe must reach it. 503 while draining or when the DB is unreachable |

## The traps

Each of these has cost real time. None is discoverable from the route shapes.

**1. The consent window is 10 minutes, and it is single-use and in-memory.** `GET /api/oauth/:provider/start` stashes the PKCE verifier under a 10-minute TTL. If the human wanders off, the callback fails; start again. A gateway restart mid-consent also loses it. Do not build a flow that mints an authorization URL and comes back to it later.

**2. Sector strings are silently intersected at authentication time.** `POST /api/agents` accepts `sectors: string[]` with no validation. At *resolve* time the granted set is intersected with the sectors that actually exist — a typo is dropped without a word, and an empty granted set is not an error either: the agent connects fine and is denied on every single read. The valid set, derived from the schema registry, is exactly:

> `finance` · `health` · `mail` · `contacts` · `calendar` · `home`

`["*"]` expands to all of them. After minting, verify with `GET /api/agents` that the stored `sectors` are what you meant, or call `describe_context` with the new key and check what comes back.

**3. A provider-key typo creates a dead connection, quietly.** `POST /api/credentials` takes `provider` as a free string and `POST /api/connectors` copies it verbatim from the credential. Nothing validates it against the connector registry, so `simplefin ` with a trailing space, or `homeassistant` without the underscore, produces a perfectly healthy-looking credential and connector row that no connector implementation will ever claim — it simply never syncs. The exact registry keys, as each connector declares them:

> `simplefin` · `plaid` · `apple` · `apple_health` · `gmail` · `google` · `microsoft` · `whoop` · `home_assistant`

`sector` is equally unvalidated on `POST /api/connectors`. Use only the six sectors above.

**4. `has_more: true` means you are looking at a page, not an answer.** A read returns **100 rows by default and 500 at most**, whatever you ask for. `count` is what *this* response holds and is never a total — for a total, use `aggregate: {fn: "count"}` rather than counting rows. Deep paging is unsupported (`offset` caps at 5000): narrow with `where` instead. Ordering is deterministic within a snapshot, but offsets can shift as a sync lands rows. `in` takes at most 200 values.

**5. `amount` is signed and negative means money out.** Provider-agnostic, normalized on write — a Plaid positive-out amount is negated as it is stored; SimpleFIN passes through. So spending is `amount < 0`, and a plain `sum(amount)` nets income against spending, which is the most common wrong answer in this API. Account balances follow the same rule: a liability owed is negative everywhere. `available_balance` is left exactly as each provider reports it, so it does **not** follow the rule. `get_schema` carries the per-field statement — read `notes` and `fieldDocs` before composing any filter or aggregate.

**6. `REST_PORT` and the OAuth redirect URI are coupled.** The redirect this gateway sends is `http://localhost:<REST_PORT>/api/oauth/<provider>/callback`, composed from the same env var the edge listens on. Move the port and every registered redirect URI must move too, or consent fails at the provider with a mismatch that names a URI the human never typed. This is exactly why step 5 comes before step 6: read `redirectUri` from `GET /api/oauth/:provider/app` and register *that literal string*. The host half is pinned and never derived from the request `Host`, so you cannot fix a mismatch by changing how you call the gateway.

## Two more things worth knowing

**One credential fans out to N connections, and the connection id is what data rows carry.** Do not assume one provider equals one connection. Each Plaid Item is its own credential, so one bank is one connection; an iCloud paste produces three; a Microsoft consent produces up to three depending on the scopes actually granted.

**Audit is detective, not preventive.** Every mirror read and every tool call is logged asynchronously, off the response path, and the write is droppable by design. It tells the owner what happened; it never blocks anything, and it is not a security control. Do not build a flow that depends on an audit line having been written.
