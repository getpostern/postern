# ADR 0008 — Push-ingest webhook + `ingestRecords` seam

**Status:** accepted · **Date:** 2026-06-13 · **Wave:** 8 (`push-ingest` ‖ `pci-sdk`)

## Context

The gateway had push *out* (the Home Assistant WebSocket) but no way for an external source to push
records *in*: a phone exporting Apple Health, or Plaid pinging `SYNC_UPDATES_AVAILABLE`. Poll
connectors only refresh on the scheduler cadence or via `fetch_live`. A generic, authenticated inbound
path was needed — without forking the engine.

## Decision

1. **`ingestRecords(connectionId, RawRecord[])` reuses the runner loop.** The per-record body of
   `syncConnection` (normalize → REGISTRY-validate → `buildUpsert` / tombstone → cursor write-back) is
   factored into `applyRecords`; both the pull path and `ingestRecords` drive it. `ingestRecords` does
   a **light** connection load (user_id/provider/sector — no credential join, no token resolve) and
   reuses the same write-back (`last_synced_at = now()` = "last push landed"). The inbound body can
   **never** choose its own `user_id`/`connection_id`/target table — the runner injects them from the
   connectors row.
2. **`POST /api/ingest/:connectionId`, authenticated by a per-connection secret.** The secret is
   stored as **sha256 on the `connectors` row** (`webhook_secret_hash`), NOT in the vault: verification
   needs equality not plaintext (hash + `timingSafeEqual`, the `agent_grants.key_hash` pattern), and it
   must be **per-connection** (the vault AAD is per-credential — one Google credential fans to two
   connectors). Minted once via a `localOnly` admin route (`mintWebhookSecret`, the `mintAgentKey`
   pattern), returned once, never re-fetchable.
3. **Fail-closed, first, no oracle.** Auth runs **before** body parse; unknown/inactive/no-secret/
   wrong-secret all return the **same** 401 with no distinguishing body. The route is **Host-exempt**
   (registered bare, intentionally external) while admin/OAuth/Plaid stay `localOnly`-guarded.
4. **`decodePush?(rawBody): RawRecord[]`** — an additive optional `Connector` member — lets the generic
   route delegate payload→records to the connector (the connector owns its payload shape; the route
   stays generic). A connection whose provider has no `decodePush` → 400.
5. **Two modes.** *push-records* (Apple Health: the body IS the data, header secret) is shipped.
   *ping-then-pull* (Plaid: a signed notification → trigger `syncConnection`, needs JWT verification +
   raw-body-before-parse) is **designed-for, deferred** (a connector-declared `verifyWebhook` +
   `pushMode`).

## Consequences

- Device-push sources (apple-health) need **no boot lifecycle**: `policy.mode='push'` with no `start()`
  → `startPushConnectors` ignores it, the poll scheduler skips it; ingest is driven entirely by the
  external POST. A push connector implements a no-op `sync()` + `normalize`/`decodePush`.
- **Follow-up (to land with apple-health, its first consumer):** a bad batch currently flips the
  connection to `status='error'` via `markError`, which then 401s subsequent pushes — a self-inflicted
  lockout. Ingest must NOT disable a push connection on a malformed batch (return the error, keep
  status active; consider per-record isolation + a batch transaction). Recorded; not reachable until a
  `decodePush` connector exists. Other nits: accept either `X-PCI-Webhook-Secret` or `Authorization:
  Bearer` (today the junk X-header wins); scrub `decodePush` thrown messages; the sub-µs existence
  timing side-channel.
