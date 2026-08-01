// iCloud calendar conformance fixtures — a live expanded occurrence + a paired tombstone (same
// source_object_id), proving the connector's records satisfy the machine contract (H1–H5, S7, …).

import type { ConformanceFixtures } from "../sdk/index.js";
import { expandCalendarObject } from "./icloud-calendar.js";
import { singleEventIcs } from "./icloud-calendar.fixtures.js";

const WIN_START = new Date("2026-01-01T00:00:00Z");
const WIN_END = new Date("2027-01-01T00:00:00Z");
const { records } = expandCalendarObject(
  singleEventIcs("EVT-CONF-1", new Date("2026-06-15T15:00:00Z")),
  WIN_START,
  WIN_END,
  "me@icloud.com",
);

export const ICLOUD_CALENDAR_CONFORMANCE: ConformanceFixtures = {
  sectors: ["calendar"],
  live: [records[0]],
  deletions: [{ object: "calendar_event", deleted: true, externalId: "EVT-CONF-1", raw: null }],
  deletionPairs: [{ sourceObjectId: "EVT-CONF-1", externalId: "EVT-CONF-1" }],
};
