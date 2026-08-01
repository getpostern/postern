// Microsoft Outlook conformance — contract layer (no DB/transport). Exercises the mail envelope
// surface + the Graph `@removed` deletion path (S7).

import { describeConformance } from "../sdk/index.js";
import { MicrosoftConnector } from "./microsoft.js";
import { MICROSOFT_CONFORMANCE } from "./microsoft.conformance.js";

describeConformance(new MicrosoftConnector(), MICROSOFT_CONFORMANCE);
