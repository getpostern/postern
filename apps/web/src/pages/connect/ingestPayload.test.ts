// #27's acceptance is "no source-diving for the payload" — so the template the Console shows has to
// be the ingest contract, not a plausible-looking sketch of it. This file is the only thing that can
// tell those two apart: it runs the REAL connector's `decodePush` over the exact string the screen
// renders, and asserts the rows that come out.
//
// A docs-shaped test would have compared the template to a second copy of the shape and passed
// forever while both drifted from `apple-health.ts`. Reaching across the package boundary is the point
// — the precedent is `route-contract.test.ts`, which reads `src/rest/oauth-routes.ts` for the same
// reason. `apple-health.ts`'s only import is `import type`, so nothing of the backend boots here.

import { describe, expect, it } from "vitest";
import { AppleHealthConnector } from "../../../../../src/connectors/apple-health.js";
import { HEALTH_PUSH_TEMPLATE } from "./ingestPayload";

const connector = new AppleHealthConnector();

/** The template as the connector receives it — proving en route that what we render is valid JSON. */
function decoded() {
  return connector.decodePush(JSON.parse(HEALTH_PUSH_TEMPLATE));
}

describe("the Apple Health payload template IS the ingest contract", () => {
  it("is valid JSON — a person can paste it into a Shortcut or curl unedited", () => {
    expect(() => JSON.parse(HEALTH_PUSH_TEMPLATE)).not.toThrow();
    // Pretty-printed, not minified: this is read on screen before it is copied.
    expect(HEALTH_PUSH_TEMPLATE).toContain("\n");
  });

  it("the real connector decodes it into rows across all three health objects", () => {
    const records = decoded();
    // Not an empty accept: `decodePush` skips a point it cannot key, so a template with the wrong key
    // names decodes to [] WITHOUT throwing. That silent-empty is the failure mode this pins.
    expect(records.length).toBeGreaterThan(0);
    const objects = new Set(records.map((r) => r.object));
    expect(objects).toEqual(new Set(["health_sample", "sleep_session", "workout"]));
  });

  it("the metric point becomes a dated sample, keyed the way re-posts need", () => {
    const sample = decoded().find((r) => r.object === "health_sample");
    expect(sample).toBeDefined();
    const row = connector.normalize(sample!) as { metric_type: string; unit: string | null; value: number | null; window_start: string | null };
    expect(row.metric_type).toBe("heart_rate");
    expect(row.unit).toBe("count/min");
    expect(row.value).toBe(58);
    // The dates in the template are Health Auto Export's "±hhmm" form, NOT ISO. If the template used
    // an ISO string the connector's fallback would still parse it — but a user copying it into HAE's
    // own format would then be following an example that does not match what their phone sends.
    expect(row.window_start).not.toBeNull();
    expect(HEALTH_PUSH_TEMPLATE).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}/);
    expect(sample!.externalId).toBe(`heart_rate:${row.window_start}`);
  });

  it("the sleep_analysis metric becomes a sleep session with hours converted to seconds", () => {
    const sleep = decoded().find((r) => r.object === "sleep_session");
    expect(sleep).toBeDefined();
    const row = connector.normalize(sleep!) as {
      time_in_bed_seconds: number | null;
      time_asleep_seconds: number | null;
      ended_at: string | null;
    };
    // 7.6 h in bed / 6.9 h asleep — the template's own numbers, in the units the connector expects.
    expect(row.time_in_bed_seconds).toBeCloseTo(7.6 * 3600, 5);
    expect(row.time_asleep_seconds).toBeCloseTo(6.9 * 3600, 5);
    expect(row.ended_at).not.toBeNull(); // sleepEnd parsed, so the key name is right
  });

  it("the workout carries its id, its quantity wrappers and its heart-rate nesting", () => {
    const workout = decoded().find((r) => r.object === "workout");
    expect(workout).toBeDefined();
    const row = connector.normalize(workout!) as {
      sport: string | null;
      distance_meters: number | null;
      energy_kcal: number | null;
      avg_heart_rate: number | null;
      max_heart_rate: number | null;
      duration_seconds: number | null;
    };
    expect(row.sport).toBe("running");
    expect(row.distance_meters).toBeCloseTo(5.1 * 1000, 5); // units: "km" honoured
    expect(row.energy_kcal).toBe(402); // units: "kcal" → no kJ divisor
    expect(row.avg_heart_rate).toBe(148); // heartRate.avg.qty, two levels deep
    expect(row.max_heart_rate).toBe(171);
    expect(row.duration_seconds).toBe(2340);
  });

  it("re-posting the same window upserts instead of duplicating — the claim the copy makes", () => {
    // The screen tells the reader "re-posting an overlapping window updates the same rows; it never
    // duplicates them". That is only true because every id is derived from the payload's own values.
    const first = decoded().map((r) => r.externalId);
    const second = decoded().map((r) => r.externalId);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length); // and no two rows in ONE post collide
  });

  it("carries no reachable host and no secret — the two things #27 says must not be here", () => {
    expect(HEALTH_PUSH_TEMPLATE).not.toMatch(/https?:\/\//);
    expect(HEALTH_PUSH_TEMPLATE.toLowerCase()).not.toContain("webhook");
    expect(HEALTH_PUSH_TEMPLATE.toLowerCase()).not.toContain("secret");
    expect(HEALTH_PUSH_TEMPLATE).not.toContain("api/ingest");
  });
});
