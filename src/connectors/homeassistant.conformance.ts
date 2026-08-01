// Home Assistant conformance fixtures — the documented outlier (ADR 0007). HA is a PUSH connector
// that bypasses the sync→normalize→upsert pipeline: start() opens a WebSocket and owns its own writes,
// tombstones, and a STORING fetchRecordLive. So it is run with emitsNoRecords:true +
// fetchRecordLiveStores:true — the emit-driven contract checks (H1–H3, H5, S7, S8, S10, S11) are
// skipped; H-types, S6, S12, and its action surface (S4 — it is action-rich via listActions) still
// hold. Its hand-rolled tests (ha-ws.test.ts, homeassistant.test.ts, homeassistant.db.test.ts) remain
// authoritative for the WS specifics.

import type { ConformanceFixtures } from "../sdk/index.js";

export const HOMEASSISTANT_CONFORMANCE: ConformanceFixtures = {
  sectors: ["home"],
  live: [],
  deletions: [],
  deletionPairs: [],
};
