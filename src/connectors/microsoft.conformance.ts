// Microsoft Outlook conformance fixtures — the multi-sector (#26a, ADR 0006) set: ONE connector
// serving mail + calendar + contacts. Per object: a live record (production-string Graph payloads;
// the mail record includes the synthetic __pci_folder threading sync() adds) and an `@removed`
// deletion record for the SAME id. The deletionPairs prove each tombstone externalId == its live
// source_object_id.

import type { ConformanceFixtures } from "../sdk/index.js";
import {
  MSG_INBOX_1,
  REMOVED_INBOX_1,
  CAL_OCCURRENCE_1,
  CAL_REMOVED_1,
  CONTACT_1,
  CONTACT_REMOVED_1,
} from "./microsoft.fixtures.js";

const FOLDER_KEY = "__pci_folder";

export const MICROSOFT_CONFORMANCE: ConformanceFixtures = {
  sectors: ["mail", "calendar", "contacts"],
  live: [
    {
      object: "message",
      externalId: MSG_INBOX_1.id,
      raw: { ...MSG_INBOX_1, [FOLDER_KEY]: "inbox" },
    },
    {
      object: "calendar_event",
      externalId: CAL_OCCURRENCE_1.id,
      raw: CAL_OCCURRENCE_1,
    },
    {
      object: "contact",
      externalId: CONTACT_1.id,
      raw: CONTACT_1,
    },
  ],
  deletions: [
    { object: "message", deleted: true, externalId: REMOVED_INBOX_1.id, raw: null },
    { object: "calendar_event", deleted: true, externalId: CAL_REMOVED_1.id, raw: null },
    { object: "contact", deleted: true, externalId: CONTACT_REMOVED_1.id, raw: null },
  ],
  deletionPairs: [
    { sourceObjectId: MSG_INBOX_1.id, externalId: REMOVED_INBOX_1.id },
    { sourceObjectId: CAL_OCCURRENCE_1.id, externalId: CAL_REMOVED_1.id },
    { sourceObjectId: CONTACT_1.id, externalId: CONTACT_REMOVED_1.id },
  ],
};
