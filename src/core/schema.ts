export type FieldType = "text" | "numeric" | "bool" | "timestamptz" | "uuid";

/**
 * Row uuids — the ONE regex. Lives here (not in an adapter or a private const) because `"uuid"` is a
 * declared FieldType now: the value guard in query.ts and the id guards in context.ts must agree
 * byte-for-byte on what a row uuid is. Anchored on both ends — an unanchored copy would let
 * `"' or 1=1 -- 00000000-0000-0000-0000-000000000000"` through to Postgres.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The finance-dedup engine's RESERVED `source_object_id` namespace (#37, ADR 0021): a synthetic
 * merge winner's soid is `union:<...>`, and the ingest write path REFUSES any provider record that
 * plants or tombstones one (`src/sync/runner.ts` — applyRecords + the snapshot sweep's
 * `not like 'union:%'`).
 *
 * That refusal is exactly WHY the read path reads merged-ness off this prefix and NOT off the
 * `dedup_status` column: `dedup_status` IS a REGISTRY field, so it is inside the ingest write
 * allow-list and a connector could set `'winner'` on its own row — which under a dedup_status-based
 * rule would make that row report "merged, no single source" and ERASE its own provenance. The soid
 * namespace is the one marker a provider cannot forge.
 *
 * Exact-case, matching the write refusal and the sweep literal; a case variant has no forgery value
 * because nothing else in the engine recognises it.
 */
export const UNION_SOID_PREFIX = "union:";

export interface SectorSchema {
  /** The REGISTRY object name (e.g. "transaction"). */
  object: string;
  /** The backing table. */
  table: string;
  /**
   * The flat, queryable columns and their types. jsonb/array/scoping columns are intentionally absent.
   *
   * UNCHANGED in role: this map is BOTH the filter/sort/aggregate vocabulary AND the ingest write
   * allow-list (src/sync/runner.ts reads Object.keys(fields)). Nothing added by this unit is ever
   * read as a substitute for it — `fieldDocs` is a SEPARATE map precisely so no validator can widen
   * the allow-list by falling back to it.
   */
  fields: Record<string, FieldType>;
  /**
   * AUTHORED, STATIC per-field semantics, published by get_schema. Never derived, never generated,
   * never user data. Keys MUST be a subset of `fields` (pinned by schema.test.ts) — a key here does
   * NOT make a column queryable, and no validator ever reads this map.
   *
   * They exist because the traps that produce a WRONG ANSWER (the signed-amount rule, the two
   * unrelated meanings of "pending", per-row units on a tall metric table) live in db/schema.sql and
   * the connectors — three places an agent can never see. Universal conventions (id is a row uuid,
   * timestamps are ISO-8601 UTC, …) are NOT repeated here: they live once in the get_schema tool
   * description, where they cost zero response tokens.
   */
  fieldDocs?: Record<string, string>;
  /** One authored line of object-level semantics: what a row IS, and the trap to avoid. */
  notes?: string;
  /** Default sort/range column; also the column the generic hot-read index is built on. */
  primaryTime?: string;
  /**
   * The table's jsonb columns — PROJECTABLE via query()'s `select` (for one-call find-then-detail),
   * but NOT filterable/sortable/aggregatable: `where`/`orderBy`/`groupBy`/`aggregate` stay validated
   * against `fields` only. `raw` is present on every sector; `attendees` (calendar) / `attributes`
   * (home) are the only extra jsonb columns. REGISTRY-declared identifiers — never agent input — so a
   * projected name is a quoted column, never interpolated (the SQL-safety invariant holds). Omitted on
   * the default `select`, so payloads stay lean unless the agent opts in (selecting raw forces a TOAST
   * fetch+decompress per row — meant for narrow find-then-detail, never the default).
   */
  jsonb?: readonly string[];
  /**
   * Cross-provider dedup (#34b, ADR 0021): when true, query() appends ONE `shadowed_by_id is null`
   * predicate (rows AND aggregate) so it serves the synthetic winner + a single-provider unique row and
   * HIDES the shadowed reals. Folded into the recreated partial primary-time indexes (migration 0009).
   * Undefined elsewhere ⇒ NO clause emitted, so a non-dedup sector never references the column (the
   * byte-for-byte-unchanged guarantee). Set only on the finance objects.
   */
  serveDeduped?: boolean;
}

/**
 * The published, queryable surface — schema-as-contract. `query()` validates every field
 * against this registry, so an agent can only reach declared columns of declared tables.
 *
 * `fields` holds only flat scalar columns — the filter/sort/aggregate surface. jsonb columns
 * (raw, attributes, attendees) live in `jsonb`: PROJECTABLE via `select` (one-call find-then-detail)
 * but NOT filterable/sortable/aggregatable. Array columns (mail labels — queryable once query()
 * supports array containment) and scoping/audit columns (connection_id, user_id, ingested_at) are
 * deliberately absent: arrays are not yet queryable, and scoping is applied by core, never the agent.
 *
 * `connection_id` STAYS ABSENT even though the read path now serves per-row provenance from it
 * (#65/#122): `fields` is ALSO the ingest write allow-list, so declaring it here would let a
 * provider record claim which connection its row belongs to — write-side authority the gateway keeps
 * for itself. query() projects the column READ-ONLY under an internal alias instead (see
 * `includeProvenance` in query.ts). Serving a column and accepting it are different powers.
 *
 * Multi-object sectors (finance, health) use dotted "sector.object" keys; single-object
 * sectors use the bare sector name. getSchema() prefix-matches so get_schema("finance")
 * returns both finance objects.
 */
export const REGISTRY: Record<string, SectorSchema> = {
  // ── FINANCE (Plaid + SimpleFIN) ──
  "finance.account": {
    object: "account",
    table: "finance_accounts",
    primaryTime: "balance_at",
    notes:
      "One bank/brokerage account and its latest balances. Cross-provider duplicates are merged: you normally see ONE row per real account (the synthetic winner), never both providers' copies.",
    fieldDocs: {
      current_balance:
        "Signed. A liability OWED is NEGATIVE everywhere (a credit card with 500 owed reads -500); assets are positive. Provider-agnostic — Plaid's positive-magnitude liabilities are negated on write.",
      available_balance:
        "Passed through EXACTLY as the provider reports it — the signed-liability rule above does NOT apply here. Plaid available-credit stays positive.",
      balance_at_is_synthetic:
        "true = we stamped balance_at at ingest because the provider reported no balance date (Plaid). Do not read it as 'the balance changed then'.",
      mask: "Last 4 of the account number, when the provider gives one. Also part of the cross-provider dedup key.",
      org_domain:
        "The institution's registrable domain, part of the cross-provider dedup key. Not a display name — use institution_name for that.",
      dedup_status:
        "Cross-provider dedup marker, NOT an account state: 'winner' (a merged row standing for two providers' copies), 'unique' (seen at one provider), 'ambiguous' (could not be matched safely), null (dedup has not run). 'shadow' rows are hidden unless you pass includeShadowed.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      name: "text",
      account_type: "text",
      currency: "text",
      current_balance: "numeric",
      available_balance: "numeric",
      balance_at: "timestamptz",
      balance_at_is_synthetic: "bool",
      institution_name: "text",
      // #34b dedup surface: mask + org_domain are the account dedup key; dedup_status is the queryable
      // marker ('winner'/'unique'/'ambiguous'; 'shadow' is drill-only — hidden by the serveDeduped
      // predicate). shadowed_by_id / dedup_group_id stay OUT of the REGISTRY (core-applied, like deleted_at).
      mask: "text",
      org_domain: "text",
      dedup_status: "text",
    },
    jsonb: ["raw"],
    serveDeduped: true,
  },
  "finance.transaction": {
    object: "transaction",
    table: "finance_transactions",
    primaryTime: "posted_at",
    notes:
      "One posted or pending transaction. amount is SIGNED. To total SPENDING, filter amount < 0 and negate the sum (or use min/abs on the agent side); a plain sum(amount) nets income against spending and is the single most common wrong answer here.",
    fieldDocs: {
      amount:
        "SIGNED: NEGATIVE = money leaving the account (spending), positive = money in (income, refunds, transfers in). Provider-agnostic — Plaid's positive-is-out convention is negated on write, so the raw payload carries the OPPOSITE sign to this column.",
      pending:
        "The BANK's settlement flag — the charge has not posted yet. Nothing to do with dedup_status 'pending'.",
      dedup_status:
        "Cross-provider dedup marker, NOT a settlement state: 'winner' | 'pending' (dedup has not decided yet) | 'ambiguous' | null. Its 'pending' is unrelated to the pending column. 'shadow' rows are hidden unless you pass includeShadowed.",
      account_source_id:
        "The parent account's source_object_id WITHIN THE SAME connection — join to finance.account.source_object_id, not to its id, and never across connections.",
      category:
        "Plaid's taxonomy when the provider supplies one; null for SimpleFIN rows. Absence means 'not categorised', never 'uncategorised spending'.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      account_source_id: "text",
      posted_at: "timestamptz",
      amount: "numeric",
      currency: "text",
      description: "text",
      merchant: "text",
      pending: "bool",
      category: "text",
      payment_channel: "text",
      authorized_at: "timestamptz",
      location_city: "text",
      location_region: "text",
      // #34b: queryable dedup marker ('winner'/'pending'/'ambiguous'; 'shadow' is drill-only).
      dedup_status: "text",
    },
    jsonb: ["raw"],
    serveDeduped: true,
  },
  "finance.holding": {
    object: "holding",
    table: "finance_holdings",
    primaryTime: "as_of",
    notes:
      "A SNAPSHOT of current positions — every sync replaces them. There is no position history here.",
    fieldDocs: {
      market_value:
        "Current value of the position as the provider reports it. Unit price is not stored: derive market_value / quantity.",
      cost_basis: "As reported, faithfully — SimpleFIN often sends 0.00 meaning 'unknown', not 'free'.",
      security_type: "Plaid's security classification; null for SimpleFIN rows (infer from symbol/name).",
      dedup_status:
        "Cross-provider dedup marker (see finance.account). 'shadow' rows are hidden unless you pass includeShadowed.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      account_source_id: "text", // links to finance_accounts.source_object_id within the same connection
      symbol: "text", // SimpleFIN symbol / Plaid securities.ticker_symbol; null for cash rows
      name: "text", // SimpleFIN description / Plaid securities.name
      security_type: "text", // ENRICHMENT: Plaid securities.type (cash|cryptocurrency|derivative|equity|etf|fixed income|loan|mutual fund|other); SimpleFIN null — agent infers
      quantity: "numeric", // SimpleFIN shares / Plaid quantity
      market_value: "numeric", // SimpleFIN market_value / Plaid institution_value
      cost_basis: "numeric", // both, as reported (SimpleFIN junk "0.00" stored faithfully)
      currency: "text", // nullable (SimpleFIN CASH rows are empty → null)
      as_of: "timestamptz", // SimpleFIN created (epoch) / Plaid institution_price_as_of|datetime, else sync time
      dedup_status: "text", // 'winner' | 'unique' | 'ambiguous' ('shadow' hidden by serveDeduped, drill-only)
    },
    jsonb: ["raw"],
    serveDeduped: true,
  },

  // ── HEALTH (Whoop + Apple Health) ──
  "health.sample": {
    object: "health_sample",
    table: "health_samples",
    primaryTime: "window_start",
    notes:
      "A tall metric table: one row per measurement. Filter metric_type FIRST — values of different metrics are not comparable and must never be aggregated together.",
    fieldDocs: {
      metric_type:
        "Neutral vocabulary: heart_rate | resting_heart_rate | hrv_rmssd | hrv_sdnn | step_count | active_energy_burned | respiratory_rate | spo2 | skin_temperature | body_temperature | day_strain | recovery_score | sleep_performance.",
      aggregation:
        "'sample' (a point/interval reading) or 'daily_total' (already summed by the source). NEVER sum across both — you would double-count the day.",
      unit: "The unit for THIS row's value (count/min, kcal, ms, %, Cel, …). Always read it before comparing values.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      metric_type: "text",
      value: "numeric",
      unit: "text",
      aggregation: "text",
      window_start: "timestamptz",
      window_end: "timestamptz",
      source: "text",
    },
    jsonb: ["raw"],
  },
  "health.workout": {
    object: "workout",
    table: "health_workouts",
    primaryTime: "started_at",
    notes: "One completed workout. Whoop supplies heart-rate and strain; Apple Health leaves them null.",
    fieldDocs: {
      strain: "Whoop's 0-21 strain scale, Whoop rows only. Not a percentage.",
      energy_kcal: "Kilocalories. Whoop reports kilojoules natively; converted on write.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      sport: "text",
      started_at: "timestamptz",
      ended_at: "timestamptz",
      duration_seconds: "numeric",
      energy_kcal: "numeric",
      distance_meters: "numeric",
      avg_heart_rate: "numeric",
      max_heart_rate: "numeric",
      strain: "numeric",
    },
    jsonb: ["raw"],
  },
  "health.sleep_session": {
    object: "sleep_session",
    table: "health_sleep_sessions",
    primaryTime: "started_at",
    notes: "One sleep or nap session. Per-stage detail stays in raw.",
    fieldDocs: {
      is_nap: "true = the source classified this as a nap, not a main sleep.",
      efficiency_pct: "Percent (0-100), not a fraction.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      started_at: "timestamptz",
      ended_at: "timestamptz",
      is_nap: "bool",
      time_asleep_seconds: "numeric",
      time_in_bed_seconds: "numeric",
      efficiency_pct: "numeric",
      respiratory_rate: "numeric",
    },
    jsonb: ["raw"],
  },

  // ── MAIL (Gmail + Microsoft Graph) ──
  mail: {
    object: "message",
    table: "mail_messages",
    primaryTime: "received_at",
    notes:
      "Message ENVELOPES only. Bodies and attachments are never cached (ADR 0001) — use fetch_live with the row id to read one.",
    fieldDocs: {
      snippet: "A short preview the provider supplies. Not the body, and not searchable as one.",
      folder: "Neutral enum: inbox | sent | drafts | spam | trash | archive | other — normalized across providers.",
      importance: "Outlook only; null for Gmail rows.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      thread_id: "text",
      message_id_header: "text",
      from_address: "text",
      from_name: "text",
      sender_address: "text",
      subject: "text",
      snippet: "text",
      sent_at: "timestamptz",
      received_at: "timestamptz",
      is_read: "bool",
      has_attachments: "bool",
      folder: "text",
      importance: "text",
      // labels: text[] in the store; queryable once query() supports array containment.
    },
    jsonb: ["raw"],
  },

  // ── CONTACTS (Google People + Microsoft Graph) ──
  contacts: {
    object: "contact",
    table: "contacts",
    primaryTime: "updated_at",
    notes:
      "One address-book entry per source. The same person from two providers appears twice — there is no cross-provider contact merge.",
    fieldDocs: {
      primary_phone: "Normalized to E.164 by the connector when it could be parsed; otherwise as given.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      display_name: "text",
      given_name: "text",
      family_name: "text",
      primary_email: "text",
      primary_phone: "text",
      company: "text",
      job_title: "text",
      updated_at: "timestamptz",
    },
    jsonb: ["raw"],
  },

  // ── CALENDAR (Google Calendar + Microsoft Graph) ──
  calendar: {
    object: "calendar_event",
    table: "calendar_events",
    primaryTime: "starts_at",
    notes:
      "Event OCCURRENCES, not recurrence rules: a weekly meeting appears as one row per instance.",
    fieldDocs: {
      ends_at: "For an all-day event this is EXCLUSIVE (a one-day event ends on the next day).",
      all_day: "true = a date-only event; starts_at/ends_at are midnight boundaries, not real times.",
      start_tz:
        "IANA zone of the original local time. starts_at is UTC — use start_tz to say what the user's clock read.",
      owner_response:
        "The calendar OWNER's own RSVP, not the organizer's. Other attendees' responses live in the attendees jsonb.",
      recurrence_master_id: "The series this occurrence belongs to; null for one-off events.",
      status: "confirmed | tentative | cancelled. A cancelled occurrence is still a row.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      summary: "text",
      description: "text",
      location: "text",
      starts_at: "timestamptz",
      ends_at: "timestamptz",
      start_tz: "text",
      all_day: "bool",
      status: "text",
      organizer_email: "text",
      owner_response: "text",
      is_recurring: "bool",
      recurrence_master_id: "text",
      original_start: "timestamptz",
      original_start_tz: "text",
      html_link: "text",
      updated_at: "timestamptz",
    },
    jsonb: ["attendees", "raw"],
  },

  // ── HOME (Home Assistant; SmartThings/Matter reserved) ──
  home: {
    object: "home_entity",
    table: "home_entities",
    primaryTime: "state_timestamp",
    notes:
      "The last known state of each device/entity, from the cache. A push connection with freshness state 'ok' is live; otherwise call fetch_live before acting on a state.",
    fieldDocs: {
      state:
        "The source's state as a STRING whatever its nature ('on', 'off', '23.5', 'unavailable'). Compare as text; parse numbers on your side.",
      domain:
        "The entity-class prefix of entity_id (light, lock, climate, sensor, …). The cheapest filter for both query and list_actions.",
      availability:
        "online | offline | unavailable | unknown — whether the DEVICE is reachable, independent of the state column.",
      unit: "The unit of measurement for a numeric state, promoted out of the attributes bag; null for non-numeric entities.",
    },
    fields: {
      id: "uuid",
      source_object_id: "text",
      entity_id: "text",
      domain: "text",
      area: "text",
      state: "text",
      unit: "text",
      availability: "text",
      state_timestamp: "timestamptz",
    },
    jsonb: ["attributes", "raw"],
  },
};

/**
 * Resolve schema(s) by key. An exact key ("finance.transaction") returns that object; a
 * sector prefix ("finance") returns every object in the sector; no argument returns all.
 */
export function getSchema(sector?: string): Record<string, SectorSchema> {
  if (!sector) return REGISTRY;
  if (REGISTRY[sector]) return { [sector]: REGISTRY[sector] };

  const prefix = `${sector}.`;
  const matches = Object.entries(REGISTRY).filter(([key]) => key.startsWith(prefix));
  if (matches.length === 0) throw new Error(`unknown sector: ${sector}`);
  return Object.fromEntries(matches);
}

/**
 * The REGISTRY keys under a bare sector name — the raw material for a TEACHING error instead of a
 * flat "unknown sector". An exact key returns itself (["mail"]); a bare multi-object sector returns
 * its objects (["finance.account", "finance.transaction", "finance.holding"]); an unknown name
 * returns []. Insertion-ordered, so the messages agents read are stable.
 *
 * hasOwn-guarded like every other REGISTRY read: an unguarded truthy lookup would resolve prototype
 * members ("constructor", "toString", …) and report them as known sectors.
 */
export function objectKeysFor(sector: string): string[] {
  if (Object.hasOwn(REGISTRY, sector)) return [sector];
  const prefix = `${sector}.`;
  return Object.keys(REGISTRY).filter((k) => k.startsWith(prefix));
}

/** A domain table resolved from the REGISTRY — its key, backing table, bare sector, and primaryTime. */
export interface DomainTableRef {
  /** The REGISTRY key (e.g. "finance.transaction" or "mail"). */
  key: string;
  /** The backing table. */
  table: string;
  /** The bare sector — the part before the dot for dotted keys ("finance" for "finance.transaction"), else the key itself ("mail"). */
  sector: string;
  /** Default sort/range column, if declared. */
  primaryTime?: string;
}

/** The bare sector for a REGISTRY key ("finance.transaction" → "finance"; "mail" → "mail"). */
function sectorOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * Every REGISTRY object as a {key, table, sector, primaryTime}. The canonical way to enumerate
 * all domain tables (e.g. export/erase iterate this — never a hard-coded table list).
 */
export function allDomainTables(): DomainTableRef[] {
  return Object.entries(REGISTRY).map(([key, s]) => ({
    key,
    table: s.table,
    sector: sectorOf(key),
    primaryTime: s.primaryTime,
  }));
}

/**
 * The domain tables belonging to a sector (prefix-match — "finance" → both finance objects;
 * "mail" → the one mail object). Throws on an unknown sector (mirrors getSchema()).
 */
export function tablesForSector(sector: string): DomainTableRef[] {
  const matches = allDomainTables().filter((t) => t.sector === sector);
  if (matches.length === 0) throw new Error(`unknown sector: ${sector}`);
  return matches;
}
