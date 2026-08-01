// iCloud contacts conformance — contract layer (no DB/transport). The DB round-trip lives in
// icloud-contacts.db.test.ts.

import { describeConformance } from "../sdk/index.js";
import { IcloudContactsConnector } from "./icloud-contacts.js";
import { ICLOUD_CONTACTS_CONFORMANCE } from "./icloud-contacts.conformance.js";

describeConformance(new IcloudContactsConnector(), ICLOUD_CONTACTS_CONFORMANCE);
