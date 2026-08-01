// Apple / iCloud COMPOSITE connector — ONE registry entry for provider "apple" that fans ONE
// credential (Apple ID + app-specific password) out to three read-only sectors: mail (IMAP),
// calendar (CalDAV), contacts (CardDAV). Spec docs/specs/icloud-connector.md, ADR 0030.
//
// WHY A COMPOSITE: the registry (src/sync/registry.ts) keys by PROVIDER, and all three iCloud
// connectors declare provider "apple" — registering them separately collides (last-registration-wins),
// so two of the three sectors would resolve to the wrong connector. This mirrors EXACTLY how the
// existing multi-sector providers register ONE connector that serves many sectors:
//   * microsoft.ts (mail+calendar+contacts) and google.ts (calendar+contacts) each register a SINGLE
//     Connector whose sync() branches on ctx.sector and whose normalize()/strongKeys() branch on
//     rec.object (ADR 0006). The scheduler/freshness/lifecycle resolve policy by PROVIDER (never by
//     sector), so a multi-sector provider exposes ONE static SyncPolicy.
// AppleConnector does the same by DELEGATING to the three sub-connectors (the children's classes are
// unchanged — no connector logic is duplicated here; this is pure composition/routing).

import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";
import { IcloudMailConnector } from "./icloud-mail.js";
import { IcloudCalendarConnector } from "./icloud-calendar.js";
import { IcloudContactsConnector } from "./icloud-contacts.js";

/** The three sub-connectors (injectable for tests; production defaults to the real classes). */
export interface AppleSubConnectors {
  mail?: Connector;
  calendar?: Connector;
  contacts?: Connector;
}

/**
 * The composite Apple connector: provider "apple", three sectors, one credential. sync() +
 * fetchRecordLive() route on the CONNECTION's sector (ctx.sector); normalize() + strongKeys() route on
 * the RECORD's object (rec.object). Read-only (actions: []) across all three sectors in V0.
 */
export class AppleConnector implements Connector {
  readonly provider = "apple";
  // Placeholders for the single-sector fields (the multi-sector model routes on ctx.sector / rec.object;
  // microsoft.ts/google.ts do the same). Mail is the default route.
  readonly sector = "mail";
  readonly objectType = "message";

  // ONE static policy — the microsoft/google multi-sector shape: the scheduler resolves policy by
  // PROVIDER, not sector, so a multi-sector provider must expose a single SyncPolicy. Conservative
  // poll: a 300s FLOOR (all three sub-connectors declared minIntervalSec 300, so the floor is exact)
  // and a 600s default (mail's authored cadence; calendar/contacts authored a 900s default — 600s is
  // still far above the floor, and cadence is per-connection overridable via ADR 0025). ctag-gating
  // (DAV) and QRESYNC (mail) keep an unchanged collection a single cheap probe per poll.
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 600,
    minIntervalSec: 300,
    freshnessToleranceSec: 600,
    supportsIncremental: true,
  };

  // Read-only across all three sectors (CalDAV/CardDAV writes + SMTP send are deferred follow-ons).
  readonly actions: ActionSpec[] = [];

  private readonly mail: Connector;
  private readonly calendar: Connector;
  private readonly contacts: Connector;

  constructor(subs: AppleSubConnectors = {}) {
    this.mail = subs.mail ?? new IcloudMailConnector();
    this.calendar = subs.calendar ?? new IcloudCalendarConnector();
    this.contacts = subs.contacts ?? new IcloudContactsConnector();
  }

  /** Route on the CONNECTION's sector (sync + fetchRecordLive). Mail is the default. */
  private forSector(sector: string | undefined): Connector {
    if (sector === "calendar") return this.calendar;
    if (sector === "contacts") return this.contacts;
    return this.mail;
  }

  /** Route on the RECORD's object (normalize + strongKeys). "message" (mail) is the default. */
  private forObject(object: string | undefined): Connector {
    if (object === "calendar_event") return this.calendar;
    if (object === "contact") return this.contacts;
    return this.mail;
  }

  /** Delegate the sync stream to the sub-connector for the connection's sector. */
  sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    return this.forSector(ctx.sector).sync(ctx);
  }

  /** Delegate normalization to the sub-connector for the record's object. */
  normalize(rec: RawRecord): unknown {
    return this.forObject(rec.object).normalize(rec);
  }

  /** Delegate strong-key extraction to the sub-connector for the record's object. */
  strongKeys(rec: RawRecord): Record<string, string> {
    return this.forObject(rec.object).strongKeys(rec);
  }

  /**
   * The fetch_live {id} drill, routed by the CONNECTION's sector. Only MAIL supports it (envelope
   * cache + on-demand body, ADR 0001); calendar/contacts are fully cached, so their sub-connector
   * declares no drill — a clean, secret-free "not supported" (the core wraps it as
   * FetchLiveUnavailable). Defined here because mail needs it and the interface method is per-connector.
   */
  async fetchRecordLive(ctx: SyncContext, sourceObjectId: string): Promise<unknown> {
    const sub = this.forSector(ctx.sector);
    if (typeof sub.fetchRecordLive !== "function") {
      throw new Error(`apple: live record fetch not supported for sector "${ctx.sector ?? "mail"}"`);
    }
    return sub.fetchRecordLive(ctx, sourceObjectId);
  }

  /** Read-only across all three sectors (no source-side actions in V0). */
  async execute(): Promise<ActionResult> {
    throw new Error(
      "AppleConnector has no actions (iCloud mail/calendar/contacts are read-only in V0)",
    );
  }
}
