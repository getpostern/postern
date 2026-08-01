// Minimal method+path router for the REST edge — Node built-in http only, no framework.
//
// Routes are registered as (METHOD, pattern) where a pattern segment ":name" captures a path param.
// readJson caps the request body at 1 MB and rejects non-JSON. The error->HTTP-status map keeps the
// edge honest: validation -> 400, missing/invalid bearer -> 401, AccessDenied -> 403, unknown route
// -> 404, wrong method -> 405, anything unexpected -> 500 with NO internal detail leaked.

import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { AccessDenied } from "../auth/index.js";
import { QueryValidationError } from "../core/query.js";
import { NotFoundError, FetchLiveUnavailableError } from "../core/context.js";
import { ConfigError } from "../oauth/providers.js";
import { ForbiddenHostError } from "./host-allowlist.js";

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB cap on request bodies (query/admin/read DSL)
export const MAX_INGEST_BODY_BYTES = 25 * 1024 * 1024; // 25 MB cap for the push-ingest route ONLY — device exports (e.g. Apple Health) are legitimately multi-MB; the route is per-connection-secret-gated so the surface is bounded (#28)

/** Thrown by handlers/validators for a 400. */
export class ValidationError extends Error {
  override name = "ValidationError";
}
/** Thrown when the bearer is missing or unparseable (401). */
export class UnauthorizedError extends Error {
  override name = "UnauthorizedError";
}
/** Body too large (413-ish; mapped to 400 per the spec's status map). */
export class PayloadTooLargeError extends Error {
  override name = "PayloadTooLargeError";
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type Handler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[]; // pattern segments; ":name" = capture
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }
  patch(pattern: string, handler: Handler): this {
    return this.add("PATCH", pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler);
  }

  /**
   * Match method+path. Returns the handler + extracted params, or a discriminated miss:
   * - 'not_found' (no path matches) vs 'method_not_allowed' (path matches, method doesn't),
   *   so the dispatcher can answer 404 vs 405 correctly.
   */
  match(method: string, pathname: string):
    | { kind: "match"; handler: Handler; params: Record<string, string> }
    | { kind: "method_not_allowed"; allow: string[] }
    | { kind: "not_found" } {
    const parts = splitPath(pathname);
    let pathMatched = false;
    const allow = new Set<string>();

    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (params === null) continue;
      pathMatched = true;
      allow.add(route.method);
      if (route.method === method.toUpperCase()) {
        return { kind: "match", handler: route.handler, params };
      }
    }
    if (pathMatched) return { kind: "method_not_allowed", allow: [...allow] };
    return { kind: "not_found" };
  }
}

/** Split a path into non-empty segments. "/api/agents/" -> ["api","agents"]. */
export function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/** Match pattern segments against request segments, capturing ":name" params. null = no match. */
function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const pat = pattern[i];
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = decodeURIComponent(actual[i]);
    } else if (pat !== actual[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Read + JSON-parse the request body, capping at MAX_BODY_BYTES. Over the cap -> PayloadTooLargeError
 * (the stream is destroyed so we don't buffer past the limit); malformed JSON -> ValidationError.
 * An empty body parses to {}.
 */
export function readJson(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const onData = (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        // Stop buffering but DRAIN the rest of the request so the response can still flush a clean
        // 400 (destroying the socket would surface as a reset to the client instead of a 400).
        req.off("data", onData);
        req.resume();
        reject(new PayloadTooLargeError(`request body exceeds the ${maxBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    };

    req.on("data", onData);
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError("request body is not valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Write a JSON response with the given status. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/**
 * Map a thrown error to an HTTP status + a SAFE body. Internal errors (500) never leak their message
 * — only a generic "internal error" string — so secrets/stack detail can't escape via an error path.
 */
export function errorToStatus(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof PayloadTooLargeError) return { status: 400, body: { error: "payload too large" } };
  if (err instanceof ValidationError) return { status: 400, body: { error: err.message } };
  if (err instanceof QueryValidationError) return { status: 400, body: { error: err.message } };
  if (err instanceof ConfigError) return { status: 400, body: { error: err.message } };
  if (err instanceof ZodError) {
    // Flatten the issues so the 400 NAMES the offending field + reason (e.g. "bogus: Unrecognized
    // key(s)…", "limit: …") instead of an opaque "validation failed" the agent can't self-correct
    // from (#2). ZodError messages describe the input SHAPE only — no row data, no secrets — so they
    // are safe to surface, unlike the generic-500 branch below that intentionally hides internals.
    const detail = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: `validation failed: ${detail}` } };
  }
  if (err instanceof UnauthorizedError) return { status: 401, body: { error: "unauthorized" } };
  if (err instanceof AccessDenied) return { status: 403, body: { error: "access denied" } };
  if (err instanceof NotFoundError) return { status: 404, body: { error: err.message } };
  if (err instanceof FetchLiveUnavailableError) return { status: 502, body: { error: err.message } };
  if (err instanceof ForbiddenHostError) return { status: 403, body: { error: "forbidden host" } };
  // Unknown: never surface the message (no internal/secret leak).
  return { status: 500, body: { error: "internal error" } };
}
