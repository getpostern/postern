// /healthz over real HTTP through createRestApp. Liveness/readiness returns 200 (DB reachable) and
// flips to 503 once beginShutdown() is called (so an orchestrator drains us before teardown). The
// 200 path needs Postgres (a `select 1`) so it's gated on DATABASE_URL; the 503 path is DB-free.
//
// beginShutdown() flips a process-wide, irreversible flag, so the shutting-down case MUST run last.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRestApp, beginShutdown } from "./index.js";
import { closePool } from "../db.js";

const HAS_DB = !!process.env.DATABASE_URL;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(createRestApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (HAS_DB) await closePool();
});

describe("/healthz", () => {
  it.skipIf(!HAS_DB)("returns 200 when up and the DB is reachable (liveness/readiness)", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("405s a non-GET (only GET is the probe)", async () => {
    const res = await fetch(`${base}/healthz`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  // MUST be last: beginShutdown() is irreversible (drains the process for good).
  it("returns 503 once shutting down (probe drains it)", async () => {
    beginShutdown();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "shutting_down" });
  });
});
