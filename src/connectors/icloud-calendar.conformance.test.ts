// iCloud calendar conformance — contract layer (no DB/transport). The DB round-trip (H6/H7) lives in
// icloud-calendar.db.test.ts.

import { describeConformance } from "../sdk/index.js";
import { IcloudCalendarConnector } from "./icloud-calendar.js";
import { ICLOUD_CALENDAR_CONFORMANCE } from "./icloud-calendar.conformance.js";

describeConformance(new IcloudCalendarConnector(), ICLOUD_CALENDAR_CONFORMANCE);
