// Fixtures for the iCloud CardDAV contacts connector: real vCard 3.0 bodies (what iCloud actually
// serves) + a fake DavTransport (no real iCloud in tests).

import type {
  DavCollection,
  DavEtag,
  DavKind,
  DavObject,
  DavTransport,
  DavTransportFactory,
} from "./dav-core.js";

const CRLF = "\r\n";
export function vcf(lines: string[]): string {
  return lines.join(CRLF);
}

/** A complete iCloud-style vCard 3.0 with FN, N, EMAIL, TEL, ORG, TITLE, UID, REV. */
export function fullVcard(uid: string): string {
  return vcf([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//Apple Inc.//iCloud//EN",
    `UID:${uid}`,
    "N:Public;Jane;Q;;",
    "FN:Jane Q Public",
    "ORG:Acme;Widgets",
    "TITLE:Engineer",
    "EMAIL;type=INTERNET;type=WORK;type=pref:jane@example.com",
    "EMAIL;type=INTERNET;type=HOME:jane.home@example.com",
    "TEL;type=CELL;type=VOICE;type=pref:+1 (415) 555-0101",
    "item1.ADR;type=HOME;type=pref:;;123 St;Town;CA;94000;USA",
    "REV:2026-01-02T03:04:05Z",
    "END:VCARD",
  ]);
}

/** A vCard whose FN is EMPTY — display_name must fall back to N (then ORG). iCloud quirk. */
export function fnEmptyVcard(uid: string): string {
  return vcf([
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${uid}`,
    "N:Solo;;;;",
    "FN:",
    "ORG:OnlyOrg Inc.;",
    "EMAIL:solo@example.com",
    "REV:2026-02-02T00:00:00Z",
    "END:VCARD",
  ]);
}

/** A company-only card (no FN, no N) — display_name falls back to ORG. */
export function orgOnlyVcard(uid: string): string {
  return vcf(["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, "ORG:Globex Corporation;", "END:VCARD"]);
}

// ── The fake transport ────────────────────────────────────────────────────────────────

export const CARD_BOOK: DavCollection = {
  url: "https://p11-contacts.icloud.com/1234/carddavhome/card/",
  displayName: "Contacts",
  ctag: "cc-0",
  syncToken: null,
};

export interface CardRound {
  ctag: string;
  /** The Depth:1 getetag listing for this round. */
  etags: DavEtag[];
  /** href → raw vCard body, for multiget. */
  bodies: Record<string, string>;
}

/** A per-book scripted CardDAV transport. discover() advances one round; each round drives one sync(). */
export class FakeCardTransport implements DavTransport {
  private round = -1;
  constructor(
    private readonly books: DavCollection[],
    private readonly rounds: Array<Record<string, CardRound>>,
  ) {}

  async discover(): Promise<DavCollection[]> {
    this.round++;
    return this.books;
  }
  private cur(url: string): CardRound | undefined {
    return this.rounds[this.round]?.[url];
  }
  async fetchCtag(url: string): Promise<string | null> {
    return this.cur(url)?.ctag ?? null;
  }
  async listEtags(url: string): Promise<DavEtag[]> {
    return this.cur(url)?.etags ?? [];
  }
  async multiget(_kind: DavKind, url: string, hrefs: string[]): Promise<DavObject[]> {
    const r = this.cur(url);
    if (!r) return [];
    const etagByHref = new Map(r.etags.map((e) => [e.href, e.etag]));
    const out: DavObject[] = [];
    for (const h of hrefs) {
      const body = r.bodies[h];
      if (body != null) out.push({ href: h, etag: etagByHref.get(h) ?? "", body });
    }
    return out;
  }
  async syncCollection(): Promise<{ changed: DavObject[]; deletions: string[]; nextToken: string }> {
    return { changed: [], deletions: [], nextToken: "" };
  }
  async healthProbe(): Promise<{ ok: boolean; status: number }> {
    return { ok: true, status: 207 };
  }
}

export function makeFakeCardFactory(
  books: DavCollection[],
  rounds: Array<Record<string, CardRound>>,
): { factory: DavTransportFactory; transport: FakeCardTransport } {
  const transport = new FakeCardTransport(books, rounds);
  return { factory: () => transport, transport };
}
