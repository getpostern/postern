// iCloud contacts conformance fixtures — a live parsed contact + a paired tombstone (same
// source_object_id = the vCard UID).

import type { ConformanceFixtures } from "../sdk/index.js";
import { parseVCard } from "./icloud-contacts.js";
import { fullVcard } from "./icloud-contacts.fixtures.js";

const raw = parseVCard(fullVcard("UID-CONF-1"), "conf-1");
if (raw == null) throw new Error("icloud-contacts conformance fixture failed to parse");

export const ICLOUD_CONTACTS_CONFORMANCE: ConformanceFixtures = {
  sectors: ["contacts"],
  live: [{ object: "contact", externalId: raw.source_object_id, raw }],
  deletions: [{ object: "contact", deleted: true, externalId: "UID-CONF-1", raw: null }],
  deletionPairs: [{ sourceObjectId: "UID-CONF-1", externalId: "UID-CONF-1" }],
};
