# ADR 0014 — OAuth onboarding: BYO-app, per-provider confidential vs public

**Status:** accepted (wave 11 · 2026-06-15)

## Context
Self-hosted, single-tenant. To connect Google / Microsoft / WHOOP the gateway acts as an OAuth **client** and needs a registered provider app (a `client_id`, and for some providers a `client_secret`). Research (verified against official docs and reconciled with our code) found the prior assumption — "first-party PKCE, no secret, for all three" — was wrong:
- **Microsoft** works as a **public** client (PKCE, no secret) *only if* registered under the "Mobile and desktop applications" platform with personal accounts enabled.
- **Google** requires a **client_secret** in practice (register a "Desktop app"); our flow had no secret slot.
- **WHOOP** is **confidential-only** — the secret is required on both exchange and refresh, refresh also needs `scope=offline`, and PKCE is ignored (the secret is the only proof).

So Google and WHOOP were hard-broken; the UI alone would have shipped on a broken engine.

## Decision
- **BYO-app:** each operator registers their **own** app per provider and supplies the credentials **in the Console** (not env). A shared first-party app is impossible for self-host — a confidential secret cannot ship inside an open-source/self-host binary (extraction → impersonation) — so it is deferred to the hosted tier.
- **Per-provider client type:** Microsoft = public (`client_id` only); Google + WHOOP = confidential (`client_id` + `client_secret`). `ProviderConfig` carries `confidential` + `clientSecret`.
- **Persistence:** new `oauth_provider_apps` table — `client_id` plain, `client_secret` as a vault `secret_ref` (rows hold only a ref — CLAUDE.md invariant). `providerConfig()` is async, resolving table-first with an env fallback; throws `ConfigError` (→ 400) when unconfigured.
- **Flow correctness:** `exchangeCode` sends the secret only for confidential providers (never Microsoft); refresh sends the secret + `scope=offline` for WHOOP; provider error codes are surfaced (non-token-bearing) for self-diagnosis; the callback `redirect_uri` is pinned to `PCI_PUBLIC_BASE_URL` so it always equals the registered literal.
- **Gmail is NOT OAuth** — it stays the IMAP app-password paste path (fixed: strip app-password whitespace before sealing; require the username).

## Consequences
- Self-host OAuth onboarding always includes a "register your own app" step (guided in the Console: exact app type, redirect URI, scopes, prerequisites); the frictionless one-click consent is the hosted tier.
- Closes the OAuth parts of #16 (UI-first config), #15 (actionable error), #7 (clean return) + the Gmail paste bugs.
- The `custody` enum's `byo_app` value is now used (was reserved).
