# The freshness grammar — one vocabulary for "how fresh, when next, what's wrong"

_Reference for the UI/UX redesign (and any future surface). The backend contract is spec `docs/specs/push-freshness-honesty.md` (ADR 0023); this page is the display side. The server computes ONE state word per connection — the UI renders it and never re-derives freshness from raw timestamps._

## Rule 0 — two clocks, two vocabularies, never in the same slot

- **Transport freshness** — _when did we last hear from the source?_ Server field: `last_synced_at` → displayed via the `freshness` tuple. Belongs to: connection cards, status pills, sector tiles, sync toasts.
- **Data recency** — _what period does the content cover?_ Server fields: each object's `primaryTime` (`posted_at`, `started_at`, `received_at`, `state_timestamp`, …). Belongs to: the data inspector, record lists, empty states ("oldest entry", date ranges).

A connection can be transport-fresh with old content (you last worked out 3 days ago; synced 30 s ago) — both true, different sentences. Never caption a status pill with a `primaryTime`, never caption a record row with `last_synced_at`.

## Rule 1 — the timestamp is the fact; state words are for exceptions only

The primary line for EVERY connection, every mode, is the same sentence: **"Last synced {t}"** (one shared relative-time helper — today there are three; consolidate). A healthy connection shows the timestamp and **no state badge at all** — quiet is the healthy state. Badges exist only when something needs the user's attention or patience. This kills two old sins: the glowing "Live" badge that kept rendering while the socket was dead for two weeks, and "Live"-vs-"Synced" telling the user about transport mechanics they didn't ask about.

## The tuple the backend serves (per connection)

```
freshness: {
  state:            ok | syncing | stale | unreachable | error | paused | disconnected | never_synced
  last_heard_at:    ISO timestamp | null     // the one "last synced" clock, every mode
  next_expected_at: ISO timestamp | null     // poll only; null MEANS something per mode (see below)
  stream_state:     connected | retrying | down | null   // push-stream connections only; feeds captions, never the badge
  error:            { message, since } | null
}
```

Served identically by `GET /api/connectors`, `describe_context` (agents see the same words), `sync-now` responses, and `fetch_live` per-connection results. Severity order for rollups — **error > unreachable > stale > syncing > never_synced > paused > ok** — worst wins the tile.

## The four transport models (why "next" isn't always a timestamp)

| model            | examples                                        | "last synced"     | "when next"                                                                   | failure looks like                                             |
| ---------------- | ----------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **poll**         | Plaid, SimpleFIN, Whoop, Outlook, Gmail, Google | end of each pull  | a real timestamp (`next_expected_at`)                                         | pull fails → `error`; overdue → `stale`                        |
| **push-stream**  | Home Assistant                                  | every event       | **"Instant"** — no next; while connected, updates arrive as the world changes | socket down, retrying → `unreachable` (since _t_)              |
| **push-webhook** | Apple Health (your phone POSTs)                 | every device push | **"Device controlled"** — the phone decides; never predict it                 | silence → advisory `stale`, never an alarm; we can't reach out |
| **on_demand**    | (none shipped)                                  | on use            | on use                                                                        | —                                                              |

## One phrasing per state — the canonical display language

No synonyms anywhere in the app. `{t}` via the one shared relative-time helper.

| state | badge (9-kind pill lexicon) | label | caption pattern |
|---|---|---|---|
| `ok` | **none** — timestamp only | — | "Last synced {t}" + the mode's next-line (below) |
| `syncing` | `syncing` | **Syncing…** / **Syncing… ({n})** | "first sync in progress" |
| `stale` | `stale` | **Stale** | webhook: "last heard from your device {t}" (advisory tone — device controlled) · poll, server states a complaint: "{served message} · {t}" · poll, no complaint: "last synced {t} — next check is late" |
| `unreachable` | `error` | **Unreachable** | "can't reach source — since {t}, retrying" |
| `error` | `error` | **Reconnect** | "{last_error} · {t}" |
| `paused` | `paused` | **Paused** | "syncing stopped — cached data still serves" |
| `disconnected` | `deleted` | **Disconnected** | — |
| `never_synced` | `awaiting` | **Awaiting first sync** / **Awaiting first push** | — |

Tone rule: `unreachable`/`error` are alarms (the user can act: fix the source, re-auth). Webhook `stale` is **advisory** (nothing to fix on our side — the phone just hasn't sent); render it calm, not red.

⚠️ **The `stale` row and this tone rule were both corrected on 2026-07-26** — they had gone two ways stale and a future agent reading them as the contract would have reverted two shipped fixes.

1. **The poll caption "nothing since {t} — check overdue" is DELETED and must not come back (#113).** It named the wrong clock. `last_heard_at` is transport only — *"when did we last hear from the source"*, never data recency — so "nothing since" asserted the SOURCE was empty, which that field cannot know. For a source emitting one record a day, having nothing new for hours is normal, so the sentence manufactured alarm out of a healthy fact and re-conflated the two clocks `src/core/freshness.ts` exists to keep apart. **The subject of a `last_heard_at` sentence is US — our sync, our late check — never the source's contents.** And where the server has already stated its own complaint, those served words are rendered rather than discarded and replaced by a paraphrase about the provider.
2. **Poll `stale` is no longer uniformly an alarm (#116).** A merely-late poll connection is **calm**; only one whose evidence the server states carries a complaint. So the tone of a poll `stale` follows the served complaint, not the state word.

The one derivation remains `src/core/freshness.ts`. Never re-derive it in an adapter or the front end — the Console's `api/freshness.ts` renders these fields and decides nothing.

## The "next update" sentence per mode

- poll → **"Next check ~{time}"** (a real expectation; overdue feeds `stale`).
- push-stream → **"Instant — connected"** (from `stream_state`; the pipe being open is the promise). Never invent a countdown.
- push-webhook → **"Device controlled"** — never predict the phone. (Observed-cadence learning — "usually daily" — is a possible later feature; until it exists, don't fake it.)

## Sector rollup (home-page tiles / inspector header)

- **State** = worst state across the sector's connections (severity order above; healthy = no badge).
- **Last synced** = **newest** `last_heard_at` across connections (the badge already carries any bad news; showing the oldest would double-count the alarm).
- **Next update** = **earliest** non-null `next_expected_at`; if all null, the mode caption ("Instant — connected" / "Device controlled"). Mixed sectors compose: health = Whoop (poll) + Apple Health (webhook) → "Next check ~7:00 AM · + device pushes".
- Nuances so the tile never lies: `syncing` → "running now" instead of a next-time · `error`/`unreachable` → "retrying" (true: both the scheduler and the push retry loop keep attempting) · `paused` → no next line.

## Verbs (buttons), so actions match the grammar

- **Check now** (poll/on_demand): runs a real pull; result toast uses the tuple.
- On push connections the same button reports stream truth instead of pretending: connected → "Streaming — nothing to pull"; down → the `unreachable` alarm with `since`. Never the old "Sync skipped".
- **Fetch live** (agent verb / record drill) is a READ-time concept — don't reuse its wording for sync health.

## Hard bans (each one is a bug we actually shipped)

1. Deriving a display state in the FE from raw `status`+timestamps (three divergent copies existed; the inspector had no stale state at all). Render `freshness.state`.
2. A healthy-state badge — especially "Live" (a dead socket rendered a glowing Live for two weeks, #39/#40; and at 3 AM a quiet house sends no events while perfectly healthy — connectedness is a caption fact, not a health word).
3. A predicted next-time for device-push sources (iOS scheduling is jittery, the automation can change on the phone, and a broken promise poisons trust in every other timestamp).
4. Hiding unhealthy connections from any list (the agent surface literally dropped errored connections).
5. Reusing the sync-health pill lexicon for non-sync meanings (audit Allowed/Denied, pending transactions, unread mail, naps — own lexicons; the redesign brief already bans the audit case).
6. Mixing the two clocks in one slot (Rule 0).
