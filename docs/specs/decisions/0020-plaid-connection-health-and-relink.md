# ADR 0020 — Plaid connection-health poll + error-state machine + update-mode re-link + `/item/remove`

**Status:** Accepted · shipped wave-13 (#14), merged into `main`.

## Context

Plaid connections break on a recurring cadence, not just once: OAuth / open-banking **consent expires ~annually** (Capital One, Fidelity, Bank of America), and Items also break on `ITEM_LOGIN_REQUIRED` / revoked access. A broken Item makes `/transactions/sync` go **quiet** (empty arrays) — indistinguishable from "no new data" — so a "faithful cache" would silently rot and `last_synced_at` would lie. Separately, on paid Production a live `access_token` bills a **monthly per-Item subscription** even after the operator deletes local rows.

## Decision

1. **Health poll.** Call `/item/get` per Item (run inside the connector's `sync()`, persisted to the credential: `item_status` / `error_code` / `consent_expiration_time`). `describe_context` surfaces per-connection `health: { status, consentExpiresAt }` so a broken/expiring Item is visible (honest `last_synced_at`).
2. **Error-state machine** (`classifyItemError`): **action_required** (re-link — `ITEM_LOGIN_REQUIRED`, `USER_PERMISSION_REVOKED`, consent-expiring) · **transient** (back off — `INSTITUTION_DOWN/NOT_RESPONDING/NOT_AVAILABLE`, **`RATE_LIMIT_EXCEEDED`** is retryable) · **terminal-quota → dead** (`TRIAL_CONNECTION_LIMIT`, `CREDITS_EXHAUSTED`) · **dead** (fresh Link — `ITEM_NOT_FOUND`, `INSTITUTION_NO_LONGER_SUPPORTED`).
3. **Console re-link.** Update-mode re-link (`/api/plaid/relink`, stored `access_token` carried → `external_item_id` unchanged, no row repoint) for **action_required**; a **fresh link** for **dead** (a dead Item can't be revived by update mode). Surfaced as per-row "Reconnect" / "Fresh link" CTAs in the Console.
4. **`/item/remove` on disconnect/erase.** An operator OUT-bound call (finance stays `actions: []` — an agent can never invoke it) that invalidates the token and **stops the monthly billing**; deleting local rows alone leaves a billable zombie Item. (Trade-off: a Plaid *erase* therefore needs a fresh Link to resume, unlike other providers — documented in `erase.ts`.)
5. **No webhook receiver.** Loopback self-host keeps polling (Plaid's bank cadence is only 1–4×/day, so polling loses no data); detection moves to `/item/get` at poll latency. This deletes the whole JWS-verification + public-ingress surface — a security simplification, not a regression. (Forfeits only the proactive 7-day `PENDING_DISCONNECT` warning for migration breaks; consent-expiry is pollable.)

## Consequences

- Connections don't silently rot; the operator gets an honest per-connection health signal + a one-click re-link before/after expiry. Billing stops on disconnect. The ~annual re-consent toil is the honest cost of Plaid vs SimpleFIN (no consent expiry).
