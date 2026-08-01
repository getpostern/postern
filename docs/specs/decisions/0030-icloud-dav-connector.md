# ADR 0030 — iCloud connector: one ASP credential → mail (IMAP) + calendar (CalDAV) + contacts (CardDAV)

**Status:** Accepted · **Date:** 2026-07-21 · **Context:** issue #26 (the Apple halves; the Outlook half shipped earlier as #26a). Merged 2026-07-21, built in three parallel parts and integrated at merge; gate green, with a live smoke against a real iCloud account owed at deploy. Grounded by a 3-track recon (code patterns + iCloud protocol specifics + Node libs, 2026-07-21).

## Decision

A new `apple` provider consumes ONE credential — Apple ID email + an **app-specific password (ASP)**, custody `static_token`, no OAuth — and fans it out to **three read-only connectors** (`actions: []`): `mail` (IMAP), `calendar` (CalDAV), `contacts` (CardDAV). Purely additive: no new sector/table/migration (the three REGISTRY objects already exist, provider-agnostic).

1. **One composite connector, matching the microsoft/google multi-sector pattern.** The registry (`src/sync/registry.ts`) keys by PROVIDER, so three `provider:"apple"` connectors would collide (last-registration-wins). `src/connectors/apple.ts` (`AppleConnector`) registers ONCE and delegates: `sync`/`fetchRecordLive` route on `ctx.sector`; `normalize`/`strongKeys` on `rec.object`; the three sub-connector classes (`IcloudMail`/`IcloudCalendar`/`IcloudContacts`) are held unchanged + injectable for tests. **One static `SyncPolicy`** per provider (poll, 600s default / **300s floor**) — the scheduler/freshness/lifecycle resolve policy by provider, never sector (same as microsoft's one 300s policy for 3 sectors); per-connection cadence overrides (ADR 0025) still tune each sector.

2. **Mail is a better incremental target than Gmail.** iCloud IMAP advertises CONDSTORE + **QRESYNC**, so the connector uses `SELECT (QRESYNC …)` MODSEQ deltas + `VANISHED` for server-computed deletion detection — NO Gmail-style daily UID census (cleaner `{folder:{uidValidity,modseq}}` cursor). A UIDVALIDITY reset → full folder resync; a windowed-complete-enumeration run sweeps stale rows via `reconcileObjectSnapshot` (never a partial-run mass-tombstone). Envelope-only + recency-window (ADR 0001/0017); reuses `imapflow`; body drill on demand.

3. **CalDAV sync-collection works; CardDAV's does not (deliberate asymmetry).** Calendar uses RFC-6578 `sync-collection` (confirmed on iCloud) with the sync-token as cursor; a 404-in-report = tombstone. Contacts does NOT trust the CardDAV sync-token (unreliable on iCloud) — it uses a **ctag-gate → Depth:1 getetag-diff → multiget**, where a vanished-from-listing href is the deletion. This is a reliability downgrade by choice, not a protocol miss.

4. **`dav-core` wraps `tsdav` as TRANSPORT ONLY; bodies parsed by us.** `ical.js` (VEVENT: VTIMEZONE-resolved times, client-side RRULE expansion via `RecurExpansion`, RECURRENCE-ID overrides) and `vcard4` (VCARD: `FN`→display_name with an `N`/`ORG` fallback for iCloud's empty-`FN` quirk). tsdav's object mappers are never a data trust boundary. All three deps are pure-JS, no native (ical.js/vcard4 zero-dep; tsdav pulls debug+xml-js).

5. **`*.icloud.com` SSRF/credential-exfil guard (security-review blocker, fixed).** The ASP is HTTP-Basic on every DAV request, and tsdav's discovery walk + fetch redirects are server-influenced — so `dav-core` gates every credential-bearing URL with `assertIcloudHost` (https + hostname `/(^|\.)icloud\.com$/i`, URL-parsed so userinfo/query tricks can't bypass) AND injects `makeGuardedFetch` into tsdav (forces `redirect:"manual"`, host-checks every hop incl. internal discovery hops, refuses an off-icloud 30x with the ASP never re-sent). No TLS bypass.

6. **ASP revocation is EXPECTED, not exceptional.** Any change to the primary Apple password silently revokes all ASPs — there is no refresh. IMAP `AUTHENTICATIONFAILED` / DAV `401` → the connection goes unhealthy + surfaces a re-link (ADR-0020 pattern via a cheap auth probe). The per-account **partition host** (`p##-…`) is re-discovered every bootstrap, never persisted.

## Consequences

- The working notes' architecture section (Apple = a static-token credential fanning out to mail+calendar+contacts — the paste-credential analog of the Microsoft OAuth fan-out) and their custody section (Apple ID + ASP, `static_token`, no OAuth) are updated at merge. Onboarding: Console "Apple / iCloud" tile collects the ASP → one credential → three connectors (2FA + ASP-generation guidance copy).
- Deferred follow-ons (documented): CalDAV/CardDAV **writes** (event/contact create/edit — read-only V0, consistent with microsoft/google cal+contacts); SMTP send; a shared `imap-core` refactor to dedup gmail↔icloud IMAP (kept separate to leave the shipped `gmail.ts` untouched — D3); the `attendees` jsonb column is written by no connector (pre-existing repo-wide gap, not introduced here).
- Rate limits are **undocumented by Apple** — the 300s floor is a declared-conservative guess (ctag/QRESYNC gating keeps an unchanged collection a single cheap probe), revisable if evidence emerges.
- The live acceptance (a human-assisted connect against a real iCloud account) is the one criterion CI can't run.
