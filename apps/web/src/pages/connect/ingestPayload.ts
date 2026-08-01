// The Apple Health ingest payload template — the last missing acceptance item of #27.
//
// #27 asked for five walkthrough steps. Four ship: the connection is created here, the served ingest
// path and the one-time webhook secret are shown with copy affordances, the reachable host is named
// as the operator's own (it CANNOT be derived — see the note in ConnectProvider's DeviceForm), and the
// "waiting for the first push" row is the verify signal. The fifth was *"show the exact JSON body the
// connector expects"*, and its acceptance is literally **"no source-diving for the payload"** — which
// is exactly what a person had to do: open `src/connectors/apple-health.ts` and read `decodePush`.
//
// Why this one is closeable while the reachable host is not: the payload is a static fact about OUR
// OWN ingest contract, not a fact about the box. It needs no served field, so there is nothing to
// degrade honestly around — the template either matches `decodePush` or it is wrong, and
// `ingestPayload.test.ts` runs the real connector over this exact string to decide which.
//
// AUTHORITY: `src/connectors/apple-health.ts`. Every KEY below is read off that file:
//   • `data.metrics[]` — `name` becomes `metric_type`, `units` becomes `unit`, `data[]` are the points.
//   • a point with `qty` is one `health_sample` ('sample'); a point with `Min`/`Avg`/`Max` and no `qty`
//     fans out to `<name>_min` / `_avg` / `_max` ('daily_total').
//   • the metric named `sleep_analysis` is the one that becomes a `health_sleep_sessions` row, keyed on
//     `sleepStart`, with `inBed`/`asleep` in HOURS.
//   • `data.workouts[]` needs its native `id` — no id, no row. `distance`/`activeEnergyBurned` are
//     `{ qty, units }` wrappers; `heartRate.avg.qty` / `heartRate.max.qty` are plain numbers.
//   • dates are Health Auto Export's `yyyy-MM-dd HH:mm:ss ±hhmm`, NOT strict ISO (`HAE_DATE_RE`).
//
// The VALUES are template placeholders — a plausible morning heart-rate reading, one night, one run.
// They are illustrative of the contract and belong to no user's gate; nothing here is read from, or
// written to, real data.

/** The shape, as an object, so the rendered template is a `JSON.stringify` of one source of truth. */
const TEMPLATE = {
  data: {
    metrics: [
      {
        name: "heart_rate",
        units: "count/min",
        data: [{ date: "2026-01-08 06:30:00 -0800", qty: 58 }],
      },
      {
        name: "sleep_analysis",
        data: [
          {
            sleepStart: "2026-01-07 23:05:00 -0800",
            sleepEnd: "2026-01-08 06:40:00 -0800",
            inBed: 7.6,
            asleep: 6.9,
          },
        ],
      },
    ],
    workouts: [
      {
        id: "00000000-0000-0000-0000-000000000000",
        name: "Running",
        start: "2026-01-08 17:02:00 -0800",
        end: "2026-01-08 17:41:00 -0800",
        duration: 2340,
        distance: { qty: 5.1, units: "km" },
        activeEnergyBurned: { qty: 402, units: "kcal" },
        heartRate: { avg: { qty: 148 }, max: { qty: 171 } },
      },
    ],
  },
};

/**
 * The JSON body a device POSTs to the ingest endpoint. ONE stringify, rendered and copied — never a
 * second one that can drift from what is on screen (the rule `ConnectRecipes.remoteConfigJson` set).
 * Valid JSON on purpose: a person can paste it straight into a Shortcut, or into `curl`, to prove the
 * endpoint works before wiring the automation up.
 */
export const HEALTH_PUSH_TEMPLATE = JSON.stringify(TEMPLATE, null, 2);
