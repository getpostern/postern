# ADR 0017 — Mail recency window: bound the unbounded-source cache to a configurable window

**Status:** Accepted · implemented wave-12a (2026-06-20). Refines **ADR 0001** (mail metadata-cache).

## Context
The Microsoft (Outlook) connector pulled the **entire** Inbox + Sent history with no bound. On a heavy mailbox (tens of thousands of messages, well over a year of history) the initial sync was slow, multi-cycle, and fragile — it tripped the per-folder page cap, risked mid-sync token expiry, and showed "Awaiting first sync" the whole time. An agent almost never needs deep-archive mail for context; ADR 0001 chose "envelope of *everything*," which is more than the hot path needs.

## Decision
Bound mail sync to a **configurable recency window**, default **6 months**, **per-connection** (`connectors.sync_window_days`, changeable from the Console). Older mail is **not cached** — reachable on-demand by id via `fetch_live`/`get_record`; full out-of-window search is the deferred wave-12 body-search proxy.

Mechanics (research-confirmed against Microsoft Learn + IMAP RFCs):
- **Microsoft Graph:** `messages/delta` natively accepts `$filter=receivedDateTime ge <window-start>` + `$orderby=receivedDateTime desc`. The filter is encoded into the `@odata.deltaLink`, so the **windowed backfill and the incremental-from-now feed are the same delta sequence** — no full enumeration. `windowDays=null` ⇒ no filter (all-history back-compat). A documented **5,000-message cap on filtered delta** is accepted for V1 (heavy windows yield the most-recent ~5k via `orderby desc`); an un-capped LIST backfill for full >5k windows is a fast-follow.
- **Gmail (IMAP):** `SEARCH SINCE <window-start>` for the windowed set, then CONDSTORE `CHANGEDSINCE <highestModseq>` for incremental — a fast-follow (same `sync_window_days` config).
- **Window change resets the cursor:** `setSyncWindow` clears `connectors.cursor` so the next sync issues a *fresh* windowed delta with the new filter — **grow** backfills the wider range (idempotent upsert, no dupes), **shrink** re-pulls the narrower range and **keeps** already-cached older rows (no destructive prune; you can `erase` explicitly).
- **Honest progress:** while data is landing (`last_synced_at` null AND `cached_count > 0`) the Console shows **"Syncing… (N)"** for poll connectors, not "Awaiting first sync"; push connectors keep "Awaiting first push".

## Why date-window + a count cap
Date is what both Graph and IMAP natively bound on, and "last N months" is the meaningful, predictable surface for agent context (prior art: iOS Mail / Gmail Android / Outlook / Thunderbird all use date windows). The ~5k filtered-delta cap doubles as the footprint guardrail.

## Consequences
- Large-mailbox initial sync is fast + bounded (≤ window/5k ⇒ far under the per-folder page cap), so the wave-11c page-cap/504/token-expiry edges rarely fire — **windowing resolves the large-mailbox pain (#22) at the source**, superseding a page-cap raise (the page-cap throw is reclassified `RetryableError` as a cheap backstop; `maxpagesize` reverted 20→50 now that volume is bounded).
- The local mail cache becomes the **recent window**; deep-archive queries don't hit the cache (the load-bearing trade-off) until the body-search proxy lands.
- `last_synced_at` semantics preserved (stamped only on a fully-completed cycle).
- **Fast-follows:** Gmail windowing; the un-capped LIST backfill for full >5k windows; the body-search proxy for deep-archive search. Per-connector `cached_count` adds N count queries per `GET /api/connectors` — fine at self-host scale, revisit for the hosted tier.
- Process note: the adversarial review caught a real gap pre-merge — `setSyncWindow` initially didn't reset the cursor, silently no-op'ing a window grow — fixed before merge.

**Postscript (2026-07-11, unit `gmail-recency-window`):** the "Gmail windowing" fast-follow SHIPPED — windowed `UID SEARCH SINCE` backfill (1-day INTERNALDATE pad), client-side in-window filter on the CHANGEDSINCE increment, and a DAILY deletion census (window-scoped `reconcileObjectSnapshot` with census-resurrect) that also fixes the CONDSTORE-reality gap: Gmail advertises CONDSTORE without QRESYNC, so the VANISHED-based tombstones this ADR assumed likely never fire against real Gmail — the census is now Gmail's actual deletion detection. An adversarial BLOCK (disappearing-Sent mass false-tombstone, empirically reproduced) was fixed spec-first pre-merge (folder-vanish sweep guard + census resurrect). Remaining fast-follows: the un-capped LIST backfill for full >5k Outlook windows; the body-search proxy.
