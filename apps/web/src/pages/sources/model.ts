// The Sources view-model — pure derivations over the SERVED wire (ConnectorStatus[] +
// FinanceBankSummary[]). No React, no fetching, no freshness computed here: freshness comes from
// `freshnessDisplay` (the ONE sanctioned derivation, api/freshness.ts) — this file only *reads* the
// tone/state it already produced. Everything here is unit-tested (model.test.ts).
//
// The load-bearing shape (build-notes §6, §12.1): Sources is "a header for the thing you'd remove to
// kill them all, with its connections nested." Credentials fan out to sectors (iCloud → mail·calendar·
// contacts); a Plaid app fans out to banks (each Item is its OWN connection — there is no single
// "Plaid connector"). Single-connection providers stay flat.
//
// The thing you'd remove is the CREDENTIAL, so we group non-Plaid connectors by their proven
// `credentialId` — NOT by the provider string. The list wire carries no `credentialId` (only the
// detail does, #89), so the caller resolves it from the detail wire (`useConnectorCredentials`) and
// stitches it on as `ConnectorWithCredential.credentialId`. Grouping by the provider string would
// collapse two consents for one provider (two Microsoft, two Gmail) into a single fan-out group
// whose "Remove" claims the whole group but revokes only one credential — a false boundary and an
// understated blast radius (BLOCK 2). Plaid stays grouped by app (its Items each have their own
// credential; §12.1) — the one provider whose group deliberately spans many credentials.

import { freshnessDisplay, type FreshnessDisplay } from "../../api/freshness";
import { ago, humanize, plural } from "../../api/format";
import { cap, numberWord, sourceCounts, spelled, type GrainCounts } from "./grain";
// The FILE, not the `../../marks` barrel: this module is a pure derivation with no React in it, and the
// barrel pulls components and their CSS (the same reason `grain.ts` reaches into `marks/institutions`
// directly). `ProviderId` was a type-only import and is erased; `providerMarkFor` is a real value.
import { providerMarkFor } from "../../marks/providerMarks";
import type { ProviderId } from "../../marks";
import type { ConnectorStatus, Sector } from "../../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// Provider vocabulary — the mock-free descriptor sub and the mark id. The display NAME is not here:
// there is one humanisation rule (`humanize`, api/format.ts) and this file defers to it.
//
// A second display table lived here until 2026-07-25 and is why the `apple` → iCloud rename (§18.4.1)
// looked applied and was not: `format.ts` said `iCloud`, this map said `Apple`, and every Sources /
// connection-detail surface read this one. The two tables had already drifted on a second provider
// (`Whoop` here vs `WHOOP` there), so the entry was never the defect — the duplicate was.
//
// What remains is descriptive COPY about a provider's fixed nature (ADR 0030 says the Apple ID
// credential is IMAP+DAV); it is NOT the not-served `custody`/`reconnect_kind` discriminant and is
// never used to choose a reconnect flow (that stays degraded — see SourcesPage / ConnectionDetail).
// ─────────────────────────────────────────────────────────────────────────────

// This file's own `PROVIDER_TILE` was DELETED 2026-07-26 (#95 item 8) — it was the third copy of one
// wire→mark-id table, and three copies of a table whose two vocabularies differ for Home Assistant is
// exactly the drift that made the HA mark invisible on the real box. The translation now lives in
// `marks/providerMarks.ts`, beside the vault that owns the mark ids, and `providerTileId` is a
// pass-through. `marks/providerMarks.test.tsx` pins that no fourth copy can appear silently.

/** The descriptor line under a provider name ("app-password · imap + dav"). Fixed per provider. */
const PROVIDER_SUB: Record<string, string> = {
  apple: "app-password · imap + dav",
  apple_health: "on-device · push · health",
  microsoft: "byo app · oauth",
  google: "byo app · oauth",
  gmail: "app-password · imap",
  plaid: "byo app · finance",
  simplefin: "static token · finance",
  whoop: "byo app · oauth · health",
  homeassistant: "long-lived token · home",
  home_assistant: "long-lived token · home",
};

/**
 * A provider's user-facing name — resolved through the ONE humanisation rule, never a local table.
 *
 * It used to normalise `homeassistant` (the MARK id, still keyed on by three page groups) to
 * `home_assistant` (the SERVED value) before calling `humanize`, so the legacy spelling could not
 * resolve to "Homeassistant". That branch protected THIS call site and nothing else: five surfaces
 * call `humanize(c.provider)` directly and would still have printed "Homeassistant" (#95 item 2).
 * The row now lives in `HUMANIZED` itself, where every caller inherits it, so this is a literal
 * pass-through — and `model.test.ts` pins that the two spellings still answer identically.
 */
export function providerDisplay(provider: string): string {
  return humanize(provider);
}

/** The mark id for a provider, or null when the vault carries no tile (never invent one). Delegates to
 *  the ONE table in `marks/` — this page group keeps the alias only so existing call sites read the
 *  same as before. */
export function providerTileId(provider: string): ProviderId | null {
  return providerMarkFor(provider);
}

export function providerSub(provider: string): string {
  return PROVIDER_SUB[provider] ?? "";
}

/**
 * The sector's user-facing name. It lived privately in both `SourcesPage.tsx` and
 * `ConnectionDetail.tsx`, which is the same duplicate-vocabulary mechanism that made the `apple` →
 * iCloud rename look applied and not be (see the PROVIDER_SUB note above). Callers keep a
 * `?? c.sector` fallback for an unknown wire value — a safety net, not a licence for a missing key
 * (`model.test.ts` asserts full `Sector` coverage).
 *
 * NOT yet the only copy: `shell/NavRail.tsx` still holds a private one (#105 item 5, routed to #91).
 * Its right home is `api/types.ts` beside `SECTORS` — the module both the shell and the pages already
 * import, so neither has to depend on the other; moving it there was outside the #91 unit's file set.
 * Until then `shell/NavRail.test.tsx` pins the rail's labels against THIS table, so the two cannot
 * drift in silence — which is all the duplicate could ever cost.
 */
export const SECTOR_LABEL: Record<Sector, string> = {
  finance: "Finance",
  mail: "Mail",
  calendar: "Calendar",
  contacts: "Contacts",
  health: "Health",
  home: "Home",
};

// ─────────────────────────────────────────────────────────────────────────────
// Coverage nouns + interval formatting.
// ─────────────────────────────────────────────────────────────────────────────

/** The primary coverage noun a sector's connection reports. `cached_count` is the connection's live
 *  row total; for multi-object sectors it slightly over-counts the primary noun (health includes
 *  workouts/sleep) — a glance figure, not an audited one. */
const SECTOR_NOUN: Record<Sector, [one: string, many: string]> = {
  mail: ["envelope", "envelopes"],
  calendar: ["event", "events"],
  contacts: ["contact", "contacts"],
  health: ["sample", "samples"],
  home: ["entity", "entities"],
  finance: ["account", "accounts"],
};

export function coverageNoun(sector: string, n: number): string {
  const pair = SECTOR_NOUN[sector as Sector];
  // The fallback carried the SAME missing plural guard as the #92 Plaid header ("1 rows"), and it is
  // the more dangerous of the two because all six sectors are covered today — so it can only fire on
  // the addition of a SEVENTH sector, the one change least likely to be looking for it. It goes
  // through the ONE count-with-noun rule now, like every other site.
  if (!pair) return plural(n, "row");
  return plural(n, pair[0], pair[1]);
}

/** Whole-unit interval label ("5m" / "15m" / "2h" / "6h" / "1d"). Null when no interval is served. */
export function formatInterval(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) {
    const h = sec / 3600;
    return `${Number.isInteger(h) ? h : Math.round(h * 10) / 10}h`;
  }
  const d = sec / 86_400;
  return `${Number.isInteger(d) ? d : Math.round(d * 10) / 10}d`;
}

/** The interval that actually drives the timer: clamp(override ?? default, floor). Mirrors the
 *  server's `effectiveIntervalSec` (ADR 0025) — a user may only ever slow a poll down. */
export function effectiveIntervalSec(c: {
  sync_interval_sec: number | null;
  default_interval_sec: number | null;
  min_interval_sec: number | null;
}): number | null {
  const base = c.sync_interval_sec ?? c.default_interval_sec ?? null;
  if (base == null) return null;
  const floor = c.min_interval_sec ?? 0;
  return Math.max(base, floor);
}

/** The rungs of the product's cadence vocabulary: 5m · 15m · 30m · 1h · 6h · 12h · 1d. */
const CADENCE_LADDER = [300, 900, 1800, 3600, 21600, 43200, 86400];

/** The cadence chips a poll connection may choose. Every ladder rung at or above the connector's
 *  floor, plus the floor itself and the current effective value, ascending — so the selected chip is
 *  always present and no below-floor preset is ever offered. NOT truncated: a `.slice(0, 6)` here
 *  made `1d` unreachable everywhere and dropped `12h` too on any connector with an off-ladder
 *  default (#96 §8). */
export function cadencePresets(c: {
  sync_interval_sec: number | null;
  default_interval_sec: number | null;
  min_interval_sec: number | null;
}): { sec: number; label: string }[] {
  const floor = c.min_interval_sec ?? 0;
  const eff = effectiveIntervalSec(c);
  const set = new Set<number>(CADENCE_LADDER.filter((s) => s >= floor));
  if (floor > 0) set.add(floor);
  if (eff != null) set.add(eff);
  return [...set]
    .sort((a, b) => a - b)
    .map((sec) => ({ sec, label: formatInterval(sec) ?? `${sec}s` }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-connection cells (cadence + last-heard), keyed on the SERVED freshness display.
// ─────────────────────────────────────────────────────────────────────────────

/** A connection is "unhealthy" iff the ONE freshness derivation coloured it attention/error. We read
 *  that tone; we never re-derive staleness from a timestamp (freshness-grammar ban #1). */
export function isUnhealthy(d: FreshnessDisplay): boolean {
  return d.tone === "error" || d.tone === "attention";
}

export interface Cell {
  text: string;
  /** true → render in seal (the exception colour). */
  alarm: boolean;
}

/**
 * The CADENCE column. Poll shows its effective interval; a live stream / device push name their
 * transport; a held (paused/errored) poll says so instead of quoting a schedule it isn't keeping.
 *
 * A Plaid bank row inherits this cell from its own connector too (`plaidBankRows`) — it is only
 * displaced when that bank's consent has LAPSED, which is the one thing about a bank the schedule
 * cannot express. It used to be displaced on every row, healthy ones included, by a `consent ok`
 * that made the column heading a promise the column did not keep (§18.2).
 */
export function cadenceCell(c: ConnectorStatus, d = freshnessDisplay(c)): Cell {
  if (d.state === "paused") return { text: "paused", alarm: false };
  if (c.policy_mode === "push") {
    // #106: this lane answers "how often does this update?", and it answered with two transport
    // names. "websocket" is a protocol nobody managing their own home recognises, and "on write" is
    // our word for the moment a device posts. Both now answer the question the column asks.
    return { text: c.push_kind === "webhook" ? "push · when sent" : "push · live", alarm: false };
  }
  if (isUnhealthy(d)) return { text: "held", alarm: false };
  const iv = formatInterval(effectiveIntervalSec(c));
  return { text: iv ? `every ${iv} · poll` : "poll", alarm: false };
}

/**
 * The LAST HEARD column. A connected live stream reads "streaming" (a fact, not a clock); everything
 * else quotes the served `last_heard_at`, in seal when the connection is unhealthy.
 */
export function lastHeardCell(c: ConnectorStatus, d = freshnessDisplay(c)): Cell {
  const streaming =
    c.policy_mode === "push" &&
    c.push_kind === "stream" &&
    d.state === "ok" &&
    (c.freshness?.stream_state ?? null) === "connected";
  if (streaming) return { text: "streaming", alarm: false };
  return { text: ago(d.lastHeardAt), alarm: isUnhealthy(d) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping.
// ─────────────────────────────────────────────────────────────────────────────

export type GroupKind = "fanout" | "plaid" | "flat";

/** A served connector row. `credentialId` is served on the list itself (core `toStatus`), so no
 *  enrichment is needed — this alias remains only so existing call sites read clearly. Grouping still
 *  keys Plaid by app (its per-Item credentials never form a shared boundary; §12.1). */
export type ConnectorWithCredential = ConnectorStatus;

export interface ProviderGroup {
  provider: string;
  kind: GroupKind;
  connectors: ConnectorStatus[];
  /**
   * The credential this group represents — "the thing you'd remove to kill them all." Defined for
   * every fan-out and (resolved) flat group; it is the id `revokeCredential` targets, and the group's
   * connectors ARE exactly that credential's connectors, so the destructive blast radius is proven,
   * not guessed. `undefined` only for the Plaid group (spans many per-Item credentials) or a flat
   * group whose detail has not resolved yet.
   */
  credentialId?: string;
}

const KIND_ORDER: Record<GroupKind, number> = { fanout: 0, plaid: 1, flat: 2 };

/**
 * Group the flat connector list into removable units. Non-Plaid connectors group by their proven
 * `credentialId`; a connector with no resolved credentialId keys on its own `connectionId` so it is
 * NEVER merged with another into a boundary the wire can't prove. Plaid connectors form one group
 * per app (its Items each carry their own credential; §12.1). Order: fan-out credentials, then the
 * Plaid app, then single-connection groups — each block alphabetised, with the credentialId as the
 * stable tiebreak so two same-provider credentials order deterministically.
 */
export function groupConnectors(connectors: ConnectorWithCredential[]): ProviderGroup[] {
  const plaid: ConnectorWithCredential[] = [];
  const byCredential = new Map<string, { key: SourceGroupKey; cs: ConnectorWithCredential[] }>();
  for (const c of connectors) {
    // The ONE keying rule, shared with `sourceGroupAnchorId` (#112) — see `sourceGroupKey`. Even the
    // Plaid branch reads from it, so "which group is this in" is answered in a single place.
    const key = sourceGroupKey(c);
    if (key.kind === "plaid") {
      plaid.push(c);
      continue;
    }
    const bucket = key.kind === "credential" ? `cred:${key.credentialId}` : `conn:${key.connectionId}`;
    const list = byCredential.get(bucket);
    if (list) list.cs.push(c);
    else byCredential.set(bucket, { key, cs: [c] });
  }

  const groups: ProviderGroup[] = [];
  if (plaid.length > 0) {
    groups.push({ provider: "plaid", kind: "plaid", connectors: plaid });
  }
  for (const { key, cs } of byCredential.values()) {
    const credentialId = key.kind === "credential" ? key.credentialId : undefined;
    const kind: GroupKind = cs.length > 1 ? "fanout" : "flat";
    groups.push({ provider: cs[0].provider, kind, connectors: cs, credentialId });
  }

  groups.sort((a, b) => {
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k !== 0) return k;
    const n = providerDisplay(a.provider).localeCompare(providerDisplay(b.provider));
    if (n !== 0) return n;
    return (a.credentialId ?? "").localeCompare(b.credentialId ?? "");
  });
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// The /sources landing anchor (#112).
// ─────────────────────────────────────────────────────────────────────────────
//
// Three surfaces linked to a bare `/sources`: the Gatehouse card's "and N more →", the lens
// institution run's twin, and a finance provider-aggregate row's "Manage →". Each was about ONE
// provider's connections and each landed at the top of a page listing everything, with no sign of
// where the reader came from. There was nothing to link to: the page's groups carried no id.
//
// The anchor is keyed on the CREDENTIAL, never the provider name. One credential fans out to N
// sector connectors (iCloud → mail · calendar · contacts) and each Plaid Item is its own credential
// (CLAUDE.md), so "the Plaid section" is not a single thing on either axis — while the Sources page
// really does draw ONE Plaid group spanning those per-Item credentials, because that is the app you
// would remove to kill them all (§12.1).
//
// Nothing here decides whether /sources should be divided by sector. That is a design ruling on the
// grouping itself and is deliberately untouched.

/**
 * Which /sources group a connection belongs to. THE keying rule, and there is exactly one.
 *
 * `groupConnectors` (the page) and `sourceGroupAnchorId` (every link into the page) both call this,
 * because a link that keys differently from the page that renders the ids is a silent scroll to
 * nothing. They used to hold two *descriptions* of one rule and diverged on the shape neither
 * mentioned: grouping keyed with `??` while the anchor keyed on TRUTHINESS, so two connectors with a
 * blank `credentialId` landed in ONE group and minted TWO different ids — a link to a fragment no
 * element carries, i.e. exactly the dead anchor this whole seam exists to prevent.
 *
 * A BLANK credentialId is "unresolved", not "a credential named empty string". `groupConnectors`'
 * own contract is that an unresolved credential is NEVER merged with another into a boundary the
 * wire can't prove — the group's Remove claims everything under it — so blank falls to the
 * connection, in both callers at once.
 */
export type SourceGroupKey =
  | { kind: "plaid" }
  | { kind: "credential"; credentialId: string }
  | { kind: "connection"; connectionId: string };

export function sourceGroupKey(c: {
  provider: string;
  credentialId?: string | null;
  connectionId: string;
}): SourceGroupKey {
  // Plaid is the one group that deliberately spans many credentials — the app you'd remove to kill
  // them all (§12.1) — so it keys on the app, following the page rather than the credential.
  if (c.provider === "plaid") return { kind: "plaid" };
  const cred = c.credentialId ?? "";
  if (cred.trim().length > 0) return { kind: "credential", credentialId: cred };
  return { kind: "connection", connectionId: c.connectionId };
}

/**
 * Escape a served id into the DOM-id charset, INJECTIVELY.
 *
 * The first version collapsed every out-of-charset character to "-", which is not injective:
 * `"a.b"` and `"a-b"` both became `"a-b"`, so two DIFFERENT groups rendered two sibling elements
 * carrying the SAME id — invalid HTML, `getElementById` silently answers the first, and the arrival
 * mark paints the wrong group. Distinct inputs must stay distinct ids or the whole seam is a
 * coin-flip on ids the gateway happens to serve.
 *
 * Alnum and `-` pass through (so a uuid is untouched and the fragment stays readable in the address
 * bar); `_` doubles; anything else becomes `_` + four hex digits. Fixed width, and `_` is never
 * followed by `_` in an escape, so the encoding is decodable and therefore injective.
 *
 * Deliberately per-CODE-UNIT (no `u` flag, `charCodeAt`): a code point above 0xFFFF would need five
 * hex digits, and a variable-width escape is ambiguous with a four-digit escape followed by a literal
 * digit — i.e. not injective, which is the whole point of this function. A surrogate pair becomes two
 * four-digit escapes instead.
 */
function idSafe(s: string): string {
  return s
    .replace(/_/g, "__")
    .replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The DOM id of the /sources group a connection lands in — `sourceGroupKey`, escaped.
 *
 * `model.test.ts` pins it against `groupConnectors` over every group shape rather than trusting this
 * comment, and pins that two punctuation-differing credential ids stay two ids.
 */
export function sourceGroupAnchorId(c: {
  provider: string;
  credentialId?: string | null;
  connectionId: string;
}): string {
  const key = sourceGroupKey(c);
  if (key.kind === "plaid") return "source-plaid";
  if (key.kind === "credential") return `source-cred-${idSafe(key.credentialId)}`;
  return `source-conn-${idSafe(key.connectionId)}`;
}

/** The href that lands on a connection's group — used by every surface that used to say `/sources`
 *  and mean "somewhere near this provider". */
export function sourceGroupHref(c: {
  provider: string;
  credentialId?: string | null;
  connectionId: string;
}): string {
  return `/sources#${sourceGroupAnchorId(c)}`;
}

/** Every connection under a set of groups, in group order — grouping is a partition of the served
 *  rows, so this is the same list the page was handed. It exists so the masthead's two numbers come
 *  from the ONE tally (`grain.sourceCounts`) over connector ROWS, exactly like the Gatehouse's: a
 *  second tally shaped to this page's groups is how "N providers · M connections" and "N sources
 *  connected" became two derivations that disagreed (#65, #91). */
export function connectorsOf(groups: ProviderGroup[]): ConnectorStatus[] {
  return groups.flatMap((g) => g.connectors);
}

// ─────────────────────────────────────────────────────────────────────────────
// Group-header health rollup — the dot colour + the right-hand meta.
// ─────────────────────────────────────────────────────────────────────────────

export type GroupHealth = "ok" | "partial" | "down";

/** ok = every connection healthy; down = every connection unhealthy (the whole credential is out —
 *  poppy, "you must fix"); partial = some but not all (marigold, "something needs you"). Read off the
 *  served freshness tone, never a timestamp. Matches FQ4-0: Microsoft (3/3 down → seal) vs Plaid
 *  (1/14 down → marigold). */
export function groupHealth(connectors: ConnectorStatus[]): GroupHealth {
  const displays = connectors.map((c) => freshnessDisplay(c));
  const unhealthy = displays.filter(isUnhealthy).length;
  if (unhealthy === 0) return "ok";
  if (unhealthy === displays.length) return "down";
  return "partial";
}

export function groupUnhealthyCount(connectors: ConnectorStatus[]): number {
  return connectors.map((c) => freshnessDisplay(c)).filter(isUnhealthy).length;
}

/** The Plaid group's read-only cadence (#88). The backend stores cadence per-row; the design shows
 *  one rule for all banks. Present it from the served per-bank values: uniform → "every {t}, all of
 *  them"; divergent → an honest "{k} cadences" rather than pretending one exists. */
export function plaidGroupCadence(connectors: ConnectorStatus[]): string {
  const intervals = new Set(
    connectors.map((c) => formatInterval(effectiveIntervalSec(c)) ?? "?"),
  );
  if (intervals.size === 1) {
    const only = [...intervals][0];
    return only === "?" ? "shared cadence" : `every ${only}, all of them`;
  }
  return `${intervals.size} cadences`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The exceptions-first masthead sentence (build-notes §14.4). It changes SHAPE when something is
// wrong — it does not append a warning to an unchanged sentence — and demotes the healthy summary to
// the last clause rather than deleting it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The masthead's numbers and its sentence.
 *
 * `sources` is the PROVIDER grain and carries the grain module's name, not this page's noun: the
 * count line prints it as "N providers" and the Gatehouse prints the same number as "N sources"
 * (grain.ts — one number, two nouns). Naming it twice in code is how it came to mean two things on
 * screen.
 */
export interface SourcesSummary extends GrainCounts {
  sectors: number;
  needsYou: number;
  sentence: string;
}

/** The whole masthead sub-sentence + the "N need you" tally. Pure, so the wording is tested. */
export function sourcesSummary(groups: ProviderGroup[]): SourcesSummary {
  const { sources, connections } = sourceCounts(connectorsOf(groups));
  const sectorSet = new Set<string>();
  for (const g of groups) for (const c of g.connectors) sectorSet.add(c.sector);
  const sectors = sectorSet.size;

  // Structural counts are SPELLED, per the design (`1KX-0`: "Twenty-four connections behind seven
  // providers, across six sectors"). This clause used to spell only to nine.
  const lead = `${cap(spelled(connections, "connection"))} behind ${spelled(sources, "provider")}, across ${spelled(sectors, "sector")}`;

  const affected = groups
    .map((g) => ({ g, health: groupHealth(g.connectors) }))
    .filter((x) => x.health !== "ok");
  const needsYou = affected.reduce((n, x) => n + groupUnhealthyCount(x.g.connectors), 0);

  if (affected.length === 0) {
    return {
      sources,
      connections,
      sectors,
      needsYou: 0,
      sentence: `${lead} — all flowing. One credential can feed several sectors; one app can feed several banks. Removing either takes everything under it.`,
    };
  }

  const clauses = affected.map(({ g, health }) => {
    const name = providerDisplay(g.provider);
    if (g.kind === "plaid") {
      const k = groupUnhealthyCount(g.connectors);
      return `${spelled(k, "Plaid bank is", "Plaid banks are")} due for re-approval`;
    }
    if (health === "down" && g.connectors.length > 1) {
      return `${name} needs you — ${spelled(g.connectors.length, "sector")} held at once`;
    }
    return `${name} needs you`;
  });

  const tally = `${cap(numberWord(needsYou))} ${needsYou === 1 ? "needs" : "need"} you`;
  return {
    sources,
    connections,
    sectors,
    needsYou,
    sentence: `${lead}. ${tally}: ${clauses.join(", and ")}. Everything else is flowing.`,
  };
}
