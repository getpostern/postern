# ADR 0019 — Plaid hosted-link onboarding + Console-configurable creds + server-side polling

**Status:** Accepted · shipped wave-13 (#14), merged into `main`.

## Context

Plaid Link normally lives inside the integrating app's UI; V0 stubbed the embedded widget, leaving a manual `public_token` paste — which contradicted the UI-first principle and the credential-collection model. First-hand research (`docs/research/plaid-integration-deep-dive.html`) established two grounding facts: (1) Plaid offers a **Plaid-hosted** Link page reached by URL — no JS widget to bundle; (2) there is **no SimpleFIN-style portable token** — every bank is linked through *our app's own* Link flow and yields a per-Item `access_token` bound to our `client_id`. A bare `client_id`/secret reads nothing; `my.plaid.com` connections never transfer to a developer app.

## Decision

1. **Console-configurable creds.** A `PlaidSetup` panel holds the operator's BYO `client_id` + vault-sealed `secret` + `env` (sandbox|production) in a `plaid_app` singleton (mirrors the OAuth BYO-app pattern, ADR 0014), and renders an **in-Console onboarding walkthrough** (the prerequisite Plaid dev account, the fresh-Trial-team path, Keys, Application Display Info, connect). `PLAID_*` env is now a fallback, not the source of truth.
2. **Hosted Link + server-side polling.** Mint a `hosted_link_url` via `/link/token/create` with `enable_multi_item_link: true` + `hosted_link.url_lifetime_seconds` + `transactions.days_requested: 730`. The operator opens the URL; the gateway **polls `/link/token/get`** and **auto-exchanges** each `public_token` (read from the `results.item_add_results` array) — no manual paste, **no inbound webhook** (loopback-friendly).
3. **Per-Item keying.** One credential + one finance connector per Plaid **Item**, keyed by `provider_credentials.external_item_id` — Multi-Item Link can link several banks in one session without collision; the DB is the sole source of truth (no list-Items endpoint).
4. **No redirect-URI registration.** First-hand confirmed: the web Hosted Link flow needs **no** Plaid Dashboard redirect-URI registration — this is what makes onboarding zero-config beyond pasting `client_id` + secret.

## Consequences

- Finance onboarding is fully UI-first (no widget bundle, no manual token). **SimpleFIN stays the free default; Plaid is the paid coverage-upgrade.** Free to dogfood on Plaid's Trial plan (new US/CA teams, ≤10 Items, Transactions+Balance, no questionnaire).
- Supersedes the "stubbed widget / manual `public_token` paste (#14)" framing in CLAUDE.md.
- Onboarding reality (capture for users): existing pre-Apr-2026 teams aren't Trial-eligible → paid Production (pay-as-you-go, no public price list); some OAuth banks need a completed Application Display Info even on Trial; Schwab/Fidelity can take weeks. (See `docs/runbooks/plaid-onboarding.md`.)
