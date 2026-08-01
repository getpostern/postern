# ADR 0016 — Resumable large syncs: opt-in incremental cursor checkpointing + retryable "syncing" status

**Status:** Accepted · implemented wave-11c (2026-06-20, dogfood #22).

## Context
A large Outlook mailbox's initial Graph delta sync pulls thousands of messages, then a transient **504** mid-enumeration threw the whole cycle. The runner persisted the connector cursor **only at cycle-end on full success**, so a mid-enumeration failure saved no progress; the next poll restarted from zero and the mailbox **never converged** (observed: ~8300 messages ingested, then `status=error`, `cursor=NULL`, `last_synced_at=NULL`). Transient 5xx were not retried (only 429 + 410 were), and a resumable-but-incomplete sync surfaced to the operator as a hard "Sync failed."

## Decision
1. **Opt-in incremental cursor checkpointing.** Add `SyncPolicy.cursorCommittedThrough?: boolean` (default false). When true, the runner persists `connectors.cursor` **mid-stream** as records are committed (resumable); when false/absent, behaviour is unchanged — cursor written once at cycle-end on success. **Microsoft opts in** (its per-page Graph delta cursor is committed-through: the next-page link rides only the last record of each page and is persisted only after that page's records upsert). Microsoft also: retries transient 5xx (502/503/504) with bounded backoff (throwing `RetryableError` on exhaustion), and uses a smaller `odata.maxpagesize` (20) to lighten each page.
2. **Retryable-vs-terminal status.** A caught `RetryableError` (transient 5xx/429-after-retries/network) → new connector status **`syncing`** (recorded `last_error`, `last_synced_at` left untouched); everything else → `error` as before. The scheduler selects `syncing` connectors so they keep retrying (and resume via #1 for opted-in connectors). The Console renders `syncing` as a non-alarming **"Syncing…"** pill (precedence `revoked > error > paused > syncing > awaiting > live > synced`). `status` is a free-text column, so no migration.

## Why opt-in (the corrected safety model)
The first draft made incremental persistence **unconditional for all connectors**, on the (false) premise that every connector emits a committed-through cursor. An **adversarial review caught this as a real data-loss hazard before merge**: Plaid/SimpleFIN/Whoop attach a **batch/window-END cursor to every record**, so immediate per-record persistence + a mid-stream failure would skip the uncommitted records on resume — and **Plaid's opaque server cursor makes that loss permanent**. Gating checkpointing behind an explicit `cursorCommittedThrough` makes **"safe" the default**: a connector must consciously prove + declare committed-through to checkpoint. No hazardous code ever merged or ran (it was contained to the unmerged `wf/outlook-be` branch).

## Consequences
- Microsoft large mailboxes now converge across resumed runs; the tile reads "Syncing…" then "Synced".
- Plaid/SimpleFIN/Whoop/Gmail/Google/HA/apple-health are **unchanged** (cycle-end-only) — no regression.
- `last_synced_at` semantics preserved: stamped only on a fully-completed cycle.
- **Fast-follows:** verify + opt in Gmail/Google (believed committed-through — needs per-connector check + a mid-stream-resume test each); a committed-through cursor refactor for Plaid/SimpleFIN/Whoop only if a large one ever struggles (their datasets are bounded/small, so restart-from-scratch is cheap). Empty (record-less) delta pages aren't checkpointed (bounded re-fetch) — deliberately deferred.
- Process note: the adversarial ‖ security review gate did exactly its job — security SHIP, adversarial BLOCK on the data-loss hazard; the BLOCK corrected the spec's safety model before any merge.
