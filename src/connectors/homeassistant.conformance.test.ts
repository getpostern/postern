// Home Assistant conformance — the documented exemption (ADR 0007). Run with emitsNoRecords:true +
// fetchRecordLiveStores:true: the emit-driven contract checks are skipped (HA is push-mode and owns
// its own writes via the WebSocket), while H-types/S6/S12 and the action surface (S4 — HA is
// action-rich via listActions; S5 is the deferred it.todo) still hold.

import { describeConformance } from "../sdk/index.js";
import { HomeAssistantConnector } from "./homeassistant.js";
import { HOMEASSISTANT_CONFORMANCE } from "./homeassistant.conformance.js";

describeConformance(new HomeAssistantConnector(), HOMEASSISTANT_CONFORMANCE, {
  emitsNoRecords: true,
  fetchRecordLiveStores: true,
});
