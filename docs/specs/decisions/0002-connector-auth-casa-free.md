# ADR 0002 — V0 connector auth: CASA-free, paste-token + light OAuth

**Status:** Accepted (2026-06-06) · **Scope:** how every V0 sector authenticates; the OAuth model; why no CASA in V0.

## Context
V0 is multi-sector (finance, home, mail, calendar, contacts, health). Some sources need OAuth. The expensive risk was Google: the **Gmail API restricted scopes** (`gmail.readonly` *and* `gmail.metadata` — both restricted) require an **annual third-party CASA security assessment** when restricted data is stored/transmitted **on a third-party server**. Research (2026) confirmed: metadata-only does **not** dodge CASA (metadata is itself restricted), and an official Gmail MCP does **not** offload the OAuth client / CASA burden.

## Decision
**No CASA in V0.** Per-sector auth:

| Sector | Source | Mechanism | Verification |
|---|---|---|---|
| Finance | SimpleFIN | paste access-URL (static token) | none |
| Home | Home Assistant | paste long-lived token | none |
| Mail | **Gmail** | **IMAP + app password** (paste; requires user 2FA) | **none — no OAuth, no CASA** |
| Mail | Outlook | **OAuth** (Microsoft; no app-password path exists) | publisher verification (no CASA) |
| Calendar / Contacts | Google | **OAuth, *sensitive* scopes** | consent-screen verification (no CASA) |
| Health | Whoop | **OAuth** (`offline` scope for refresh) | app registration (no CASA) |
| Health | Apple Health | on-device push | none |

**OAuth is required in V0** (Outlook, Whoop, Google Calendar/Contacts) — the light, CASA-free flavor.

**OAuth model — first-party verified apps:**
- We register + verify **one app per provider** (Google sensitive-scope consent-screen verification; Microsoft publisher verification; Whoop app). **Not** user-BYO-by-default (BYO app in Google "Testing" → refresh tokens die after 7 days; doesn't scale).
- **Self-hosted V0 default = PKCE public-client flow:** the gateway runs OAuth locally with our shipped `client_id` (no secret), loopback redirect; **tokens stored on the user's box** (nothing transits us); durable because our app is verified/production.
- **Hosted tier (later) = broker** we run (holds the secret, does the exchange).
- **BYO-app = escape hatch** (enterprise/purist; `custody='byo_app'`).

**CASA deferred** to a *possible future hosted tier that uses the Gmail API* (push/history, nicer than IMAP). Not V0.

## Why
- **Self-hosted = restricted data on the user's server = CASA isn't ours** (structural advantage of user-owned). It's why open-source self-hosted Gmail tools never do CASA.
- **IMAP app-password** makes Gmail a paste-token sector — no OAuth, no CASA.
- **Sensitive** Google scopes (Calendar/Contacts) + Microsoft + Whoop carry **no CASA**.
- **First-party verified apps + PKCE** give durable tokens and low friction at scale, without CASA.

## Trade-offs (accepted)
- IMAP is clunkier than the Gmail API (separate protocol, ~2.5 GB/day, ~15 connections), needs the user to enable 2FA + generate an app password, can be disabled by Workspace admins, is blocked under Advanced Protection, and carries long-term deprecation risk. Acceptable for V0's zero-verification win; revisit Gmail-API+CASA for a hosted tier.
- Schema: add a `custody` value for the first-party-PKCE model (e.g. `first_party`), alongside `static_token` | `byo_app` | `hosted_broker` | `on_device`.

## Consequences
- `rest-onboarding` spec gains: paste-token credentials (SimpleFIN, HA, **Gmail IMAP app-password**) + an **OAuth flow** (start → provider redirect → callback → seal tokens) for sensitive-Google / Outlook / Whoop, plus **token refresh** on the sync path.
- Connectors split by mechanism: IMAP (Gmail), OAuth (Outlook, Whoop, Google Calendar/Contacts), static-token (SimpleFIN, HA), device-push (Apple Health).

## Sources
- Gmail scopes (metadata is restricted): https://developers.google.com/workspace/gmail/api/auth/scopes
- Restricted-scope verification (server-based CASA trigger): https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- CASA exemptions / no-restricted-no-assessment: https://support.google.com/cloud/answer/13463817
- Gmail app passwords (IMAP, requires 2FA): https://support.google.com/accounts/answer/185833
- Microsoft basic-auth deprecation (no app-password for Outlook): https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online
- Official Gmail MCP (caller still owns the OAuth client): https://developers.google.com/workspace/gmail/api/reference/mcp
