# ADR 0001 — Mail (and big-corpus sources): metadata cache + on-demand body

**Status:** Accepted (2026-06-06) · **Scope:** the mail connector + the cache-footprint rule for unbounded sources.

## Context
"The gateway IS the cache" — sync each source into local Postgres; agents read the store. That fits
**bounded** sectors (finance, home, calendar, contacts, health: thousands of small rows). Mail is
different: **unbounded and heavy** (100k+ messages, large MIME bodies, attachments). A full local mirror
would be multi-GB, maximally sensitive (a complete copy of all mail on the box and in every backup), and
a heavy one-time backfill — for little gain over the provider's own storage and search.

## Decision
Mail caches the **envelope/metadata only**: sender, subject, snippet (the provider-supplied preview),
sent/received timestamps, folder, labels, read/unread, has-attachments, thread id. The **body and
attachments are NOT stored** — they are fetched **on demand** via `fetch_live`/`get_record`: one live
pull by id, at the moment an agent needs to read a specific message. `raw` holds the envelope-level
payload, never the body.

Generalized rule: **bounded sources cache fully; unbounded sources (mail, later Drive/Notion) index the
metadata and lazy-fetch the content.** The sync engine is unchanged and stays uniform — the *connector*
chooses its footprint.

## Why it still honors the mantras
- **One place / lightning fast:** `query()` runs over local metadata like every other sector, so the
  uniform query surface + instant list/filter hold for the common case (sender / subject / date / folder).
- **`fetch_live` is the declared upstream primitive** — reading a full body is exactly where a live
  round-trip is expected; it does not regress the instant cache reads.

## Trade-off (accepted)
Local SQL filters the **envelope** (sender, subject, date, folder, flags) but cannot full-text-search
message **bodies** (we don't store them). Body-content search proxies to the provider's own search
(Gmail / Microsoft Graph). Acceptable: provider search is strong, and this is a clear, named boundary.

## Consequences
- **Schema:** the `mail_messages` "full body in raw" note is corrected to "body fetched on demand, not
  stored"; `raw` holds envelope-level payload only. (Done in `db/schema.sql`.)
- **Mail connector (future):** sync pulls envelope/metadata only; a per-message **body fetch** backs
  `get_record`/`fetch_live`. This likely adds a connector capability for on-demand single-record content
  — a small contract refinement to design when the mail connector is specced.
- Storage stays bounded (~hundreds of MB even for very large mailboxes); the sensitive at-rest footprint
  shrinks dramatically (no bodies/attachments stored).

## Open dial
"How much metadata": default = all envelopes; option = a recent window (e.g. 12 months) with older mail
fully live. Decide when the mail connector is specced.
