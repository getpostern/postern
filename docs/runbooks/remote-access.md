# Remote access — reaching your gateway away from home (ADR 0024, ADR 0035)

The gateway binds **loopback only**, on purpose: a whole class of admin routes (mint an agent key, export everything, erase) has no credential check — reachability IS the authorization. So "remote access" never means "expose the gateway"; it means putting a private, encrypted front in front of exactly three surfaces that were DESIGNED for remote use:

| surface | port/path | its own auth |
|---|---|---|
| Device push-ingest (Apple Health etc.) | `:8787/api/ingest/<connection-id>` | per-connection 256-bit secret, constant-time, fail-closed |
| Remote MCP (agents) | `:8788/mcp` | per-agent scoped bearer |
| REST read mirror (non-MCP harnesses; optional) | `:8787` five read paths | same bearer, per-request, grant-scoped |

Everything else — the Console, onboarding, credentials, export, erase — stays loopback: reach it with `ssh -L 127.0.0.1:8787:127.0.0.1:8787 <host>` and open `http://localhost:8787`.

**Two tiers, and you choose.** Tier 1 (below) is tailnet-private and is the default; it covers every agent harness that runs **on your own devices**. Tier 2 — [a public `:443` endpoint](#going-public--the-443-endpoint-opt-in-and-supported) — is what hosted web clients (claude.ai, ChatGPT) require, and it is a **supported, first-class configuration** (ADR 0035 §D1), not a discouraged fallback. It is never a default, never a nudge, and never a side effect of another setting (ADR 0035 §D2): a gateway whose owner never opts in stays byte-identically loopback-only.

**Placeholders in this file.** `<machine>.<tailnet>.ts.net` in prose means "substitute your own name." In anything you can paste — env assignments, `curl` lines — the placeholder is the parseable `gateway.example-tailnet.ts.net`, because `<` and `>` are illegal in a hostname and would make the line fail before it reached the network. Neither form belongs to anybody; substitute your own.

## The default: Tailscale serve (tailnet-private)

Why this is the blessed path: traffic is end-to-end encrypted between your devices (WireGuard; the HTTPS cert's private key never leaves your box), nothing listens on the public internet, no port-forwarding (works behind CGNAT), the config survives reboots, and the free Personal plan (6 users, unlimited devices) covers a household. Install Tailscale on the gateway box + your phone/laptop, enable MagicDNS + HTTPS certs in the admin console, then:

```bash
# ingest — PATH-SCOPED: only /api/ingest is tailnet-reachable, never the admin surface
tailscale serve --bg --https=8443 --set-path=/api/ingest http://127.0.0.1:8787/api/ingest
# remote MCP — whole-port is safe (only /mcp exists; bearer-gated)
tailscale serve --bg --https=10000 http://127.0.0.1:8788
```

> **On macOS the `tailscale` CLI is usually not on `PATH`.** The App Store / GUI builds ship it inside the bundle at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (capital `T`), and `which tailscale` returns nothing — verified 2026-07-25 against Tailscale 1.98.9 on macOS. Linux and the standalone/open-source `tailscaled` packages do put `tailscale` on `PATH`. Every command below is written bare; on a GUI-build Mac, set `TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale` once and prefix with `$TS`.

Your ingest URL becomes `https://<machine>.<tailnet>.ts.net:8443/api/ingest/<connection-id>`; your MCP URL `https://<machine>.<tailnet>.ts.net:10000/mcp`. **Verify after any serve change** (from another tailnet device):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://gateway.example-tailnet.ts.net:8443/api/agents        # MUST be 404/403 — if 200, STOP: the admin surface is exposed
curl -s -o /dev/null -w '%{http_code}\n' https://gateway.example-tailnet.ts.net:8443/api/ingest/YOUR-CONNECTION-ID   # MUST be 401 — route alive, secret required
```

**Binding rules (ADR 0024 §D2, unchanged by ADR 0035):** never add a tailnet hostname to the `REST_ALLOWED_HOSTS` allowlist (that would open every no-auth admin route to all tailnet peers — the Host allowlist is the ONLY gate on that class); never map the whole `:8787` edge.

**Which agent harnesses this covers:** anything running ON your devices — Claude Code (`claude mcp add --transport http pcg https://…:10000/mcp --header "Authorization: Bearer <key>"`), Cursor (`mcp.json` `headers`), Claude Desktop via the `mcp-remote` stdio bridge, IDEs. **Not covered:** claude.ai and ChatGPT *server-side* connectors, which connect from the vendor's own cloud and can never reach a tailnet. The gateway **does** ship the OAuth 2.1 authorization server those clients need — it shipped 2026-07-17 (ADR 0029) and was verified end-to-end against claude.ai on 2026-07-21. What they additionally need is **public reachability on `:443`**, which is the next section.

**Hardening tips:** keep the `funnel` node attribute **scoped to the gateway node's tag** in your tailnet policy rather than granted tailnet-wide (ADR 0035 §D8 — `serve`/`funnel` are last-command-wins on a port, so scoping means a mistyped `tailscale funnel` on some *other* node cannot publish anything; ADR 0024 §D3 originally advised denying the attribute outright to `autogroup:member`, which would now deny the supported configuration below); name the machine blandly (enabling HTTPS publishes machine names to public Certificate Transparency logs); on macOS use auto-login or the open-source `tailscaled` daemon (the GUI variants join the tailnet only after login — a rebooted headless box is otherwise offline).

## Going public — the `:443` endpoint (opt-in and supported)

### Who needs this, and why nothing cheaper works

claude.ai and ChatGPT connect to your gateway **from the vendor's own servers**, not from the browser tab you are looking at and not from your laptop. A tailnet is unreachable to them by construction. There is no header, no setting and no plan tier that changes that: public reachability is the requirement.

Tailscale Funnel meets it while **TLS still terminates on your own machine**. That is the whole reason a fronting CDN is refused here (ADR 0024 §D5, reaffirmed by ADR 0035): Cloudflare Tunnel and its peers decrypt at their edge, which would put your transactions, workouts and mail in plaintext on someone else's network. Funnel does not.

### The irreducible setup Postern cannot do for you

Postern issues no `tailscale` command and never will do this behind your back. You need, once:

1. a Tailscale account;
2. the gateway machine authenticated into your tailnet (`tailscale up`);
3. **MagicDNS enabled**, and
4. **HTTPS certificates enabled** — (3) and (4) are tailnet-wide switches that live only in Tailscale's own admin console, and Funnel does not work without both;
5. the `funnel` node attribute present in your tailnet policy, **scoped to the gateway node's tag**.

ADR 0035 §D9 files a Postern-owned Tailscale sidecar (its own node, its own name, its own `:443`) as a possible later convenience — and records why it is not V0: it would not remove items 1–4, and shipping a second network identity into your private network by default is a bigger claim on your trust than the convenience earns.

### Port 443, and only port 443

Two constraints intersect at exactly one number.

- **`tailscale serve` permits any port. Funnel permits three: 443, 8443, 10000.** Vendor-documented; last checked 2026-07-25.
- **Cloud MCP connector backends egress on 443 only.** A Funnel on any other port gets a silent TCP reset before a single request leaves the vendor's network — the client reports "couldn't reach" and your edge logs show *nothing at all*, because nothing arrived. Provenance, stated honestly: this is **this repo's own experiment of 2026-07-21**, independently reported by practitioners in the same terms, and **vendor-undocumented**. No vendor documentation states a port restriction, so treat it as an observed behaviour that **may change without notice in either direction**, not as a published contract.

So: `:443`.

### "But my box already serves 443"

This is the common case, not the exception — Home Assistant, a NAS admin panel, Plex, an existing reverse proxy, another tailnet app. Four options, in the order worth trying:

- **Move the other service to a non-Funnel-eligible port and keep it on `tailscale serve`. Recommended default.** Anything reached only from *your own devices* can live on any port, because `serve` is unrestricted; only the thing the *public internet* must reach is pinned to 443. Parking private services outside {443, 8443, 10000} is real defence in depth: Tailscale offers no Funnel on any other port, so a typo cannot publish them. Cost: every client with the old URL bookmarked or configured has to be updated — and if the moved service pins its own origin in its config (an `allowedOrigins`-style list is typical), that pin must be updated too or the service will refuse its own new URL.
- **Give the gateway its own tailnet node.** A second machine, VM or container running its own `tailscaled` gets its own `*.ts.net` name and therefore its own private `:443`. No collision at all. Cost: a second identity in your network to manage. (This is the shape ADR 0035 §D9 files as a later Postern convenience; today you build it yourself if you want it.)
- **Don't expose at all.** Fully supported, and the default (ADR 0035 §D2). Every locally-running harness — Claude Code, Cursor, Claude Desktop via `mcp-remote`, IDEs — works over tailnet-private `serve` and needs none of this. You lose only the hosted-web clients.
- **A reverse proxy that path-splits one shared `:443` — DO NOT.** This is the intuitive first answer and it is wrong for a non-obvious reason, so here is the reason out loud: **`serve` and `funnel` are last-command-wins on the same port, and Tailscale flips a port public or private atomically and entirely.** There is no path-level and no hostname-level mixing. Point `funnel --https=443` at a proxy fronting two services and you have published **both** — the proxy's own routing rules are irrelevant, because the exposure decision is made a layer above the proxy and applies to the whole port. The service you believed was tailnet-only is now anonymously reachable from the internet, and nothing in the proxy's config will tell you so.

### Arming it

Arm it **once, deliberately**. Churning `serve`/`funnel` config re-issues certificates and can hit Let's Encrypt issuance limits, at which point you are locked out of your own hostname for hours with no way to hurry it.

```bash
# On a GUI-build Mac first: TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale  (and prefix with $TS)
tailscale funnel --bg --https=443 http://127.0.0.1:8788   # the MCP edge — NEVER the REST edge (:8787)
tailscale funnel status                                   # the 443 line must read (Funnel on); every other line must still read (tailnet only)
tailscale serve status --json                             # the machine-checkable form: an "AllowFunnel" key appears for, and only for, the port you meant to publish
```

> **Always pass `--bg`.** Without it the command runs in the foreground, holds the config for as long as the process lives, and gives you no prompt back — and a `Ctrl-C` is then the only thing standing between you and a config you did not read. `--bg` writes the config, prints, and returns.

Then set the public origin and restart the app so the bridge picks it up:

```bash
MCP_PUBLIC_URL=https://gateway.example-tailnet.ts.net    # PORT-LESS. Never :443.
docker compose up -d app
```

Port-less is the canonical origin form that vendors send, and the value is echoed verbatim in the OAuth discovery documents, where an exact string match decides whether the client proceeds.

**Turning it off** is two halves, and doing only one leaves you in a state nobody wants:

```bash
tailscale funnel --https=443 off      # 1. close the port
# 2. remove MCP_PUBLIC_URL from .env, then: docker compose up -d app
```

Unsetting the env var alone turns the bridge OFF while the port stays **public** — every bridge path then 404s to the whole internet. Closing the port alone leaves the bridge advertising an origin nothing can reach. Do both, then re-run `tailscale serve status --json` and confirm no `AllowFunnel` key remains.

### What is exposed, exactly

Whole-port, and that is the correct shape (ADR 0035 §D6). "Expose only `/mcp`" is **not achievable**: a vendor's fleet must anonymously fetch the discovery documents, `/register` and `/token` **before any credential exists**, so a path-scoped Funnel makes the OAuth flow impossible.

Taking the whole MCP port is nevertheless precise, because that port's entire route table is **eight routes** — the seven bridge routes (`src/mcp/oauth-bridge.ts:962-971`) plus `/mcp`; every other path 404s by construction (`src/mcp/http.ts:253-255`). **Three** of the eight are static JSON carrying no user data (the two protected-resource documents and the authorization-server document); one is `/mcp`, bearer-gated; one is `GET /authorize`, which renders the approval page and requires an already-registered `client_id`; one is `POST /authorize`, **the agent-key login — this is the credential a stranger cannot get past**; one is `POST /token`, which needs a valid single-use code bound to a PKCE verifier; and exactly one, `POST /register`, is an unauthenticated write.

Two consequences bind, and no later tidy-up may erode them:

- **The REST edge (`:8787`) is never funnelled, and no bridge route may ever move onto it.** That separation is what makes this exposure precise rather than catastrophic — the REST edge is where the no-credential admin class lives.
- **The tailnet hostname goes in `REST_ALLOWED_HOSTS` never** (ADR 0024 §D2, unchanged).

### Harden before you arm, not after

Public exposure changes what "an anonymous stranger" can do, so three settings stop being optional (ADR 0035 §D3):

- **Know what rate limiting can and cannot do behind a Funnel — and do not expect `MCP_TRUSTED_PROXIES` to fix it.** The gateway derives a caller's IP from the socket's peer address, and behind Tailscale Funnel **there is no client address to recover at all**: Tailscale terminates TLS on your machine and proxies the request onward from localhost, Docker's published-port mapping NATs it again, and Tailscale's own client-IP mechanism applies to raw TCP forwarding, not to the HTTPS/Funnel path (probed 2026-07-25). No forwarded-for header arrives, so there is nothing for an allowlist to believe. **Setting `MCP_TRUSTED_PROXIES` does not restore per-caller limiting behind a Funnel.** It is useful only in the other shape — when you front the gateway with a reverse proxy of your own that genuinely supplies a client address; then set it to that proxy's real address, read off your own deployment rather than copied out of a document, and never to `0.0.0.0/0` (which tells the gateway to believe a header any caller can forge).

  So behind a Funnel the limiter is necessarily **global**: one bucket for the whole internet. That is an accepted limitation for beta, and the honest description of what it costs you is narrow — a stranger who finds your URL can disrupt **connection setup** (the unauthenticated discovery and registration paths, and the bucket an already-connected client shares). **No data is exposed, no key is at risk, and an existing connection's credential is unaffected**; the reads and actions behind `/mcp` stay bearer-gated throughout.
- **Give every cloud-facing agent key an expiry.** The key you paste into a hosted client's authorize page lives on someone else's infrastructure. Mint it in the Console with an expiry set; an unexpiring key handed to a cloud service is a credential you can only ever end by noticing. Rotating or revoking the key kills every bridge token derived from it — that is the compromise response, by design.
- **Assume the endpoint is found.** Enabling tailnet HTTPS publishes the machine name to a public Certificate Transparency ledger; a partial `%.ts.net` CT query returns hundreds of node FQDNs across hundreds of tailnets. **Hostname obscurity therefore has zero security value.** Name the node blandly anyway (it leaks less about you), but do not treat the name as a defence — assume the endpoint is discovered within hours of being armed. What actually defends it is the list above plus the edge hardening the gateway ships: a rate limiter on the unauthenticated paths (global behind a Funnel, per the bullet above), registration that evicts rather than refuses, and key expiry.

### Verify with `curl` before you touch the connector UI — and do not thrash

Probe from a machine that is **not** on your tailnet (a phone on cellular is the easy one). From inside the tailnet you cannot tell Funnel from `serve`, so an inside probe proves nothing about public reachability.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://gateway.example-tailnet.ts.net/.well-known/oauth-protected-resource/mcp   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://gateway.example-tailnet.ts.net/mcp                                        # 401 — alive, credential required
curl -s -o /dev/null -w '%{http_code}\n' https://gateway.example-tailnet.ts.net/api/agents                                 # 404 — the admin surface is a DIFFERENT PORT and is never funnelled
```

Only when all three read correctly do you add the connector — in claude.ai: **Settings → Connectors → Add custom connector**, and the URL is your published origin **plus `/mcp`**: `https://gateway.example-tailnet.ts.net/mcp`. The gateway's *setting* is the bare origin; the *connector URL* is the `/mcp` endpoint on it — they differ by exactly that suffix, and pasting the bare origin fails with "not a valid MCP server" even though the sign-in itself succeeds, because the root 404s and only `/mcp` answers. **Do not re-click a failing connector.** claude.ai caches discovery documents globally by URL for roughly five minutes **including failure verdicts** (observed during the 2026-07-21 verification; vendor-undocumented), so a server you have just fixed still looks broken for minutes and re-clicking teaches you nothing. Fix, wait, then try once.

### The two public-facing settings are different settings, and stay that way

- `PCI_PUBLIC_BASE_URL` (default `http://localhost:8787`) answers *"where does **my own browser** land coming back from Google/Microsoft after I connect an account."* It is the OAuth `redirect_uri` origin, it is loopback, and it stays loopback.
- `MCP_PUBLIC_URL` answers *"where does a **vendor's server fleet** reach this box."* Public HTTPS on `:443`.

**A `*.ts.net` name is never the OAuth redirect origin** (ADR 0035 §D5) — not discouraged, structurally impossible: Google requires DNS-level ownership verification of a redirect URI's domain, Tailscale owns the `ts.net` zone, and `ts.net` is on the Public Suffix List, so neither you nor Postern can ever verify it. Setting one value for both is not a shortcut; it is a configuration Google will refuse.

## Alternatives (if you won't run Tailscale)

- **LAN-only** — the privacy maximum: no remote anything; use the SSH tunnel when away. Costs you phone-push while out and remote agents.
- **Pangolin on a ~$5 VPS** — self-hosted tunnel (WireGuard + Traefik, outbound-only from home, auto-TLS on YOUR VPS). ~1 hour setup; no SaaS sees plaintext.
- **Port-forward + Caddy on-box** — expert-only, and now the **fallback to Funnel-on-443 rather than a peer of it**: it reaches the same hosted clients but costs you an open inbound port, a CGNAT check first, and the knowledge that a public 443 on a home IP is internet-scanned within the hour. The gateway's admin surface must still never be in the proxied path, and any fronting proxy MUST forward the original Host header (ADR 0024 §D2).
- **Cloudflare Tunnel — NOT recommended for this product:** superb ergonomics, but Cloudflare terminates TLS at its edge and reads request plaintext — your transactions, workouts, and mail would transit their network readable. Wrong trade for a personal-data gateway, and the reason Funnel is the recommendation instead.
- **Escape hatch:** if Tailscale-the-company ever must be exited, Headscale (self-hosted control plane) replaces coordination for the same clients — note its `serve`-with-HTTPS support is still an open gap and Funnel is not planned, so budget for a reverse proxy alongside it and expect to fall back to the port-forward tier for hosted clients.

## Where the decisions behind this page live

Running Postern on a box of your own? Deploy, reboot-recovery and rollback are procedures for YOUR box and yours to write; this page covers only how the gateway is reached from off it. The decisions behind this page are [ADR 0024](../specs/decisions/0024-remote-access-tailscale.md) (tailnet-private is the default) and [ADR 0035](../specs/decisions/0035-public-exposure-is-a-supported-path.md) (public exposure is a supported path).
