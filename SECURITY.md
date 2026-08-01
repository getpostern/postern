# Security

Postern holds a person's finances, health, mail, contacts, calendar and home. This document states exactly what protects them, and — more importantly — what does not. Nothing here is aspirational: if a protection is best-effort, it says so.

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository: the **Security** tab → **Report a vulnerability**. That opens a private advisory visible only to the maintainers.

There is no security mailbox. Please do not open a public issue for anything exploitable, and please do not disclose publicly before a fix is available.

Include what you would want to receive: the version or commit, the topology (loopback only? behind a tunnel? published?), the exact request, and what an attacker gains. A proof of concept against a throwaway install is worth more than a description.

## The trust boundary, stated plainly

**Trusted:** the person who owns the gateway, and the machine it runs on. Anyone with an interactive session on that machine already has your database, your vault key file and your browser.

**Not trusted:** everything else — the network the box sits on, other devices in the house, web pages your browser has open, and any agent holding a key.

Every design decision below follows from that line, and the line is drawn where it is because Postern is self-hosted personal software, not a multi-tenant service.

## What actually guards what

### The admin surface has no authentication. Reachability is the authorization.

Port 8787 serves the Console and the admin API together: onboarding, credential paste, the audit read, the full export, erase, and the route that **mints an agent key**. That group has no bearer, no password and no session. What sits in front of it is a `Host`-header allowlist, and the `Host` header is a string the client chooses.

The allowlist is a **DNS-rebinding guard** — it stops a web page on someone else's site from reaching your gateway through your browser. It is not authentication and was never meant to be. Anyone who can reach the port can send `Host: localhost:8787` and mint a key with one request, no credentials, and the key comes back in the response.

**So the whole boundary is the address the port is published on.**

```
SAFE      docker run -p 127.0.0.1:8787:8787 …     reachable only from this machine
UNSAFE    docker run -p 8787:8787 …               reachable from your whole network
```

The bare form is not "the default" — it means `0.0.0.0`, every interface. On Linux, Docker's publish rules sit ahead of most host firewalls, so a `ufw deny 8787` does **not** save you. The compose file in this repository publishes `127.0.0.1`-only, and that prefix is the reason it is safe to run.

To reach the Console from another machine, do not move the publish address. Put something that authenticates in front of it and have that terminate on loopback: `tailscale serve`, an SSH tunnel, or a reverse proxy that authenticates before forwarding. The port stays local; the tunnel carries the identity.

`REST_ALLOWED_HOSTS` widens which `Host` values are *accepted*. It adds no identity check, so it does not make the admin surface safe to publish.

### The bearer-gated MCP edge is the surface designed to face a tunnel

Port 8788 is different, and it is the only surface built for remote agents. Every call carries a per-agent bearer token, checked per request, resolved to a default-deny grant, and audited. That is authentication.

Grants are **domain-level**: a granted sector covers reading *and* acting across every provider in it. There is no per-connector, per-action or per-call gating, and no confirmation prompt — those were considered and rejected, deliberately, in [ADR 0003](docs/specs/decisions/0003-ha-action-model.md). The one carve-out is that Home Assistant's admin and system service domains are denylisted from both the action catalog and dispatch.

Revoking or rotating a key takes effect on the next call, not the next session handshake, and it kills every OAuth-bridge token derived from that key in the same transaction ([ADR 0034](docs/specs/decisions/0034-sync-error-classification-and-session-revocation.md)). Rotation *is* the compromise response.

If you publish this edge to the internet — which is supported, opt-in, and never a default — read [`docs/runbooks/remote-access.md`](docs/runbooks/remote-access.md) in full first. It states exactly which routes become anonymously reachable, why "expose only `/mcp`" is not achievable, and what to harden before you arm it. Two things matter most: give every cloud-facing key an **expiry**, and assume the endpoint is **discovered** — enabling tailnet HTTPS publishes the hostname to a public Certificate Transparency ledger, so hostname obscurity has zero security value.

Behind a Tailscale Funnel there is **no recoverable client address**, so any rate limiter is necessarily global — one bucket for the whole internet. Setting `MCP_TRUSTED_PROXIES` does not change that; it is useful only when you front the gateway with a proxy of your own that genuinely supplies a client address. The honest cost is narrow: a stranger who finds your URL can disrupt *connection setup*. No data is exposed, no key is at risk, and the reads and actions behind `/mcp` stay bearer-gated throughout.

### The push-ingest route is intentionally not loopback-only

`POST /api/ingest/:connectionId` has no `Host` allowlist and no bearer, because a phone has to reach it. Its gate is a per-connection 256-bit secret, compared in constant time, fail-closed, and giving no oracle about whether the connection id exists ([ADR 0008](docs/specs/decisions/0008-push-ingest.md)). Exempting this route does not unguard anything else — admin, OAuth and Plaid remain behind the allowlist.

### The vault encrypts credentials. It does not encrypt your data.

This distinction matters and is easy to get backwards.

**Sealed in the vault:** OAuth access and refresh tokens, app-specific passwords, SimpleFIN access URLs, Home Assistant tokens, Plaid item tokens, provider client secrets. They are stored encrypted and referenced from rows only by an opaque `secret_ref`. They are never written into a data row, never returned by any route, and never logged.

**Not encrypted by Postern:** the cached personal data itself — your transactions, mail envelopes, calendar events, contacts, health samples. Those are ordinary rows in your Postgres. They are protected by database access control and by whatever disk encryption your machine provides, and by nothing else that this project supplies. If you want them encrypted at rest, encrypt the volume.

The vault's master key lives in a Docker volume mounted at `/app/.pci`, not in your repository checkout. `docker compose down -v` destroys it and every sealed credential with it. Boot is fail-closed: a gateway whose resolved key cannot open the credentials it needs **refuses to start** rather than booting green and failing at the first sync. There is no bypass flag, on purpose ([ADR 0033](docs/specs/decisions/0033-vault-key-fail-closed-boot.md)).

### The audit log is detective, not preventive — and it is best-effort

Every agent read and every action is logged with the agent, the sector, the decision and the outcome. That log is written **asynchronously, off the response path, and is not awaited**. A write that fails is dropped.

So: the audit log tells the owner what happened. It is **not a security control**, it cannot deny anything, and no flow should depend on a line having been written. It is a lower bound on activity, and the direction of that error is safe for the question it answers ("is this key still in use?") — a dropped line can only make a key look quieter than it was.

### Things that look like authorization and are not

- **The `Host` allowlist** on the admin, OAuth and Plaid routes — a same-origin guard, per above.
- **The `confirm` token on `POST /api/erase`** — a fat-finger guard so nobody destroys a sector by fumbling a request. It is server-resolvable, so it stops mistakes, not attackers.
- **A tailnet hostname.** Never add one to `REST_ALLOWED_HOSTS`: that opens every no-authentication admin route to every peer on your tailnet.
- **Hostname obscurity**, for anything published. See above.

## What the code does structurally

Some properties are enforced by shape rather than by vigilance, and they are the ones worth knowing when you review a patch:

- **Only registry table and column names ever reach SQL.** Every value is parameterized. Agent input never becomes an identifier; the schema registry is both the read contract and the ingest write allow-list.
- **`AuthContext` is the mandatory first argument** of every data-returning core function and of `invokeAction`. `assertSector` denies before any SQL runs, and every read is scoped to the user.
- **Secrets are never stored in rows** — only a `secret_ref` into the vault.
- **`union:%` is a reserved id namespace** for deduplication synthetics; the ingest path fail-closed rejects any provider record that tries to plant or tombstone one.
- **No LLM runs inside the gateway.** The agent composes queries and actions; Postern validates and executes them deterministically. There is no prompt to inject into on this side of the wire.

## Scope

**In scope:** anything that lets a party outside the trust boundary read data, act on a source, obtain a credential or a key, escalate a grant beyond its sectors, or reach the admin surface from a non-loopback origin. Also: secrets appearing in logs, responses or error messages; a fail-closed gate that fails open; SQL built from agent input.

**Out of scope**, because they are the documented design:

- The admin API having no per-request authentication when reached from loopback.
- An agent key reading everything within its granted sectors — that is what a grant means.
- Cached personal data not being encrypted at rest by the application.
- Anything requiring an interactive session on the box, or the owner's own browser being already compromised.
- Publishing port 8787 to a network yourself.

**Supported versions:** the latest release. This is pre-1.0 software; fixes land on `main` and in the next tag rather than being backported.
