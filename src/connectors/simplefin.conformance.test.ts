// SimpleFIN conformance — the contract harness asserts the runner-enforced invariants + the
// convention obligations against the real connector instance (contract layer; no DB/transport).

import { describeConformance } from "../sdk/index.js";
import { SimpleFinConnector } from "./simplefin.js";
import { SIMPLEFIN_CONFORMANCE } from "./simplefin.conformance.js";

describeConformance(new SimpleFinConnector(), SIMPLEFIN_CONFORMANCE);
