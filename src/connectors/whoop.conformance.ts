// WHOOP conformance fixtures — the multi-object set across all three health tables: a sleep session,
// a workout, ONE recovery metric row, and ONE cycle (day-strain) metric row (recovery + cycle each
// fan out one health_samples row per metric; the fixtures carry the synthetic __pci_metric projection
// sync() threads on — cycle also carries the __pci_ns discriminator). Deletion is ACCEPTED-NONE (v2
// signals deletes only via webhooks, which V0 lacks) → no deletion records.

import type { ConformanceFixtures } from "../sdk/index.js";
import { SLEEP_SCORED, WORKOUT_SCORED, RECOVERY_SCORED, CYCLE_SCORED } from "./whoop.fixtures.js";

const CURSOR = "2026-06-12T00:00:00.000Z";

// The recovery metric raw as sync() emits it: the native v2 recovery payload + the metric projection.
const recoveryHrvRaw = {
  ...RECOVERY_SCORED,
  __pci_metric: { metric_type: "hrv_rmssd", value: 42.5, unit: "ms" },
};

// The cycle metric raw as sync() emits it: native v2 cycle payload + the metric + the __pci_ns marker.
const cycleStrainRaw = {
  ...CYCLE_SCORED,
  __pci_metric: { metric_type: "day_strain", value: 14.2, unit: "strain" },
  __pci_ns: "cycle" as const,
};

export const WHOOP_CONFORMANCE: ConformanceFixtures = {
  sectors: ["health"],
  live: [
    { object: "sleep_session", externalId: SLEEP_SCORED.id, raw: SLEEP_SCORED, cursor: CURSOR },
    { object: "workout", externalId: WORKOUT_SCORED.id, raw: WORKOUT_SCORED, cursor: CURSOR },
    {
      object: "health_sample",
      externalId: `recovery:${RECOVERY_SCORED.cycle_id}:hrv_rmssd`,
      raw: recoveryHrvRaw,
      cursor: CURSOR,
    },
    {
      object: "health_sample",
      externalId: `cycle:${CYCLE_SCORED.id}:day_strain`,
      raw: cycleStrainRaw,
      cursor: CURSOR,
    },
  ],
  deletions: [],
  deletionPairs: [],
};
