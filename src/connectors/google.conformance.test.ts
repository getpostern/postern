// Google conformance — contract layer (no DB/transport). The multi-sector connector (ADR 0006):
// fixtures.sectors = ["calendar","contacts"] and the harness resolves each live record under the
// sector matching its `object`. Exercises both deletion paths (S7).

import { describeConformance } from "../sdk/index.js";
import { GoogleConnector } from "./google.js";
import { GOOGLE_CONFORMANCE } from "./google.conformance.js";

describeConformance(new GoogleConnector(), GOOGLE_CONFORMANCE);
