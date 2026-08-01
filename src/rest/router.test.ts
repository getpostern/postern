// Router seams — DB-free. Covers param extraction, method/path matching (404 vs 405), the
// 1MB-capped JSON body reader, and the error->HTTP-status map (no internal leak on 500).

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { ZodError, z } from "zod";
import {
  Router,
  readJson,
  errorToStatus,
  splitPath,
  ValidationError,
  UnauthorizedError,
  PayloadTooLargeError,
  MAX_BODY_BYTES,
  MAX_INGEST_BODY_BYTES,
} from "./router.js";
import { AccessDenied } from "../auth/index.js";
import type { IncomingMessage } from "node:http";

const noop = () => {};

describe("Router.match", () => {
  const r = new Router()
    .get("/api/agents", noop)
    .post("/api/agents", noop)
    .patch("/api/agents/:agentId", noop)
    .get("/api/records/:sector/:id", noop);

  it("extracts :params", () => {
    const m = r.match("GET", "/api/records/finance.transaction/abc-123");
    expect(m.kind).toBe("match");
    if (m.kind === "match") {
      expect(m.params).toEqual({ sector: "finance.transaction", id: "abc-123" });
    }
  });

  it("single :param", () => {
    const m = r.match("PATCH", "/api/agents/claude");
    expect(m.kind).toBe("match");
    if (m.kind === "match") expect(m.params).toEqual({ agentId: "claude" });
  });

  it("unknown path -> not_found (404)", () => {
    expect(r.match("GET", "/api/nope").kind).toBe("not_found");
  });

  it("known path, wrong method -> method_not_allowed (405)", () => {
    const m = r.match("DELETE", "/api/agents");
    expect(m.kind).toBe("method_not_allowed");
    if (m.kind === "method_not_allowed") {
      expect(m.allow).toContain("GET");
      expect(m.allow).toContain("POST");
    }
  });

  it("trailing slash is normalized", () => {
    expect(r.match("GET", "/api/agents/").kind).toBe("match");
  });
});

describe("splitPath", () => {
  it("drops empty segments", () => {
    expect(splitPath("/api/agents/")).toEqual(["api", "agents"]);
    expect(splitPath("/")).toEqual([]);
  });
});

/** Build a fake IncomingMessage from a body string by streaming it through a PassThrough. */
function fakeReq(body: string): IncomingMessage {
  const stream = new PassThrough();
  stream.end(Buffer.from(body, "utf8"));
  return stream as unknown as IncomingMessage;
}

describe("readJson", () => {
  it("parses a JSON body", async () => {
    const out = await readJson(fakeReq(JSON.stringify({ a: 1, b: "x" })));
    expect(out).toEqual({ a: 1, b: "x" });
  });

  it("empty body -> {}", async () => {
    expect(await readJson(fakeReq(""))).toEqual({});
  });

  it("non-JSON -> ValidationError (400)", async () => {
    await expect(readJson(fakeReq("not json {"))).rejects.toBeInstanceOf(ValidationError);
  });

  it("oversize body -> PayloadTooLargeError (400)", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 10);
    await expect(readJson(fakeReq(JSON.stringify({ big })))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("a >1MB body is rejected by default but accepted under the larger ingest cap (#28)", async () => {
    const payload = JSON.stringify({ big: "x".repeat(MAX_BODY_BYTES + 50_000) }); // ~1.05 MB, over the default 1 MB
    // default cap -> rejected
    await expect(readJson(fakeReq(payload))).rejects.toBeInstanceOf(PayloadTooLargeError);
    // larger ingest cap -> parsed in full (still bounded well under 25 MB)
    const out = (await readJson(fakeReq(payload), MAX_INGEST_BODY_BYTES)) as { big: string };
    expect(out.big.length).toBe(MAX_BODY_BYTES + 50_000);
  });
});

describe("errorToStatus", () => {
  it("ValidationError -> 400", () => {
    expect(errorToStatus(new ValidationError("bad")).status).toBe(400);
  });
  it("ZodError -> 400", () => {
    const ze = z.object({ x: z.string() }).safeParse({ x: 1 });
    expect(ze.success).toBe(false);
    if (!ze.success) expect(errorToStatus(ze.error as ZodError).status).toBe(400);
  });
  it("PayloadTooLargeError -> 400", () => {
    expect(errorToStatus(new PayloadTooLargeError("big")).status).toBe(400);
  });
  it("UnauthorizedError -> 401", () => {
    expect(errorToStatus(new UnauthorizedError("no bearer")).status).toBe(401);
  });
  it("AccessDenied -> 403", () => {
    expect(errorToStatus(new AccessDenied("finance")).status).toBe(403);
  });
  it("unexpected error -> 500 with NO internal detail leaked", () => {
    const out = errorToStatus(new Error("secret-token-abc123 stack detail"));
    expect(out.status).toBe(500);
    expect(out.body.error).toBe("internal error");
    expect(JSON.stringify(out.body)).not.toContain("secret-token-abc123");
  });
});
