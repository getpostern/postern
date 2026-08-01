// The ONE Console-side freshness renderer (#39/#40/#73/#75, ADR 0023,
// docs/design/freshness-grammar.md).
//
// THE RULE, and there is only one: **the server names the state; this module renders it.** Nothing
// here compares a timestamp to decide health, computes staleness, or infers a state word. Every
// display string is a function of the SERVED `freshness` tuple plus the connector's served
// transport facts (`policy_mode`, `push_kind`, `cached_count`).
//
// Three bugs are structurally impossible in this file, by construction rather than by care:
//
//  1. **There is no healthy badge.** `ok` returns `label: null`. A dead socket rendered a glowing
//     "Live" for two weeks (#39/#40), and at 3am a quiet house sends no events while perfectly
//     healthy — connectedness is a caption fact, never a health word.
//  2. **One word per concept (#75).** This is the only derivation in the app. The five labels the
//     audit found for one healthy state (Synced / Healthy / Connected / Active / streaming) existed
//     because FinanceBanks bypassed the central mapping with a local healthPill(). A page that
//     wants a status word calls `freshnessDisplay`; there is nowhere else to get one.
//  3. **A status pill never carries an imperative verb (#73).** "Reconnect" is a button label, not
//     a state. The grammar table's `error → Reconnect` row is exactly the string #73 flags, so the
//     served word is rendered instead (see ERROR_LABEL below).
//
// And two promises are never made: no predicted next-time for a device push ("Device controlled",
// full stop — iOS scheduling is jittery and a broken promise poisons every other timestamp), and
// the two clocks are never mixed (transport freshness here; data recency belongs to the inspector).

import { ago, hence } from "./format";
import type { ConnectorStatus, Freshness, FreshnessState, PolicyMode, PushKind } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// The rendered display
// ─────────────────────────────────────────────────────────────────────────────

/** The state colour axis — separate from sector ink. `idle` is the quiet/faded treatment. */
export type Tone = "ok" | "attention" | "error" | "idle";

export interface FreshnessDisplay {
  /** The served state word, passed through untouched. */
  state: FreshnessState;
  /** The badge label — **null for `ok`**: silence is the signal, there is NO healthy badge. */
  label: string | null;
  /** The mode-aware sentence beneath the primary line. "" when there is nothing truthful to say. */
  caption: string;
  /** The "when next" line. Exactly one of: "Next check ~{t}" · "Instant — connected" ·
   *  "Device controlled" · "" (no promise). */
  nextLine: string;
  tone: Tone;
  /** The one "last synced" clock, straight off the tuple — for callers that render it themselves. */
  lastHeardAt: string | null;
}

/**
 * The `error` badge word. NOT "Reconnect".
 *
 * `docs/design/freshness-grammar.md` prints `error → **Reconnect**`, and audit finding #73/#23 is
 * *"the error state's pill label is the imperative 'Reconnect', a pill that reads as an action and
 * collides with the Reconnect button/verb."* The port plan ranks the issue list (§0 rule 5) above
 * the grammar (§0 rule 6) and restates the ban as law #9, so the pill carries the word the API
 * serves — which is also what build-notes §14.1a says distinguishes the three attention states:
 * *"differ only in the word the API serves and the button."* The button lives on `AttentionBanner`.
 */
const ERROR_LABEL = "Error";

/**
 * The inputs a display needs. Everything here is SERVED — nothing is derived.
 * The kit's freshness caption holds exactly these fields, which is why this entry point
 * exists alongside `freshnessDisplay(ConnectorStatus)`: one derivation, two shapes of caller.
 */
export interface FreshnessInput {
  freshness: Freshness;
  /** The connector's declared sync mode (`ConnectorStatus.policy_mode`). */
  mode: PolicyMode | null;
  /** The connector's declared push transport (`ConnectorStatus.push_kind`). null/undefined = a
   *  non-push connection, or a gateway that predates the field — in which case we say NOTHING
   *  about the next update rather than guessing which kind of push it is. */
  pushKind?: PushKind | null;
  /** `ConnectorStatus.cached_count` — used ONLY for the honest "Syncing… (N)" first-sync progress
   *  label, its one documented purpose. Never summed into a coverage figure (spec §Counts). */
  cachedCount?: number;
}

/** The severity order for rollups, mirroring the server's own `FRESHNESS_SEVERITY`
 *  (`src/core/freshness.ts`) exactly — worst first. The grammar quotes the same order and simply
 *  omits `disconnected`; the server slots it between `paused` and `ok` (a revoked link is quieter
 *  than a pause but still not healthy), and the server's list is the authority. */
export const FRESHNESS_SEVERITY: readonly FreshnessState[] = [
  "error",
  "unreachable",
  "stale",
  "syncing",
  "never_synced",
  "paused",
  "disconnected",
  "ok",
];

/** States in which a "when next" promise still holds. In every other state the promise is already
 *  broken, so we print no next-line and let the caption carry the truth. */
const PROMISE_HOLDS: readonly FreshnessState[] = ["ok", "syncing", "never_synced"];

/** The "when next" sentence per transport mode — the grammar's three lines and nothing else. */
function nextLineFor(input: FreshnessInput): string {
  const { freshness: f, mode, pushKind } = input;
  if (!PROMISE_HOLDS.includes(f.state)) return "";
  if (mode === "poll") {
    const t = hence(f.next_expected_at);
    return t ? `Next check ~${t}` : "";
  }
  if (mode === "push") {
    // Keyed on the SERVED push_kind. A webhook is never predicted; a stream only claims "connected"
    // while the socket genuinely is. An unstamped or absent kind says nothing at all — guessing
    // "Device controlled" from a missing stream_state is a derivation, and a wrong one for HA.
    if (pushKind === "webhook") return "Device controlled";
    if (pushKind === "stream") return f.stream_state === "connected" ? "Instant — connected" : "";
    return "";
  }
  return "";
}

function captionFor(input: FreshnessInput): string {
  const { freshness: f, mode, pushKind } = input;
  const heard = f.last_heard_at;
  switch (f.state) {
    case "ok":
      // Grammar Rule 1: the timestamp IS the fact for a healthy connection.
      return heard ? `Last synced ${ago(heard)}` : "";
    case "syncing":
      return heard ? "syncing now" : "first sync in progress";
    case "stale": {
      // Webhook silence is ADVISORY — the phone owes us nothing and we can never reach out.
      if (pushKind === "webhook") return `last heard from your device ${ago(heard)}`;
      // The sentence this branch used to print — `nothing since {t} — check overdue` — said the
      // SOURCE was empty, and `last_heard_at` cannot know that: it is transport only, "when did we
      // last hear from the source", never data recency (src/core/freshness.ts:5-6, two clocks never
      // conflated). For WHOOP — one day-strain record a day — having nothing new for hours is
      // normal, so the sentence manufactured alarm out of a healthy fact (#113).
      //
      // The honest subject is US. Where the server states a complaint it has already named that
      // subject exactly — its own scheduler (POLL_ALARM_MESSAGE) or a socket WE hold open
      // (PUSH_STREAM_SILENT_MESSAGE) — so the served words are rendered in the same shape as the
      // `error` caption below rather than paraphrased into a sentence about the provider. Before
      // this, the served complaint was DISCARDED here and replaced by the "nothing since" line.
      const msg = f.error?.message;
      if (msg) {
        const since = f.error?.since ?? heard;
        return since ? `${msg} · ${ago(since)}` : msg;
      }
      // No complaint — #116's near band: the sync that ran last SUCCEEDED and we are merely late
      // looking again. Still a pure read of served fields; the clock keeps the `ok` caption's verb
      // (one word per concept, #75) and the lateness is stated about our own check, not the source.
      //
      // THE NON-POLL ARM IS DEFENSIVE, not today's behaviour. Enumerate what can reach here: a bare
      // `stale` (no error, not a webhook) is produced by `deriveFreshness` in exactly one place — the
      // poll near band — because the push-stream silence fallback always attaches
      // PUSH_STREAM_SILENT_MESSAGE, a webhook is handled above, and `on_demand`/absent modes never
      // return `stale` at all. So `mode !== "poll"` is unreachable from anything the wire can serve
      // today. It is kept because "next check is late" is a claim about a SCHEDULE, and a future mode
      // that goes stale without promising one must degrade to the bare clock rather than inherit a
      // promise it never made. The cell that holds it is in `freshness.display.test.ts` and builds the
      // tuple by hand, which is the only way to reach it — and says so.
      if (!heard) return "";
      return mode === "poll"
        ? `last synced ${ago(heard)} — next check is late`
        : `last synced ${ago(heard)}`;
    }
    case "unreachable": {
      const since = f.error?.since ?? heard;
      return since
        ? `can't reach source — since ${ago(since)}, retrying`
        : "can't reach source — retrying";
    }
    case "error": {
      const msg = f.error?.message;
      if (!msg) return "";
      const since = f.error?.since ?? heard;
      return since ? `${msg} · ${ago(since)}` : msg;
    }
    case "paused":
      return "syncing stopped — cached data still serves";
    case "disconnected":
    case "never_synced":
    default:
      return "";
  }
}

function labelFor(input: FreshnessInput): string | null {
  const { freshness: f, mode, cachedCount = 0 } = input;
  switch (f.state) {
    case "ok":
      return null; // there is NO healthy badge — see the file header
    case "syncing":
      // The one documented use of cached_count: honest first-sync progress. A RE-sync (the clock is
      // already stamped) has no meaningful "of N" to report, so it stays the plain word.
      return !f.last_heard_at && cachedCount > 0
        ? `Syncing… (${cachedCount.toLocaleString("en-US")})`
        : "Syncing…";
    case "stale":
      return "Stale";
    case "unreachable":
      return "Unreachable";
    case "error":
      return ERROR_LABEL;
    case "paused":
      return "Paused";
    case "disconnected":
      return "Disconnected";
    case "never_synced":
      return mode === "push" ? "Awaiting first push" : "Awaiting first sync";
    default:
      return null;
  }
}

function toneFor(input: FreshnessInput): Tone {
  switch (input.freshness.state) {
    case "ok":
      return "ok";
    case "error":
    case "unreachable":
      return "error";
    case "stale":
      // Tone rule (grammar, GENERALISED by #116). The old rule read "poll staleness is actionable;
      // webhook staleness is advisory — nothing is broken on our side; the device simply hasn't
      // pushed." That sentence was right and its condition was wrong: the distinction that earns
      // red is not poll-vs-push, it is **whether there is evidence of a problem**. A poll
      // connection whose last sync SUCCEEDED and is merely a tick late is in exactly the situation
      // the old comment describes — and three healthy Microsoft connections sat in NEEDS ATTENTION
      // for it, beside genuinely broken ones, teaching the band to be ignored.
      //
      // `stale` on its own says only "we have not heard in a while". Red is earned by EVIDENCE,
      // and the server states its evidence in `freshness.error`: a dead unstamped socket, or a
      // schedule missed so far past its cadence that the gateway itself is the suspect
      // (src/core/freshness.ts — the ONE derivation, which is where both thresholds live).
      //
      // This is still a pure read of a SERVED field. No timestamp is compared here, and a webhook
      // never carries an error, so its advisory calm is preserved by the general rule rather than
      // by a transport special case.
      return input.freshness.error ? "attention" : "idle";
    case "syncing":
    case "paused":
    case "disconnected":
    case "never_synced":
    default:
      return "idle";
  }
}

/** Render a served freshness tuple. This is the ONE derivation; `freshnessDisplay` and the kit's
 *  every page that renders a state word are all thin callers of it. */
export function renderFreshness(input: FreshnessInput): FreshnessDisplay {
  return {
    state: input.freshness.state,
    label: labelFor(input),
    caption: captionFor(input),
    nextLine: nextLineFor(input),
    tone: toneFor(input),
    lastHeardAt: input.freshness.last_heard_at,
  };
}

/**
 * The honest no-tuple fallback.
 *
 * A gateway that predates ADR 0023 omits `freshness`. We map only the SERVED lifecycle word —
 * `status` is a stored column, not a derivation — and we **stop there**. We do NOT reconstruct a
 * freshness state from timestamps: comparing `last_synced_at` to a hardcoded threshold, or
 * declaring a connection stale because `next_sync_at` is in the past, is precisely the client-side
 * staleness derivation the grammar's ban #1 exists to kill, and it is how three divergent copies
 * appeared in the first place.
 *
 * So an `active` connection with no tuple reports `ok` with **no badge and no next-line** — quiet,
 * with its raw `last_synced_at` as the caption. That is a refusal to guess, not a claim of health:
 * the grammar's Rule 1 already says badges are for exceptions, and we have no evidence of one.
 */
function fallbackFreshnessTuple(c: ConnectorStatus): Freshness {
  const base: Freshness = {
    state: "ok",
    last_heard_at: c.last_synced_at,
    next_expected_at: null, // never promised without a served tuple
    stream_state: null,
    error: null,
  };
  switch (c.status) {
    case "revoked":
      return { ...base, state: "disconnected" };
    case "paused":
      return { ...base, state: "paused" };
    case "syncing":
      return { ...base, state: "syncing" };
    case "error":
      return {
        ...base,
        state: "error",
        error: { message: c.last_error ?? "sync failed", since: c.last_error_at },
      };
    case "active":
    default:
      return base;
  }
}

/** The tuple to render: the server's word, or the served-lifecycle-only fallback. */
export function freshnessTupleOf(c: ConnectorStatus): Freshness {
  return c.freshness ?? fallbackFreshnessTuple(c);
}

/** Turn one connection into its rendered display. */
export function freshnessDisplay(c: ConnectorStatus): FreshnessDisplay {
  return renderFreshness({
    freshness: freshnessTupleOf(c),
    mode: c.policy_mode,
    // A pre-`push_kind` gateway says nothing about the next update rather than guessing.
    pushKind: c.push_kind ?? null,
    cachedCount: c.cached_count,
  });
}

/** The display for a sector/tile with NO connections at all. Deliberately wordless: a rollup over
 *  nothing has no state to report, and "nothing connected" is a `ZeroState` sentence
 *  (build-notes §14.1e), not a freshness badge. */
const EMPTY_ROLLUP: FreshnessDisplay = {
  state: "never_synced",
  label: null,
  caption: "",
  nextLine: "",
  tone: "idle",
  lastHeardAt: null,
};

/** Newest of a set of ISO timestamps, ignoring nulls and unparseable values. */
function newest(isos: (string | null)[]): string | null {
  let bestIso: string | null = null;
  let bestT = -Infinity;
  for (const iso of isos) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t <= bestT) continue;
    bestT = t;
    bestIso = iso;
  }
  return bestIso;
}

/** Earliest of a set of ISO timestamps, ignoring nulls and unparseable values. */
function earliest(isos: (string | null)[]): string | null {
  let bestIso: string | null = null;
  let bestT = Infinity;
  for (const iso of isos) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t >= bestT) continue;
    bestT = t;
    bestIso = iso;
  }
  return bestIso;
}

/**
 * The sector rollup (home tiles, sector-lens header, inspector header).
 *
 * - **State** = the WORST across the sector's connections (`FRESHNESS_SEVERITY`). Healthy = no badge.
 * - **Last heard** = the **NEWEST** `last_heard_at` across connections. The badge already carries
 *   any bad news; showing the oldest would double-count the alarm.
 * - **Next** = the **earliest** non-null `next_expected_at`; if none, the mode caption.
 *
 * The rollup runs the SAME `renderFreshness` over a synthesised tuple, so a tile can never say a
 * different word than the connection it summarises. Its "next" line resolves poll > webhook >
 * stream: a concrete timestamp beats a mode caption, and a device push is the weakest promise.
 *
 * Note the grammar sketches a COMPOSED next-line for mixed sectors ("Next check ~7:00 AM · + device
 * pushes"). `FreshnessDisplay.nextLine` is frozen to four values by the spec, so composition is
 * left to the page — this returns the strongest single line.
 */
export function freshnessRollup(cs: ConnectorStatus[]): FreshnessDisplay {
  if (cs.length === 0) return EMPTY_ROLLUP;

  const tuples = cs.map((c) => ({ c, f: freshnessTupleOf(c) }));

  let worst: FreshnessState = "ok";
  let worstRank = FRESHNESS_SEVERITY.indexOf("ok");
  let rep = tuples[0];
  for (const t of tuples) {
    const rank = FRESHNESS_SEVERITY.indexOf(t.f.state);
    // Unknown state (a newer gateway word) sorts last rather than crashing or winning.
    const r = rank === -1 ? FRESHNESS_SEVERITY.length : rank;
    if (r < worstRank) {
      worstRank = r;
      worst = t.f.state;
      rep = t;
    }
  }

  const lastHeard = newest(tuples.map((t) => t.f.last_heard_at));
  const nextExpected = earliest(tuples.map((t) => t.f.next_expected_at));

  // The synthesised tuple the tile speaks with: the worst word, the earliest promise, and — for the
  // clock — a deliberate split.
  //
  // A healthy tile's caption IS the sector's "Last synced" line, so it takes the NEWEST clock
  // (grammar: the badge already carries any bad news; showing the oldest would double-count the
  // alarm). An UNHEALTHY tile's caption names one connection's problem ("last heard from your
  // device 3d ago"), so it must quote THAT connection's clock — pairing the sentence with a
  // different connection's newest timestamp would be two clocks crossed inside one sentence.
  //
  // `lastHeardAt` on the result is always the newest, for the page's own "Last synced" slot.
  const rolled: Freshness = {
    state: worst,
    last_heard_at: worst === "ok" ? lastHeard : rep.f.last_heard_at,
    next_expected_at: nextExpected,
    // Stream/error facts come from the connection that OWNS the worst state, so the caption
    // describes the thing the badge is about.
    stream_state: rep.f.stream_state,
    error: rep.f.error,
  };

  // Label / caption / tone follow the REPRESENTATIVE connection's transport, so a webhook `stale`
  // in a mixed sector keeps its calm advisory sentence instead of borrowing a poll's alarm.
  const display = renderFreshness({
    freshness: rolled,
    mode: rep.c.policy_mode,
    pushKind: rep.c.push_kind ?? null,
    cachedCount: rep.c.cached_count,
  });

  // The next-line is a TILE-level fact and resolves poll > webhook > stream: a concrete timestamp
  // beats a mode caption, and a device push is the weakest promise of the three.
  const anyWebhook = cs.some((c) => c.policy_mode === "push" && c.push_kind === "webhook");
  const anyConnectedStream = cs.some(
    (c) =>
      c.policy_mode === "push" &&
      c.push_kind === "stream" &&
      freshnessTupleOf(c).stream_state === "connected",
  );
  let mode: PolicyMode | null = null;
  let pushKind: PushKind | null = null;
  if (nextExpected && cs.some((c) => c.policy_mode === "poll")) {
    mode = "poll";
  } else if (anyWebhook) {
    mode = "push";
    pushKind = "webhook";
  } else if (anyConnectedStream) {
    mode = "push";
    pushKind = "stream";
  }
  const nextLine = nextLineFor({
    freshness: anyConnectedStream ? { ...rolled, stream_state: "connected" } : rolled,
    mode,
    pushKind,
  });

  return { ...display, nextLine, lastHeardAt: lastHeard };
}

