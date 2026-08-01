// Plaid conformance — contract layer (no DB/transport). Exercises the multi-object account/transaction
// surface + the /transactions/sync `removed` deletion path (S7).

import { describeConformance } from "../sdk/index.js";
import { PlaidConnector } from "./plaid.js";
import { PLAID_CONFORMANCE } from "./plaid.conformance.js";

describeConformance(new PlaidConnector(), PLAID_CONFORMANCE);
