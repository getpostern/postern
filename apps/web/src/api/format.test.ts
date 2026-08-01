// `ago()` is THE relative-time helper (there were three) and `humanize()` is THE humanisation rule
// (there was none — #37). These tests pin the two things that make consolidation worth anything:
// the same input renders the same string everywhere, and an identifier is never quietly retitled.

import { describe, expect, it } from "vitest";
import { ago, count, hence, humanize, plural } from "./format";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("ago — one relative-time rendering", () => {
  it("renders the past", () => {
    expect(ago(at(-2 * MIN), NOW)).toBe("2m ago");
    expect(ago(at(-3 * HOUR), NOW)).toBe("3h ago");
    expect(ago(at(-9 * DAY), NOW)).toBe("9d ago");
  });

  it("renders the future", () => {
    expect(ago(at(12 * MIN), NOW)).toBe("in 12m");
    expect(ago(at(4 * HOUR), NOW)).toBe("in 4h");
  });

  it("collapses the last 45 seconds to 'just now' — a ticking '0m ago' reads as broken", () => {
    expect(ago(at(-1 * SEC), NOW)).toBe("just now");
    expect(ago(at(-44 * SEC), NOW)).toBe("just now");
    expect(ago(at(-46 * SEC), NOW)).toBe("46s ago");
  });

  it("an absent or unparseable timestamp is 'never' — the event has not happened", () => {
    expect(ago(null, NOW)).toBe("never");
    expect(ago("not-a-date", NOW)).toBe("never");
  });

  it("'never' is a fact about an EVENT, never about an unserved field", () => {
    // #58: a field the gateway does not serve is `NotServedError`'s sentence, not this one. If a
    // surface ever renders `ago(agent.last_seen_at ?? null)` for an UNDEFINED last_seen_at it will
    // claim the agent never called — which is false, not approximate.
    expect(ago(null, NOW)).not.toContain("not served");
  });

  it("is injectable, so nothing has to sleep to be tested", () => {
    // Rebound by #113: 90 minutes used to render "1h ago". The subject of this cell is
    // injectability, not the flooring — but the old expectation was the very understatement the
    // stale caption argued against, so it is restated at the new precision rather than moved.
    const later = new Date(NOW.getTime() + 90 * MIN);
    expect(ago(at(0), NOW)).toBe("just now");
    expect(ago(at(0), later)).toBe("1h30m ago");
  });
});

// ── #113 ──────────────────────────────────────────────────────────────────────
//
// A stale caption is an ARGUMENT and this magnitude is its evidence. The Gatehouse printed "nothing
// since 1h ago — check overdue" for a connection that goes stale at 1.5 h: the state was correct and
// the number beside it sat below its own trigger, so the operator read a working signal as a false
// alarm. Anything that renders a duration inherits this, which is why the guard lives here.
describe("magnitude never understates the duration it prints (#113)", () => {
  /** Parse a rendered magnitude back to ms — the assertion is about the STRING's information. */
  function parse(rendered: string): number {
    const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(rendered);
    if (!m) throw new Error(`unparseable magnitude: ${rendered}`);
    const [, d, h, min, s] = m;
    return (
      Number(d ?? 0) * DAY + Number(h ?? 0) * HOUR + Number(min ?? 0) * MIN + Number(s ?? 0) * SEC
    );
  }

  it("carries the remainder of the hour and day buckets", () => {
    // THE MUTATION: restore `return \`${Math.floor(s / 3600)}h\`` as the whole hours branch of
    // `magnitude` and the first row goes red. Each fixture sits INSIDE a bucket; a whole 2h or 3d
    // fixture passes either way, which is exactly why the defect shipped.
    expect(ago(at(-100 * MIN), NOW)).toBe("1h40m ago");
    expect(ago(at(-(3 * DAY + 7 * HOUR)), NOW)).toBe("3d7h ago");
  });

  it("keeps the short form when the remainder is zero", () => {
    expect(ago(at(-2 * HOUR), NOW)).toBe("2h ago");
    expect(ago(at(-4 * DAY), NOW)).toBe("4d ago");
  });

  it("from one minute to one day, is never more than a minute below the true duration", () => {
    // The class, not the example — every stale threshold this repo can produce below a day
    // (`pollStaleGraceMs` / `pollAlarmGraceMs` over the shipped cadences) lands on a whole minute,
    // so a sub-minute floor can never print a number under its own trigger.
    //
    // Round-to-nearest was the tempting alternative and fails this cell: it understates by up to
    // half a bucket, so a 2.4 h threshold tripped at 2.45 h still prints "2h" — the reported bug
    // with different numbers.
    //
    // THE BOUND IS ONE-SIDED, AND ONLY FROM A MINUTE UP. The seconds bucket ROUNDS, so it can print
    // ABOVE the true duration — 59.6 s renders "60s" — and a `printed <= ms` claim over it would be a
    // red waiting for its input rather than a property of the code. The bucket that rounds gets its
    // own two-sided cell below; a fixture list that happened to sit on whole seconds is what hid the
    // difference between the two guarantees.
    const durations = [
      5 * MIN, 59 * MIN + 30 * SEC,
      90 * MIN, 100 * MIN, 2 * HOUR + 59 * MIN, 23 * HOUR + 59 * MIN,
    ];
    for (const ms of durations) {
      expect(ms).toBeGreaterThanOrEqual(MIN); // the cell's own scope, stated rather than assumed
      const printed = parse(hence(at(ms), NOW)); // hence renders the bare magnitude
      expect(printed).toBeLessThanOrEqual(ms);
      expect(ms - printed).toBeLessThan(MIN);
    }
  });

  it("below a minute it ROUNDS, so the bound there is two-sided and under a second", () => {
    // The seconds branch is `Math.max(1, Math.round(s))` and that is deliberate: a ticking "0m ago"
    // reads as broken (hence `JUST_NOW_MS`), and no threshold in this repo is expressed in seconds,
    // so sub-minute precision is evidence for nothing. What it must not do is drift, in EITHER
    // direction, by a whole unit.
    for (const ms of [46 * SEC, 46_700, 59_400, 59_600]) {
      const printed = parse(hence(at(ms), NOW));
      expect(Math.abs(printed - ms)).toBeLessThanOrEqual(SEC / 2);
    }
    // the exact renderings, so the direction of the rounding is on the record and not inferred
    expect(hence(at(59_400), NOW)).toBe("59s");
    expect(hence(at(59_600), NOW)).toBe("60s");
  });

  it("beyond a day the floor is one hour — stated, not assumed", () => {
    // The day bucket prints days and hours, so "1d 0h 30m" reads "1d". That bound is deliberate:
    // three units ("9d5h30m") is a mono soup, and at multi-day scale nobody is comparing the number
    // against a sync cadence. It is asserted so the next person changing this knows the guarantee
    // they are standing on, rather than inferring the minute-level one from the cell above.
    for (const ms of [DAY + 30 * MIN, 3 * DAY + 7 * HOUR, 9 * DAY + 23 * HOUR]) {
      const printed = parse(hence(at(ms), NOW));
      expect(printed).toBeLessThanOrEqual(ms);
      expect(ms - printed).toBeLessThan(HOUR);
    }
  });
});

describe("hence — the same clock, rendered bare for the 'Next check ~{t}' slot", () => {
  it("drops the direction word, because the sentence already carries it", () => {
    expect(hence(at(12 * MIN), NOW)).toBe("12m");
    expect(hence(at(2 * HOUR), NOW)).toBe("2h");
  });

  it("an already-due promise reads 'now', never a negative countdown", () => {
    expect(hence(at(-5 * MIN), NOW)).toBe("now");
  });

  it("no timestamp → empty string, so the caller renders no next-line at all", () => {
    expect(hence(null, NOW)).toBe("");
    expect(hence("garbage", NOW)).toBe("");
  });

  it("agrees with ago() on magnitude — one computation, two renderings", () => {
    for (const ms of [90 * SEC, 12 * MIN, 5 * HOUR, 3 * DAY]) {
      expect(ago(at(ms), NOW)).toBe(`in ${hence(at(ms), NOW)}`);
    }
  });
});

describe("humanize — one rule, plus an explicit brand table", () => {
  it("splits machine tokens and capitalises", () => {
    expect(humanize("sleep_session")).toBe("Sleep Session");
    expect(humanize("finance.transaction")).toBe("Finance Transaction");
    expect(humanize("fetch_live")).toBe("Fetch Live");
    expect(humanize("get-schema")).toBe("Get Schema");
  });

  it("spells brands the way they spell themselves — exact-key lookup, no fuzzy matching", () => {
    expect(humanize("simplefin")).toBe("SimpleFIN");
    expect(humanize("home_assistant")).toBe("Home Assistant");
    expect(humanize("apple_health")).toBe("Apple Health");
    expect(humanize("icloud")).toBe("iCloud");
    expect(humanize("whoop")).toBe("WHOOP");
  });

  it("names the two Apple providers apart — `apple` is iCloud, `apple_health` is Apple Health", () => {
    // Both are Apple products and share the Apple glyph (per the locked-assets plate), but they are
    // different things: `apple` is an Apple ID + app-specific password reaching iCloud Mail /
    // Calendar / Contacts over IMAP+DAV, while `apple_health` is on-device push from a Shortcut.
    // Before this, `apple` had no entry and fell through to the generic rule as "Apple", so the
    // Sources list showed "Apple" directly above "Apple Health" and a user could not tell which row
    // the credential they just added had become. Provider KEYS are unchanged (ADR 0030).
    expect(humanize("apple")).toBe("iCloud");
    expect(humanize("apple_health")).toBe("Apple Health");
    expect(humanize("apple")).not.toBe(humanize("apple_health"));
  });

  it("spells Home Assistant the same from the WIRE value and from the MARK id (#95 item 2)", () => {
    // The one provider whose served value (`home_assistant`, src/connectors/homeassistant.ts) and
    // whose locked-plate mark id (`homeassistant`) are different strings. Five production sites call
    // `humanize(c.provider)` directly — gatehouse/SectorCard, gatehouse/AttentionBand, lenses/
    // SectorLens, inspector/RecordDrillPage, records/EraseConfirmPage — and were safe only because
    // the wire happens to serve the underscored spelling. The same two-spelling split is what made
    // the Home Assistant revoke row invisible on the real box, so the table answers to both.
    //
    // MUTATION: delete the `homeassistant` row from HUMANIZED and this cell goes red with
    // "Homeassistant" — the generic rule's honest, wrong answer for a proper noun it cannot know.
    expect(humanize("homeassistant")).toBe("Home Assistant");
    expect(humanize("homeassistant")).toBe(humanize("home_assistant"));
    expect(humanize("homeassistant")).not.toBe("Homeassistant");
  });

  it("does NOT substring-match a brand out of a longer token", () => {
    // The institution-mark trap in miniature: "First National Bank of Discovery" must not pick up
    // the Discover mark, and "simplefinance" must not become "SimpleFIN…".
    expect(humanize("simplefinance")).toBe("Simplefinance");
    expect(humanize("whoopie")).toBe("Whoopie");
  });

  it("is idempotent on its own output for single-word tokens", () => {
    expect(humanize(humanize("mail"))).toBe("Mail");
  });

  it("survives empty and whitespace input without inventing a word", () => {
    expect(humanize("")).toBe("");
    expect(humanize("   ")).toBe("");
  });

  it("would MANGLE an identifier — which is why identifiers are a call-site exclusion", () => {
    // The other half of #37 lives at the call site: uuids, source_object_ids, agent ids and keys
    // stay raw and monospaced. This assertion documents the damage, so nobody wires it by accident.
    const uuid = "a1b2c3d4-e89f-4a1b-8c2d-3e4f5a6b7c8d";
    expect(humanize(uuid)).not.toBe(uuid);
    expect(humanize("union:plaid:acct_9912")).not.toBe("union:plaid:acct_9912");
  });
});

describe("count — one integer formatting", () => {
  it("groups thousands", () => {
    expect(count(1234)).toBe("1,234");
    expect(count(0)).toBe("0");
  });
});

// ── #92 ───────────────────────────────────────────────────────────────────────
//
// "feeds 1 banks", live on the operator's Console. The plural guard was hand-rolled at twenty-odd
// sites and the twenty-first was missed — the issue's own remedy: "a tiny shared `plural(n, "bank")`
// helper would prevent recurrence." These cells own the rule; the CALL SITES are pinned where they
// render (`pages/sources/SourcesPage.test.tsx`, `pages/sources/model.test.ts`).
describe("plural — the one count-with-noun rule (#92)", () => {
  it("one is singular and everything else is not — including zero", () => {
    // MUTATION: return `${count(n)} ${many}` unconditionally and the first row goes red; return the
    // singular unconditionally and the second and third do.
    expect(plural(1, "bank")).toBe("1 bank");
    expect(plural(2, "bank")).toBe("2 banks");
    // Zero takes the plural in English ("no banks"), which the `n === 1` test gets right and an
    // `n > 1` test would not — that off-by-one is the other half of this defect class.
    expect(plural(0, "bank")).toBe("0 banks");
  });

  it("takes an explicit plural, because English is not a suffix rule", () => {
    // entity/entities is a real coverage noun on this surface (`SECTOR_NOUN.home`), and "1 entitys"
    // would be a worse bug than the one being fixed.
    expect(plural(1, "entity", "entities")).toBe("1 entity");
    expect(plural(1847, "entity", "entities")).toBe("1,847 entities");
  });

  it("routes the number through `count`, so no surface renders a bare four-figure tally", () => {
    // Two spellings of the same number on adjacent surfaces is the defect `count` exists to kill;
    // a helper that interpolated `n` directly would quietly reintroduce it at every converted site.
    expect(plural(2626, "envelope")).toBe(`${count(2626)} envelopes`);
    expect(plural(2626, "envelope")).toContain(",");
  });
});
