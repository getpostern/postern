// Google conformance fixtures — the multi-sector (ADR 0006) set: ONE connector serving BOTH calendar
// and contacts. A live calendar event + a cancelled-event tombstone (same id), and a live person + a
// deleted-person tombstone (same resourceName). The harness resolves each live record under the sector
// matching its `object` (calendar_event → calendar, contact → contacts). The deletionPairs prove each
// tombstone externalId == its live source_object_id.

import type { ConformanceFixtures } from "../sdk/index.js";
import {
  CAL_EVENT_1,
  CAL_EVENT_1_CANCELLED,
  PERSON_1,
  PERSON_1_DELETED,
} from "./google.fixtures.js";

export const GOOGLE_CONFORMANCE: ConformanceFixtures = {
  sectors: ["calendar", "contacts"],
  live: [
    { object: "calendar_event", externalId: CAL_EVENT_1.id, raw: CAL_EVENT_1, cursor: "CAL_SYNC_R1" },
    { object: "contact", externalId: PERSON_1.resourceName, raw: PERSON_1, cursor: "PEOPLE_SYNC_R1" },
  ],
  deletions: [
    { object: "calendar_event", deleted: true, externalId: CAL_EVENT_1_CANCELLED.id, raw: null },
    { object: "contact", deleted: true, externalId: PERSON_1_DELETED.resourceName, raw: null },
  ],
  deletionPairs: [
    { sourceObjectId: CAL_EVENT_1.id, externalId: CAL_EVENT_1_CANCELLED.id },
    { sourceObjectId: PERSON_1.resourceName, externalId: PERSON_1_DELETED.resourceName },
  ],
};
