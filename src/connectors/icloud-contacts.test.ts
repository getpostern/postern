// Unit tests for the iCloud CardDAV contacts connector — pure vCard parsing + fake-transport sync.

import { describe, it, expect } from "vitest";
import type { RawRecord, SyncContext } from "./types.js";
import { IcloudContactsConnector, parseVCard, type ContactRow } from "./icloud-contacts.js";
import {
  CARD_BOOK,
  fullVcard,
  fnEmptyVcard,
  orgOnlyVcard,
  makeFakeCardFactory,
} from "./icloud-contacts.fixtures.js";
import type { DavEtag } from "./dav-core.js";

function ctx(cursor?: string): SyncContext {
  return {
    userId: "u1",
    connectionId: "c1",
    secretRef: "ref",
    secret: "app-specific-password",
    username: "me@icloud.com",
    sector: "contacts",
    cursor,
  };
}

async function drain(it: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("parseVCard (vcard4 primary, iCloud 3.0)", () => {
  it("parses a full vCard 3.0 into the contacts row shape", () => {
    const raw = parseVCard(fullVcard("UID-1"), "uid-1");
    expect(raw).not.toBeNull();
    expect(raw!.source_object_id).toBe("UID-1");
    expect(raw!.uid).toBe("UID-1");
    expect(raw!.display_name).toBe("Jane Q Public");
    expect(raw!.given_name).toBe("Jane");
    expect(raw!.family_name).toBe("Public");
    expect(raw!.primary_email).toBe("jane@example.com"); // FIRST email
    expect(raw!.primary_phone).toBe("+14155550101"); // cleanPhone
    expect(raw!.company).toBe("Acme"); // ORG first component
    expect(raw!.job_title).toBe("Engineer");
    expect(raw!.updated_at).toBe("2026-01-02T03:04:05.000Z");
    expect(raw!.vcard).toContain("BEGIN:VCARD");
  });

  it("falls back FN→N when FN is empty (iCloud quirk)", () => {
    const raw = parseVCard(fnEmptyVcard("UID-2"), "uid-2");
    expect(raw!.display_name).toBe("Solo"); // from N family name
    expect(raw!.primary_email).toBe("solo@example.com");
  });

  it("falls back FN→ORG when neither FN nor N is present", () => {
    const raw = parseVCard(orgOnlyVcard("UID-3"), "uid-3");
    expect(raw!.display_name).toBe("Globex Corporation");
    expect(raw!.company).toBe("Globex Corporation");
  });

  it("uses the href basename as the id when the card has no UID", () => {
    const noUid = ["BEGIN:VCARD", "VERSION:3.0", "FN:No Id", "END:VCARD"].join("\r\n");
    const raw = parseVCard(noUid, "fallback-basename");
    expect(raw!.source_object_id).toBe("fallback-basename");
  });

  it("returns null when there is no usable id at all", () => {
    const noUid = ["BEGIN:VCARD", "VERSION:3.0", "FN:No Id", "END:VCARD"].join("\r\n");
    expect(parseVCard(noUid, "")).toBeNull();
  });

  it("recovers a garbled card via the line-based fallback (never throws)", () => {
    // A body that trips vcard4 but still has the fields on plain lines.
    const weird = ["BEGIN:VCARD", "VERSION:2.1", "UID:W-1", "FN:Weird Card", "EMAIL:w@example.com", "END:VCARD"].join(
      "\r\n",
    );
    const raw = parseVCard(weird, "w-1");
    expect(raw).not.toBeNull();
    expect(raw!.source_object_id).toBe("W-1");
    expect(raw!.display_name).toBe("Weird Card");
    expect(raw!.primary_email).toBe("w@example.com");
  });
});

describe("IcloudContactsConnector.sync (fake transport)", () => {
  const hA = `${CARD_BOOK.url}a.vcf`;
  const hB = `${CARD_BOOK.url}b.vcf`;

  it("round 1 upserts, round 2 detects a changed etag + a vanished href (deletion), round 3 gate-skips", async () => {
    const etags = (arr: [string, string][]): DavEtag[] => arr.map(([href, etag]) => ({ href, etag }));
    const { factory } = makeFakeCardFactory(
      [CARD_BOOK],
      [
        // round 0: two contacts.
        {
          [CARD_BOOK.url]: {
            ctag: "cc-1",
            etags: etags([
              [hA, "a1"],
              [hB, "b1"],
            ]),
            bodies: { [hA]: fullVcard("UID-A"), [hB]: fullVcard("UID-B") },
          },
        },
        // round 1: A's etag moves (changed), B vanishes from the listing (deletion).
        {
          [CARD_BOOK.url]: {
            ctag: "cc-2",
            etags: etags([[hA, "a2"]]),
            bodies: { [hA]: fullVcard("UID-A") },
          },
        },
        // round 2: ctag unchanged → gate skip.
        { [CARD_BOOK.url]: { ctag: "cc-2", etags: etags([[hA, "a2"]]), bodies: {} } },
      ],
    );
    const conn = new IcloudContactsConnector(factory);

    const r1 = await drain(conn.sync(ctx()));
    expect(r1.filter((r) => !r.deleted).length).toBe(2);
    const c1 = r1[r1.length - 1].cursor;

    const r2 = await drain(conn.sync(ctx(c1)));
    const dels = r2.filter((r) => r.deleted === true);
    const ups = r2.filter((r) => !r.deleted);
    expect(dels.length).toBe(1);
    expect(dels[0].externalId).toBe("UID-B"); // vanished href → its stored soid
    expect(ups.length).toBe(1); // A re-fetched (etag moved)
    expect((ups[0].raw as ContactRow).source_object_id).toBe("UID-A");
    // deletions precede upserts
    expect(r2.findIndex((r) => !r.deleted)).toBeGreaterThan(r2.map((r) => !!r.deleted).lastIndexOf(true));
    const c2 = r2[r2.length - 1].cursor;

    const r3 = await drain(conn.sync(ctx(c2)));
    expect(r3.length).toBe(0);
  });

  it("throws a secret-free error when the credential is missing", async () => {
    const { factory } = makeFakeCardFactory([CARD_BOOK], [{}]);
    const conn = new IcloudContactsConnector(factory);
    const bad: SyncContext = { ...ctx(), secret: null };
    await expect(drain(conn.sync(bad))).rejects.toThrow(/apple: missing/);
  });
});

describe("IcloudContactsConnector.normalize / strongKeys / execute", () => {
  const conn = new IcloudContactsConnector();

  it("normalize emits only REGISTRY contacts scalars (no uid/vcard/id)", () => {
    const raw = parseVCard(fullVcard("N-1"), "n-1")!;
    const row = conn.normalize({ object: "contact", externalId: "N-1", raw });
    expect(Object.keys(row).sort()).toEqual(
      [
        "company",
        "display_name",
        "family_name",
        "given_name",
        "job_title",
        "primary_email",
        "primary_phone",
        "source_object_id",
        "updated_at",
      ].sort(),
    );
  });

  it("strongKeys returns the vCard UID", () => {
    const raw = parseVCard(fullVcard("SK-1"), "sk-1")!;
    expect(conn.strongKeys({ object: "contact", externalId: "SK-1", raw })).toEqual({ ical_uid: "SK-1" });
  });

  it("execute() throws (read-only)", async () => {
    await expect(conn.execute()).rejects.toThrow(/read-only/);
  });
});
