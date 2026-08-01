// Gatehouse helpers — the pure logic the glance verdict is built from.
//
// The Gatehouse is a GLANCE VERDICT, not a launchpad (#63). Every derivation here answers the one
// test: can it FALSIFY the verdict sentence? Freshness can (a source went down); a grants table
// cannot (it restates config). So grants appear ONLY as a single masthead clause counting agents,
// never as a table.
//
// The server names every state; this file never computes freshness/staleness. "Needs attention" is
// read off the SERVED renderer's tone (`freshnessDisplay`), which is the one place a state word is
// derived (api/freshness.ts) — not from a timestamp compared to now.

import {
  freshnessDisplay,
  freshnessRollup,
  FRESHNESS_SEVERITY,
  freshnessTupleOf,
  type FreshnessDisplay,
} from "../../api/freshness";
import { count, humanize } from "../../api/format";
// The two grains and the one speller live in ONE module, which both this page and Sources read
// (#91). It sits in `pages/sources/` for now and belongs in `api/` — see the header of grain.ts.
import { cap, numberWord, spelled, type GrainCounts } from "../sources/grain";
import type { ConnectorStatus, Sector } from "../../api/types";
import type { ProviderId } from "../../marks";

/** Per-sector card metadata — the botanical latin subtitle (a fixed editorial identity label, like
 *  the sector's own name), the primary REGISTRY object whose count is the headline coverage figure
 *  with its noun, and an optional second figure. `canAct` marks the one sector whose connector
 *  exposes an action catalog (home) — an architectural fact of the gateway (CLAUDE.md: the act half
 *  "is real content for home ... and a stated empty for the five read-only sectors"), NOT a served
 *  catalog count. The count ("12 actions") needs `listActions`, which is NOT served (#89/§16.2), so
 *  it is deliberately absent — only the "can act" marker shows. Subtitles ported from the sector
 *  cards on artboard `1-0` (`3P9-0`/`3QJ-0`/`3SA-0`/`3TQ-0`/`3UQ-0`/`3VQ-0`). */
export interface SectorMeta {
  name: string;
  latin: string;
  primaryObject: string;
  noun: string;
  extra?: { object: string; noun: string };
  canAct?: boolean;
}

export const SECTOR_META: Record<Sector, SectorMeta> = {
  finance: {
    name: "Finance",
    latin: "Cumulus nummorum",
    primaryObject: "finance.transaction",
    noun: "records",
    extra: { object: "finance.account", noun: "accounts" },
  },
  mail: { name: "Mail", latin: "Epistola volans", primaryObject: "mail", noun: "envelopes" },
  calendar: { name: "Calendar", latin: "Discus mensis", primaryObject: "calendar", noun: "events" },
  contacts: {
    name: "Contacts",
    latin: "Myosotis amicorum",
    primaryObject: "contacts",
    noun: "contacts",
  },
  health: {
    name: "Health",
    latin: "Lamprocapnos salutis",
    primaryObject: "health.sample",
    noun: "samples",
  },
  home: {
    name: "Home",
    latin: "Domus lanterna",
    primaryObject: "home",
    noun: "entities",
    canAct: true,
  },
};

/** The connector `provider` string → its brand mark. A provider's mark is its invariant identity
 *  (ProviderTile is keyed by exactly this), so this is legitimate display — NOT the forbidden
 *  provider→custody map (§16.1), whose wrongness is that custody varies by flow. Unknown providers
 *  render no icon (null) rather than a guessed one. */
const PROVIDER_MARK: Record<string, ProviderId> = {
  simplefin: "simplefin",
  plaid: "plaid",
  whoop: "whoop",
  // The KEY is the wire value; the VALUE is the mark id, and for Home Assistant they differ.
  // `home_assistant` is what the gateway serves (src/connectors/homeassistant.ts `provider`,
  // passed through unmodified by core/lifecycle) — this map was keyed only on `homeassistant`, so
  // it never matched and the Home sector card and attention band rendered no mark at all while
  // every other provider got one. The unhyphenated form is kept as an alias, as sources/model.ts
  // already keeps it: the mark id itself is `homeassistant`, so both spellings resolve.
  home_assistant: "homeassistant",
  homeassistant: "homeassistant",
  microsoft: "microsoft",
  google: "google",
  gmail: "gmail",
  apple: "apple",
  apple_health: "apple_health",
};

export function providerMark(provider: string): ProviderId | null {
  return PROVIDER_MARK[provider] ?? null;
}

/** A connection "needs attention" iff the SERVED freshness renderer paints it in an actionable tone
 *  — `attention` (a poll source is overdue) or `error` (unreachable / auth failure). Webhook
 *  staleness is `idle` (the device owes us nothing) and paused/disconnected/never-synced/syncing are
 *  quiet by design (build-notes §14.1a): none raise the band. The tone is read off `freshnessDisplay`
 *  — the client never compares a timestamp to decide health. */
export function needsAttention(c: ConnectorStatus): boolean {
  const tone = freshnessDisplay(c).tone;
  return tone === "attention" || tone === "error";
}

/** Worst-first, mirroring the server's own severity order — so a band lists the most broken source
 *  at the top. */
export function bySeverity(a: ConnectorStatus, b: ConnectorStatus): number {
  const ra = FRESHNESS_SEVERITY.indexOf(freshnessTupleOf(a).state);
  const rb = FRESHNESS_SEVERITY.indexOf(freshnessTupleOf(b).state);
  return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
}

/**
 * The verdict sub-line's LEAD — the two grains, both named: "Eight sources · fourteen connections".
 *
 * The port collapsed a two-grain sentence into one and kept the wrong noun: `total = live.length` (a
 * CONNECTION count) rendered as "Eleven sources connected", and then the attention variant subtracted
 * one from the other ("N of M sources flowing") — arithmetic across two grains, which goes negative
 * the moment the leading number becomes provider-grain. The design names both totals and never
 * subtracts (`9KQ-0`, `F7Y-0`, `F85-0`), so the subtraction is deleted rather than repaired (#91).
 *
 * Both numbers come from `grain.sourceCounts`, the same function the Sources masthead reads.
 */
export function verdictLead(counts: GrainCounts): string {
  return `${cap(spelled(counts.sources, "source"))} · ${spelled(counts.connections, "connection")}`;
}

export interface Verdict {
  /** The headline, split into two lines the way the artboards break it. */
  headlineTop: string;
  headlineBottom: string;
}

/**
 * The exceptions-first headline (build-notes §14.4): the sentence CHANGES SHAPE when something is
 * wrong — it does not gain a warning beside an unchanged line. Ported from `1W-0` (healthy),
 * `46D-0` (one down), `4JD-0` (multi).
 *
 * The headline carries NO GRAIN NOUN, by operator ruling (#91, 2026-07-25): the design's own
 * "but three sources need you." (`46F-0`, `4JF-0`) attaches "sources" to a CONNECTION count — the
 * number is the one the attention band prints one screen-inch below, and that band lists one banner
 * per broken connection. Ruled: *"drop the noun — 'but three need your attention.'"* It is the
 * design's own device, already proven in the sub-line, and it means the headline never has to pick a
 * grain. (Rejected there: "but three connections need you" — clinical for the largest type on the
 * page; and counting distinct affected providers — the headline would then disagree with the band
 * immediately beneath it.)
 */
export function composeHeadline(attentionCount: number): Verdict {
  if (attentionCount === 0) {
    return { headlineTop: "Your gate is open,", headlineBottom: "and everything is flowing." };
  }
  if (attentionCount === 1) {
    return { headlineTop: "Your gate is open,", headlineBottom: "but one needs your attention." };
  }
  return {
    headlineTop: "Your gate is open,",
    headlineBottom: `but ${numberWord(attentionCount)} need your attention.`,
  };
}

/** The agents clause's word ("three agents hold keys" / "one agent holds keys" / "no agents hold
 *  keys"). It is the ONE grants surface on this page (#63, decision 10.2) — a link, never a table. */
export function agentsClause(agentCount: number): string {
  if (agentCount === 0) return "no agents hold keys";
  if (agentCount === 1) return "one agent holds keys";
  return `${numberWord(agentCount)} agents hold keys`;
}

/**
 * The ONE sector-scoped agents phrase (#100 item 10). Zero is "no agents hold keys here" everywhere.
 *
 * "Zero agents" had THREE phrasings across the Console: the sector card computed the un-English
 * "read by 0 agents", the lens verdict said "no agent holds keys here", and the lens CAN-READ lane
 * said "No agent holds keys to this domain yet." Two CONCEPTS exist — the gate holds N keys
 * (`agentsClause`, global) and N agents can read THIS sector (here) — and each gets exactly one
 * sentence. The two stay deliberately different: they are different scopes, and collapsing them
 * would make a sector's silence read as the whole gate's.
 */
export function sectorAgentsClause(agentCount: number): string {
  if (agentCount === 0) return "no agents hold keys here";
  return `read by ${count(agentCount)} agent${agentCount === 1 ? "" : "s"}`;
}

// ── the sector card's source rows (#100 item 8) ────────────────────────────────
//
// The card rendered one row per CONNECTION, each named `humanize(c.provider)` — so a 14-bank Plaid
// user got fourteen rows all reading "Plaid" and the card grew without bound. Each Plaid Item is its
// own credential (CLAUDE.md: one bank = one connection), so that is the ordinary case, not an edge.

/** One provider's aggregate row on a Gatehouse sector card. */
export interface SectorSourceGroup {
  /** The served provider wire value ("plaid", "home_assistant"). */
  provider: string;
  /** `humanize(provider)`. */
  name: string;
  connectionCount: number;
  /** `freshnessRollup(group)` — the SERVED renderer over the group. Never re-derived. */
  display: FreshnessDisplay;
}

export const SECTOR_CARD_MAX_SOURCES = 3;

/**
 * Group a sector's connections by provider, WORST-FIRST, capped at `SECTOR_CARD_MAX_SOURCES`.
 *
 * The ordering is LOAD-BEARING: the cap must never be able to hide the provider that needs you. A
 * cap that drops the one broken source is worse than no cap at all, so severity sorts before the
 * slice, using the server's own `FRESHNESS_SEVERITY` order (an unknown state — a newer gateway word
 * — sorts last rather than winning), with the name as a stable tie-break.
 *
 * `display` is `freshnessRollup(group)`, the ONE served renderer. For a single-connection provider
 * it runs the same `renderFreshness` over the same inputs as `freshnessDisplay(c)`, so grouping
 * cannot change what a lone source says about itself.
 */
export function groupSectorSources(cs: ConnectorStatus[]): {
  groups: SectorSourceGroup[];
  moreCount: number;
  /**
   * A connection from the FIRST hidden provider group, or null when nothing is hidden (#112).
   *
   * "and N more →" is a link about the sources this card could not show, and it used to land at the
   * top of /sources — a page listing everything, with no sign of where the reader came from. The
   * honest destination is where the first thing they could not see lives, so the caller derives the
   * href from this connection instead of hardcoding a path. Worst-first ordering means the hidden
   * groups are the QUIETEST ones, which is exactly why the card could afford to drop them.
   */
  moreFrom: ConnectorStatus | null;
} {
  const byProvider = new Map<string, ConnectorStatus[]>();
  for (const c of cs) {
    const g = byProvider.get(c.provider);
    if (g) g.push(c);
    else byProvider.set(c.provider, [c]);
  }

  const all: (SectorSourceGroup & { rep: ConnectorStatus })[] = [...byProvider.entries()].map(
    ([provider, group]) => ({
      provider,
      name: humanize(provider),
      connectionCount: group.length,
      display: freshnessRollup(group),
      // Kept for the overflow link only, and stripped off the returned rows: a glance card renders
      // provider aggregates, so putting a single connection on the row's own type would invite a
      // surface to speak about one connection while showing the group's rollup.
      rep: group[0],
    }),
  );

  const rank = (g: SectorSourceGroup): number => {
    const i = FRESHNESS_SEVERITY.indexOf(g.display.state);
    return i === -1 ? FRESHNESS_SEVERITY.length : i;
  };
  all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const hidden = all.slice(SECTOR_CARD_MAX_SOURCES);
  return {
    groups: all.slice(0, SECTOR_CARD_MAX_SOURCES).map(({ rep: _rep, ...g }) => g),
    moreCount: hidden.length,
    moreFrom: hidden[0]?.rep ?? null,
  };
}
