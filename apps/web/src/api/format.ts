// The ONE relative-time helper, the tick that makes it advance, and the ONE humanisation rule.
//
// Why this file exists (audit #37 + the freshness grammar's Rule 1): the Console had THREE
// divergent relative-time implementations (`pages/overview/helpers.ts`, `pages/connections/
// helpers.ts`, `pages/inspector/format.tsx`) and no single answer for when a machine token is
// shown raw versus humanised. Both are one rule here. The three page-local copies die with their
// pages in phase 3 — `elapsed.test.ts` fails if a FOURTH appears.
//
// There is exactly one duration computation in this module (`elapsed`). `ago()` and `hence()` are
// two RENDERINGS of it, not two implementations — the grammar needs both shapes ("4m ago" for the
// last-heard clock, a bare "12m" after "Next check ~").

import { useEffect, useState } from "react";

/** Below this, a timestamp reads as "just now" rather than "0m ago" — a 12-second-old sync is not
 *  usefully different from this instant, and a ticking "0m ago" reads as broken. */
const JUST_NOW_MS = 45_000;

/** The one duration computation. Returns null for an absent/unparseable timestamp — the CALLER
 *  decides what nothing means, because "never synced" and "not served" are different sentences and
 *  a formatter must not pick one. */
function elapsed(iso: string | null | undefined, now: Date): { ms: number; past: boolean } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = now.getTime() - t;
  return { ms: Math.abs(ms), past: ms >= 0 };
}

/**
 * The bare magnitude ("42s" / "12m" / "1h40m" / "9d5h"). Never carries direction.
 *
 * The hour and day buckets carry their REMAINDER, and that is load-bearing rather than decorative
 * (#113). A stale caption is an ARGUMENT and its number is the evidence: a WHOOP connection with a
 * 1 h cadence override goes stale at 1.5 h, and at 1 h 40 m the floored magnitude rendered
 * *"nothing since 1h ago — check overdue"* — a correct warning whose own number sat below its own
 * threshold, which teaches the reader to distrust a signal that is working.
 *
 * Rounding to nearest was rejected: it understates by up to half a bucket, so a 2.4 h threshold
 * tripped at 2.45 h still rounds DOWN to "2h". That fixes the reported example and not the class.
 * Carrying the remainder bounds the understatement at under a minute, at every scale.
 *
 * The remainder is omitted when zero, so an exact duration keeps the short form ("3h", "9d").
 */
function magnitude(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s - h * 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s - d * 86_400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

/**
 * THE relative-time helper — "4m ago" / "in 12m" / "just now" / "never".
 *
 * `now` is injectable so every caller is testable without sleeping. Anything unparseable or absent
 * renders "never": this helper is only ever handed a *timestamp* slot, and an empty timestamp slot
 * means the event has not happened. It is NEVER used for an unserved field — that is
 * `NotServedError`'s sentence, and confusing the two is #58.
 */
export function ago(iso: string | null, now: Date = new Date()): string {
  const e = elapsed(iso, now);
  if (!e) return "never";
  if (e.ms < JUST_NOW_MS) return "just now";
  return e.past ? `${magnitude(e.ms)} ago` : `in ${magnitude(e.ms)}`;
}

/**
 * The forward-looking magnitude with no direction word, for the grammar's "Next check ~{t}" slot
 * where the sentence already carries the direction. Empty string when there is no timestamp — the
 * caller renders no next-line at all rather than a next-line about nothing.
 *
 * Same `elapsed`/`magnitude` computation as `ago()`; a second rendering, not a second clock.
 */
export function hence(iso: string | null, now: Date = new Date()): string {
  const e = elapsed(iso, now);
  if (!e) return "";
  // Already due: the promise has come and gone. "~now" is honest; a negative countdown is not.
  if (e.past) return "now";
  if (e.ms < JUST_NOW_MS) return "now";
  return magnitude(e.ms);
}

/**
 * Re-render on an interval so relative labels advance **without a refetch** (#62).
 *
 * The bug this fixes: the operator watches a connection card and "synced 2m ago" sits frozen,
 * because the only thing that moved the clock was a network round-trip. Freshness *data* polling
 * is a separate contract (`hooks.ts`); this is purely the label's second hand, and it must never
 * be used to trigger a fetch.
 *
 * Returns an incrementing tick so a component can also key off it if needed.
 */
export function useTick(seconds = 30): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const id = setInterval(() => setTick((t) => t + 1), seconds * 1000);
    return () => clearInterval(id);
  }, [seconds]);
  return tick;
}

/**
 * Brand casings the generic rule gets wrong. **Exact-key lookup only** — no substring matching, no
 * fuzzy inference. These are proper nouns whose spelling is a fact, not a guess; anything not
 * listed falls through to the generic rule rather than being approximated.
 */
const HUMANIZED: Record<string, string> = {
  simplefin: "SimpleFIN",
  home_assistant: "Home Assistant",
  // BOTH spellings, deliberately. `home_assistant` is what the wire serves
  // (`src/connectors/homeassistant.ts`); `homeassistant` is the locked-plate MARK id, which three
  // page groups key on and which reached this function as "Homeassistant" (#95 item 2). The five
  // sites that call `humanize(c.provider)` directly were safe only by the accident of never being
  // handed the mark-id spelling — and the same two-spelling split is what made the Home Assistant
  // revoke row invisible on the real box. One table, both keys, one answer.
  homeassistant: "Home Assistant",
  apple_health: "Apple Health",
  // The provider key for the app-specific-password credential is `apple` (ADR 0030), but its user
  // -facing name is iCloud — it is iCloud Mail / Calendar / Contacts the user linked, and calling it
  // "Apple" put it beside "Apple Health" in the same list with no way to tell which row a new
  // credential became. Keys unchanged; display only. `icloud` is the connect-catalog slug.
  apple: "iCloud",
  icloud: "iCloud",
  whoop: "WHOOP",
  gmail: "Gmail",
  oauth: "OAuth",
  mcp: "MCP",
  imap: "IMAP",
  caldav: "CalDAV",
  carddav: "CardDAV",
  on_demand: "On demand",
  never_synced: "Never synced",
};

/**
 * THE humanisation rule (#37): split a machine token on `_`, `-`, `.` and whitespace, capitalise
 * each word, join with spaces — with the explicit brand table above as the only exception.
 *
 * The other half of #37 is a CALL-SITE rule this function deliberately cannot enforce: **a true
 * identifier is never humanised.** A uuid, a `source_object_id`, an agent id, a Plaid item id, a
 * bearer key, an institution `bankKey` — those stay raw and monospaced, because their exact
 * characters are the point and title-casing one makes it wrong as well as prettier. Humanise
 * vocabulary (providers, sectors, tools, modes, states); print identity.
 */
export function humanize(token: string): string {
  const key = token.trim().toLowerCase();
  if (key.length === 0) return "";
  const exact = HUMANIZED[key];
  if (exact) return exact;
  return key
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Locale integer formatting for counts (tabular-friendly). One place, so 1234 never renders as
 *  "1234" on one surface and "1,234" on the next. */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * THE count-with-noun rule: `plural(1, "bank")` → "1 bank", `plural(14, "bank")` → "14 banks" (#92).
 *
 * It exists because the guard was hand-rolled — `${n} ${n === 1 ? "x" : "xs"}` — at twenty-odd sites,
 * and the twenty-first was missed: the Sources page's Plaid group header read **"feeds 1 banks"** for
 * a single connected bank, which is the ordinary case for a new user (each Plaid Item is its own
 * credential, so one bank = one connection). Three more sites in the same file carried the same
 * omission and were unreachable only because a grouping rule happened to imply n > 1 — safety on
 * loan from a rule one refactor away from changing. The issue asked for exactly this helper: "a tiny
 * shared `plural(n, "bank")` helper would prevent recurrence."
 *
 * `many` is derived as `${one}s` and OVERRIDABLE, because English is not a rule: entity/entities and
 * is/are do not suffix. The number goes through `count`, so a four-figure tally never renders as
 * "1234 records" beside a "1,234 records" one surface over.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
