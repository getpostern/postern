// DNS-rebinding guard for the no-bearer admin/OAuth/Plaid REST routes. The edge binds 127.0.0.1 and
// those routes carry no per-request auth (reachability implies operator trust), so a page on evil.com
// that rebinds its DNS to 127.0.0.1 could otherwise reach them with `Host: evil.com`. We reject any
// request whose Host-header hostname is not a loopback name (or an operator-allowlisted host). This is
// a same-origin / rebinding guard, NOT per-request auth — it adds no credential check anywhere.

import type { RouteContext, Handler } from "./router.js";

/** Request rejected because its Host header is not allowlisted (DNS-rebinding guard). REST: 403. */
export class ForbiddenHostError extends Error {
  override name = "ForbiddenHostError";
}

/** Loopback hostnames always allowed (the legitimate Console/OAuth-callback shape). */
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

/**
 * The resolved allowlist — defaults plus the optional `REST_ALLOWED_HOSTS` env list (comma-separated,
 * trimmed, lowercased), for an operator who deliberately binds a non-loopback interface. Resolved ONCE
 * at module load; empty/unset env = defaults only.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = (() => {
  const set = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  const env = process.env.REST_ALLOWED_HOSTS;
  if (env) {
    for (const part of env.split(",")) {
      const name = part.trim().toLowerCase();
      if (name.length > 0) set.add(name);
    }
  }
  return set;
})();

/**
 * Extract the lowercased hostname from a Host-header value, stripping a trailing `:port`. Handles the
 * IPv6 bracket form (`[::1]:8787` -> `::1`) and a bare IPv6 literal (`::1`, multiple colons, no port).
 * Returns "" for a missing/empty header.
 */
function hostnameOf(hostHeader: string | undefined): string {
  if (hostHeader === undefined) return "";
  const raw = hostHeader.trim();
  if (raw.length === 0) return "";
  // Fail closed on a malformed Host: a value carrying userinfo (`@`) or internal whitespace is not a
  // valid RFC 7230 `Host = uri-host [":" port]`. Without this, `localhost:8787@evil.com` would parse to
  // `localhost` (and `[::1]@evil.com` to `::1`) and be ACCEPTED. Not browser-reachable (Host is a
  // forbidden fetch header / userinfo is stripped before Host is formed), but a security guard must
  // reject a malformed host rather than extract a loopback substring from it.
  if (/[@\s]/.test(raw)) return "";
  // IPv6 bracket form: `[::1]` or `[::1]:8787` — the host is between the brackets.
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return (end === -1 ? raw.slice(1) : raw.slice(1, end)).toLowerCase();
  }
  const firstColon = raw.indexOf(":");
  const lastColon = raw.lastIndexOf(":");
  // Multiple colons without brackets = a bare IPv6 literal (no port) — use the whole string.
  if (firstColon !== lastColon) return raw.toLowerCase();
  // Exactly one colon = hostname:port — strip the port.
  if (firstColon !== -1) return raw.slice(0, firstColon).toLowerCase();
  return raw.toLowerCase();
}

/**
 * Throw ForbiddenHostError unless the request's `Host` header hostname is a loopback name
 * (localhost | 127.0.0.1 | [::1] / ::1) or appears in the optional REST_ALLOWED_HOSTS env list.
 * Port is ignored (compare hostname only — the bound port varies: 8787, or 0 in tests). A missing
 * or empty Host header is rejected (fail-closed — real browser requests always send Host).
 */
export function assertAllowedHost(ctx: RouteContext): void {
  const hostname = hostnameOf(ctx.req.headers.host);
  if (hostname.length === 0 || !ALLOWED_HOSTS.has(hostname)) {
    throw new ForbiddenHostError("forbidden host");
  }
}

/** Combinator: wrap a handler so assertAllowedHost runs before it. */
export function localOnly(handler: Handler): Handler {
  return (ctx: RouteContext) => {
    assertAllowedHost(ctx);
    return handler(ctx);
  };
}
