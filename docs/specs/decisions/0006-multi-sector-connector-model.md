# ADR 0006 — Multi-sector connector model (`SyncContext.sector` + connection-sector routing)

**Status:** accepted (backfilled) · **Date shipped:** 2026-06-10 (wave 5, `connector-wave-enablers`) · **Recorded:** 2026-06-13
**Context wave:** Wave 5. Backfilled per working-style rule 7 (a shipped, load-bearing mechanism that lacked an ADR; the connector wave — `google` calendar+contacts, and the OAuth mail connectors — depends on it).

## Context

The control plane is `provider_credentials` (ONE row per consent) → `connectors` (ONE row per credential × sector). One Google OAuth consent fans out to multiple sectors (calendar + contacts + mail), i.e. multiple `connectors` rows backed by a single credential. But a connector is **registered once per provider** (`registerConnector` keys by `provider`), so a single registered `google` connector instance must serve several sectors, and the runner must route each sync to the right sector's tables — not to a connector-static sector.

## Decision

1. **`SyncContext.sector` carries the CONNECTION's sector** (from the `connectors` row), threaded by the runner (`src/sync/runner.ts`). A multi-sector connector branches on `ctx.sector`; single-sector connectors ignore it. Combined with ADR 0005's `object`, the runner routes upserts by the **connection's** sector, never the connector's static `sector` field.
2. **The OAuth callback auto-creates one `connectors` row per sector** derived from the credential's EXACT granted scope strings via `sectorsForScopes` (`src/oauth/providers.ts`) — RFC-6749 absent-scope fallback to the requested set; pause-on-scope-reduction; a revoked connection reactivates on fresh consent. The operator consents once; the gateway materializes the per-sector connections.
3. **Refresh is single-flight per credential** (`src/oauth/refresh.ts`): one credential fans out to multiple connections, so overlapping syncs can race the token endpoint. A per-credential in-flight promise map shares ONE refresh; the critical section re-reads the credential row so a stale snapshot can't trigger a second refresh (which would burn a rotated refresh token). In-process only (V0 single-process box).
4. **`resolveAccessToken` returns `{ token, secretRef }`** so callers carry the CURRENT vault ref forward (the new ref after a refresh, the existing one otherwise) — never a retired `secretRef`. The runner threads `resolved.secretRef` into `SyncContext`. (`fetch_live` adopts the same seam — see `wave6-fetch-live-token-switch`.)
5. **`SyncContext.username`** threads the credential's static identity (e.g. a mailbox email) for connectors that need a source-side identity the access token alone doesn't name.

## Consequences

- `google` = one credential → calendar + contacts (+ later mail) connections, served by one registered connector that branches on `ctx.sector`. `microsoft` mail is single-sector today but rides the identical path; adding Outlook calendar/contacts later is new scopes in `providers.ts` + `sectorsForScopes` entries, no new connector wiring.
- A new sector is still "a new table + a REGISTRY entry" (no control-plane change); multi-sector connectors are an additive `ctx.sector` branch.
- The single-flight + re-read guards are **in-process only** — a cross-process lock is a recorded hosted-tier follow-up (multiple gateway processes sharing one credential would still race).
- Pairs with ADR 0005: `sector` selects the sector, `object` selects the table within it.
