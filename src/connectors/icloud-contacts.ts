// iCloud CardDAV contacts connector (read-only; provider "apple", sector "contacts"). Shares the
// Apple credential + dav-core with icloud-calendar + icloud-mail. Spec §Contacts, ADR 0030.
//
// SYNC (per address book, re-discovered every run — partition host never persisted): CardDAV
// sync-token is UNRELIABLE on iCloud, so this uses ctag+etag-diff (dav-core.runCtagEtagDiff):
//   1. Depth:0 getctag gate — an unchanged ctag ⇒ nothing to do.
//   2. Depth:1 getetag listing diffed against the stored etag map → changed/new hrefs + hrefs that
//      VANISHED from the listing (deletions — a set difference, not a 404-in-report).
//   3. multiget the changed vCards → parse with vcard4 (with a defensive fallback for iCloud's
//      vCard 3.0 VERSION quirk) → normalize.
// One CardDAV resource (one href) = one vCard = one contact (soid = UID), so href ↔ soid is 1:1 and
// the persisted etag map (href → {etag, soid}) is the cursor. Deletions yielded before upserts.
//
// SECURITY (S1): ctx.secret is the ASP, ctx.username the Apple ID — credentials, never logged; every
// failure is a clean `apple: …` message.

import { parse as parseVcard } from "vcard4";
import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";
import {
  runCtagEtagDiff,
  type DavCredential,
  type DavObject,
  type DavTransport,
  type DavTransportFactory,
  getDavTransportFactory,
} from "./dav-core.js";

// ── Normalized row (the REGISTRY `contacts` scalars minus `id`; never `raw`) ──────────
export interface ContactRow {
  source_object_id: string; // the vCard UID (or the href basename when UID is absent)
  display_name: string | null;
  given_name: string | null;
  family_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  company: string | null;
  job_title: string | null;
  updated_at: string | null; // REV
}

/** The `raw` payload: the projected fields + the raw vCard text (spec: store raw vCard in raw). */
interface AppleContactRaw extends ContactRow {
  uid: string;
  vcard: string;
}

/** Per-connection cursor (JSON): per-book ctag + the href → {etag, soid} map (the etag-diff cursor). */
interface ContactsCursor {
  books: Record<string, { ctag: string | null; hrefEtags: Record<string, { etag: string; soid: string }> }>;
}

// ── vCard field extraction (module-private, pure) ────────────────────────────────────

/** The minimal field set both the vcard4 path and the fallback path produce. */
interface VCardFields {
  uid: string | null;
  fn: string | null;
  given: string | null;
  family: string | null;
  email: string | null;
  tel: string | null;
  company: string | null;
  jobTitle: string | null;
  rev: string | null;
}

/**
 * Best-effort E.164 (mirrors microsoft.ts cleanPhone): strip formatting, keep a leading `+`, NO
 * country inference. Deterministic.
 */
function cleanPhone(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  return digits === "" ? null : `${plus}${digits}`;
}

function firstStr(v: unknown): string | null {
  if (typeof v === "string") return v === "" ? null : v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstStr(x);
      if (s != null) return s;
    }
  }
  return null;
}

/** iCloud sends vCard 3.0, which vcard4 (RFC 6350 / 4.0) rejects — bump the VERSION line to 4.0. */
function bumpVersion(body: string): string {
  if (/^VERSION:/im.test(body)) return body.replace(/^VERSION:[^\r\n]*/im, "VERSION:4.0");
  // No VERSION line — inject one right after BEGIN:VCARD (still lets vcard4 tokenize).
  return body.replace(/^(BEGIN:VCARD[^\r\n]*)/im, "$1\r\nVERSION:4.0");
}

/** Extract via vcard4 (the spec parser). Throws on a genuinely unparseable card → caller falls back. */
function extractViaVcard4(body: string): VCardFields {
  const parsedRaw = parseVcard(bumpVersion(body));
  const parsed = Array.isArray(parsedRaw) ? parsedRaw[0] : parsedRaw;
  const get = (name: string): { value: unknown; parameters: Record<string, string | string[]> }[] =>
    parsed.getProperty(name);

  const nVal = get("N")[0]?.value;
  let given: string | null = null;
  let family: string | null = null;
  if (nVal != null && typeof nVal === "object" && !Array.isArray(nVal)) {
    const n = nVal as Record<string, unknown>;
    family = firstStr(n.familyNames);
    given = firstStr(n.givenNames);
  } else if (typeof nVal === "string") {
    // "Family;Given;Additional;Prefix;Suffix"
    const parts = nVal.split(";");
    family = parts[0] ? parts[0] : null;
    given = parts[1] ? parts[1] : null;
  }

  const org = get("ORG")[0]?.value;
  return {
    uid: firstStr(get("UID")[0]?.value),
    fn: firstStr(get("FN")[0]?.value),
    given,
    family,
    email: firstStr(get("EMAIL")[0]?.value),
    tel: firstStr(get("TEL")[0]?.value),
    company: firstStr(org),
    jobTitle: firstStr(get("TITLE")[0]?.value),
    rev: firstStr(get("REV")[0]?.value),
  };
}

/** Minimal line-based fallback (RFC 6350 unfolding) for a card vcard4 can't tokenize. Never throws. */
function extractViaLines(body: string): VCardFields {
  // Unfold: a line beginning with a space/tab continues the previous logical line.
  const unfolded: string[] = [];
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += rawLine.slice(1);
    } else {
      unfolded.push(rawLine);
    }
  }
  const first: Record<string, string> = {};
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = left.split(";")[0].toUpperCase();
    if (!(name in first)) first[name] = value; // keep the FIRST occurrence
  }
  const n = (first.N ?? "").split(";");
  const org = (first.ORG ?? "").split(";")[0];
  return {
    uid: first.UID ? first.UID : null,
    fn: first.FN ? first.FN : null,
    given: n[1] ? n[1] : null,
    family: n[0] ? n[0] : null,
    email: first.EMAIL ? first.EMAIL : null,
    tel: first.TEL ? first.TEL : null,
    company: org ? org : null,
    jobTitle: first.TITLE ? first.TITLE : null,
    rev: first.REV ? first.REV : null,
  };
}

function revToIso(rev: string | null): string | null {
  if (rev == null) return null;
  const t = Date.parse(rev);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** display_name = FN, falling back to "given family" then ORG when FN is empty (iCloud quirk). */
function displayNameOf(f: VCardFields): string | null {
  if (f.fn != null && f.fn.trim() !== "") return f.fn;
  const joined = [f.given, f.family].filter((x) => x != null && x !== "").join(" ").trim();
  if (joined !== "") return joined;
  return f.company != null && f.company !== "" ? f.company : null;
}

/**
 * Parse ONE vCard resource into a normalized contact `raw` payload. `hrefBasename` seeds the
 * source_object_id when the card has no UID (defensive — iCloud cards always carry one). Pure +
 * defensive: returns null only when there is no usable id at all. Exported for unit tests.
 */
export function parseVCard(body: string, hrefBasename: string): AppleContactRaw | null {
  let fields: VCardFields;
  try {
    fields = extractViaVcard4(body);
  } catch {
    fields = extractViaLines(body);
  }
  // A totally empty parse (e.g. vcard4 succeeded but returned nothing usable) → fallback for the id.
  const uid = fields.uid ?? (hrefBasename !== "" ? hrefBasename : null);
  if (uid == null || uid === "") return null;

  return {
    source_object_id: uid,
    uid,
    display_name: displayNameOf(fields),
    given_name: fields.given ?? null,
    family_name: fields.family ?? null,
    primary_email: fields.email ?? null,
    primary_phone: cleanPhone(fields.tel),
    company: fields.company ?? null,
    job_title: fields.jobTitle ?? null,
    updated_at: revToIso(fields.rev),
    vcard: body,
  };
}

/** The last path segment of an href (the CardDAV resource name), used as a UID fallback. */
function hrefBasename(href: string): string {
  const clean = href.replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  return base.replace(/\.vcf$/i, "");
}

// ── Cursor (de)serialization ─────────────────────────────────────────────────────────

function parseCursor(cursor: string | undefined): ContactsCursor {
  const empty: ContactsCursor = { books: {} };
  if (!cursor) return empty;
  try {
    const parsed: unknown = JSON.parse(cursor);
    const books = (parsed as { books?: unknown } | null)?.books;
    if (books != null && typeof books === "object" && !Array.isArray(books)) {
      const out: ContactsCursor = { books: {} };
      for (const [url, v] of Object.entries(books as Record<string, unknown>)) {
        if (v == null || typeof v !== "object") continue;
        const o = v as Record<string, unknown>;
        out.books[url] = {
          ctag: typeof o.ctag === "string" ? o.ctag : null,
          hrefEtags:
            o.hrefEtags != null && typeof o.hrefEtags === "object" && !Array.isArray(o.hrefEtags)
              ? sanitizeHrefEtags(o.hrefEtags as Record<string, unknown>)
              : {},
        };
      }
      return out;
    }
  } catch {
    // garbled cursor → fresh full sync
  }
  return empty;
}

function sanitizeHrefEtags(m: Record<string, unknown>): Record<string, { etag: string; soid: string }> {
  const out: Record<string, { etag: string; soid: string }> = {};
  for (const [href, v] of Object.entries(m)) {
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.etag === "string" && typeof o.soid === "string") {
        out[href] = { etag: o.etag, soid: o.soid };
      }
    }
  }
  return out;
}

// ── Connector ────────────────────────────────────────────────────────────────────────

export class IcloudContactsConnector implements Connector<ContactRow> {
  readonly provider = "apple";
  readonly sector = "contacts";
  readonly objectType = "contact";

  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 900,
    // Floor 300s (spec D5): conservative, ctag-gated so an unchanged book costs one Depth:0 PROPFIND.
    minIntervalSec: 300,
    freshnessToleranceSec: 900,
    supportsIncremental: true,
  };

  readonly actions: ActionSpec[] = [];

  private readonly factoryOverride: DavTransportFactory | null;

  constructor(factory?: DavTransportFactory) {
    this.factoryOverride = factory ?? null;
  }

  private transport(cred: DavCredential): DavTransport {
    return (this.factoryOverride ?? getDavTransportFactory())(cred);
  }

  /**
   * Per address book (re-discovered every run): ctag gate → etag-diff → multiget changed vCards.
   * Deletions (vanished hrefs) are yielded BEFORE upserts; the final cursor rides the LAST record.
   */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    const username = ctx.username;
    const appPassword = ctx.secret;
    if (!username || !appPassword) throw new Error("apple: missing app-specific password or Apple ID");
    const cred: DavCredential = { username, appPassword };

    const transport = this.transport(cred);
    const prior = parseCursor(ctx.cursor);
    const nextCursor: ContactsCursor = { books: {} };

    const books = await transport.discover("carddav");
    const deletions: RawRecord[] = [];
    const upserts: RawRecord[] = [];

    for (const book of books) {
      const stored = prior.books[book.url] ?? { ctag: null, hrefEtags: {} };
      const hrefEtags: Record<string, { etag: string; soid: string }> = { ...stored.hrefEtags };

      // ctag gate (Depth:0).
      let liveCtag: string | null = null;
      try {
        liveCtag = await transport.fetchCtag(book.url);
      } catch {
        liveCtag = null;
      }
      if (stored.ctag != null && liveCtag != null && liveCtag === stored.ctag) {
        nextCursor.books[book.url] = { ctag: stored.ctag, hrefEtags };
        continue;
      }

      const priorEtags: Record<string, string> = {};
      for (const [href, e] of Object.entries(stored.hrefEtags)) priorEtags[href] = e.etag;

      const diff = await runCtagEtagDiff(transport, book.url, priorEtags, liveCtag ?? undefined);

      // Vanished hrefs → tombstone their stored soids.
      for (const href of diff.removedHrefs) {
        const soid = stored.hrefEtags[href]?.soid;
        if (soid != null) deletions.push({ object: "contact", deleted: true, externalId: soid, raw: null });
        delete hrefEtags[href];
      }

      // Changed/new hrefs → multiget + parse.
      if (diff.changed.length > 0) {
        const objs = (await transport.multiget("carddav", book.url, diff.changed)) as DavObject[];
        const byHref = new Map<string, DavObject>();
        for (const o of objs) byHref.set(o.href, o);
        for (const href of diff.changed) {
          const obj = byHref.get(href);
          if (obj == null) continue; // multiget didn't return it — leave the stored etag so we retry
          const raw = parseVCard(obj.body, hrefBasename(href));
          if (raw == null) continue; // unusable card — skip (etag not advanced → retried next run)
          upserts.push({ object: "contact", externalId: raw.source_object_id, raw });
          hrefEtags[href] = { etag: obj.etag, soid: raw.source_object_id };
        }
      }

      nextCursor.books[book.url] = { ctag: diff.ctag || liveCtag, hrefEtags };
    }

    const cursorStr = JSON.stringify(nextCursor);
    const ordered = [...deletions, ...upserts];
    for (let i = 0; i < ordered.length; i++) {
      if (i === ordered.length - 1) ordered[i].cursor = cursorStr;
      yield ordered[i];
    }
  }

  /** Map the parsed contact raw payload → the REGISTRY `contacts` scalars (never `id`/`raw`). */
  normalize(rec: RawRecord): ContactRow {
    const r = rec.raw as AppleContactRaw;
    return {
      source_object_id: r.source_object_id,
      display_name: r.display_name ?? null,
      given_name: r.given_name ?? null,
      family_name: r.family_name ?? null,
      primary_email: r.primary_email ?? null,
      primary_phone: r.primary_phone ?? null,
      company: r.company ?? null,
      job_title: r.job_title ?? null,
      updated_at: r.updated_at ?? null,
    };
  }

  /** Deterministic strong keys: { ical_uid: the vCard UID }. */
  strongKeys(rec: RawRecord): Record<string, string> {
    const r = rec.raw as AppleContactRaw | undefined;
    const uid = r?.uid;
    return uid != null && uid !== "" ? { ical_uid: String(uid) } : {};
  }

  /** Read-only (ADR 0030): CardDAV writes are a deferred follow-on. */
  async execute(): Promise<ActionResult> {
    throw new Error("IcloudContactsConnector has no actions (contacts is read-only in V0)");
  }
}
