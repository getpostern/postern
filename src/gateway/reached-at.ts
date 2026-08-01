// "Has anything actually reached me at this address?" — the addresses THIS PROCESS has been reached
// at, since it started (remote-access-onboarding §Decision 2/3/4, issue #119).
//
// ══ EVIDENCE, NEVER TRUTH ══════════════════════════════════════════════════════════════════════
//
// Every value in here came off the wire as an inbound `Host` header on the MCP edge — a **public,
// unauthenticated** edge. It is attacker-influenceable by construction: anyone who can open a socket
// to this gateway chooses what goes in this map. So the ONE rule, and the reason this module exports
// no setter anything else can reach:
//
//   An observed host may be SHOWN to a human as an observation. It may never be auto-applied, never
//   become the configured address, never feed validatePublicUrl, never widen bridgeTokensAcceptable()
//   and never widen any other check.
//
// Treating a client-supplied Host as authority is the confused-deputy shape public-edge-hardening
// (U2) hardened against (docs/specs/notes/public-edge-hardening.md §"the reviewer's follow-up"). This
// module is deliberately a DEAD END in the dependency graph: `src/mcp/http.ts` writes to it and
// `src/rest/exposure-routes.ts` reads it to render one advisory field. Nothing else may import it,
// and nothing here returns a value any gate consumes.
//
// ══ Why in-memory, and why "since boot" is the honest window ═══════════════════════════════════
//
// The question the user is asking is "is my Funnel working NOW". That is a question about the running
// process, so a record scoped to the running process answers it exactly — and needs no table, no
// migration and no retention policy. A restart resets it; that is correct, not a gap.
//
// ══ Why the set is HARD bounded ════════════════════════════════════════════════════════════════
//
// The writer is unauthenticated public traffic. An unbounded map fed from there is a
// memory-exhaustion lever, so: at most REACHED_AT_MAX entries, oldest-by-last-use evicted, and every
// candidate is length-capped and shape-checked BEFORE it is stored. A stranger sending a million
// distinct Hosts costs this process 16 short strings.
//
// ══ The two failure modes, stated rather than hidden ═══════════════════════════════════════════
//
//  1. FALSE NEGATIVE. A stranger who has found the URL can push a genuine observation out of a
//     16-entry window by sending distinct Hosts. The result is "nothing has reached this address",
//     which sends the user to check their Funnel — the safe direction, and the same thing they see
//     before any traffic arrives.
//  2. FALSE POSITIVE. Anyone who can reach the edge at all can spoof `Host:` — a local `curl -H
//     'Host: gw.example.ts.net'` records that name without any Funnel existing. So this field is
//     evidence a human weighs, never a verification. THE COPY MUST SAY "observed", NOT "verified".
//
// A peer-address filter ("only record from a non-loopback peer") would fix (2) and is WRONG here:
// behind Tailscale Funnel tailscaled terminates TLS and proxies from localhost, and Docker NATs every
// connection to one address — U2 measured this — so in production every real request looks loopback
// and such a filter would record NOTHING. Do not add one.

/** Hard cap on stored hosts. Small on purpose: this answers one yes/no question, it is not a log. */
export const REACHED_AT_MAX = 16;

/**
 * Longest candidate we will store. A DNS name is at most 253 bytes; `:65535` is 6 more. Anything
 * longer is not a hostname anyone configured — it is someone filling our memory one header at a
 * time, and Node will happily deliver a 16 KiB one. Over-length is DROPPED, never truncated: a
 * truncated host would be shown to a human as something they never typed.
 */
const MAX_HOST_LEN = 260;

/**
 * The conservative shape of a host we are willing to keep: letters, digits, and the punctuation that
 * appears in DNS names, IPv4/IPv6 literals (`[::1]`, `%25` zone ids) and a `:port` suffix. Anything
 * else is dropped rather than sanitized — this string is rendered in a UI, and the only safe answer
 * to a header we do not recognise is to not have it.
 */
const HOST_SHAPE = /^[a-z0-9._~%\-[\]:]+$/;

/**
 * host → insertion marker. A Map is insertion-ordered, so `delete` + `set` on a repeat sighting moves
 * that host to the end and eviction from the front is least-recently-seen. Both are O(1), which
 * matters: this runs on every inbound request to the public edge.
 */
const seen = new Map<string, true>();

/**
 * Normalize a candidate for storage and comparison. Lowercase (Host is case-insensitive) and trimmed.
 *
 * The one tolerance: a trailing `:443` is dropped. The configured address is canonicalized by
 * `validatePublicUrl` → `canonicalizeUrl`, and WHATWG URL drops the default port, so a configured
 * `https://gw.example.ts.net:443` is stored as `gw.example.ts.net`. Normalizing the observed side the
 * same way keeps a client that spells the default port explicitly from producing a false "nothing has
 * reached you". It is tolerance for one spelling of the same address, not truth about the scheme.
 *
 * Returns null for anything we refuse to store.
 */
function normalizeHost(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HOST_LEN) return null;
  const lower = trimmed.toLowerCase();
  if (!HOST_SHAPE.test(lower)) return null;
  return publicCandidate(lower);
}

/**
 * ⚠️ THE RULE THAT MAKES THE `false` ANSWER MEAN ANYTHING (spec Decision 2a, added at merge after the
 * adversarial review found the diagnosis inverted on the DEFAULT topology).
 *
 * Only traffic that could plausibly have crossed the public internet may be recorded. This is exact,
 * not a heuristic: Tailscale offers Funnel on {443, 8443, 10000} and cloud MCP backends egress on 443
 * ONLY, and `MCP_PUBLIC_URL` is required to be port-less — so a request that genuinely arrived from
 * the internet MUST carry a port-less or `:443` Host. Every other spelling is private-path traffic by
 * construction.
 *
 * Why it is load-bearing: `tailscale serve --https=10000` and the Funnel point at the SAME backend
 * (`docs/runbooks/remote-access.md:25` / `:87`). Without this rule every Claude Code / Cursor / IDE
 * request from the owner's own laptop arrives as `<machine>.<tailnet>.ts.net:10000`, a loopback client
 * arrives as `localhost:8788`, and either flips the served answer from "nothing has reached this yet"
 * to "reached — but never at this address". The Console then tells a user whose hostname is CORRECT to
 * go and check it. A diagnosis that inverts on the normal setup is worse than no diagnosis.
 *
 * Loopback literals are refused even when port-less: they can never be the configured public address,
 * so recording one could only ever manufacture a spurious "reached elsewhere".
 */
function publicCandidate(lower: string): string | null {
  // Split host from port, honouring the IPv6 bracket form (`[::1]:8788` → host `[::1]`, port `8788`).
  const lastColon = lower.lastIndexOf(":");
  const closingBracket = lower.lastIndexOf("]");
  const hasPort = lastColon > closingBracket && lastColon !== -1;
  const host = hasPort ? lower.slice(0, lastColon) : lower;
  const port = hasPort ? lower.slice(lastColon + 1) : "";

  if (hasPort && port !== "443") return null; // a private path by construction — see above
  if (host.length === 0) return null;

  // RFC 6761: `localhost` and every `*.localhost` name. Plus the IPv4 loopback /8 and IPv6 `::1`,
  // including the IPv4-mapped spelling. Mirrors the range test U2 landed for the confused-deputy
  // guard — a loopback name reaching a PUBLIC edge is never evidence about public reachability.
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  if (host === "[::1]" || host === "::1") return null;
  if (/^\[?::ffff:127\./.test(host)) return null;

  return host;
}

/**
 * Note a hostname this process has been reached at. Bounded; least-recently-seen evicted.
 *
 * Called from the MCP edge's request handler on EVERY inbound request, including the discovery and
 * OAuth paths — a cloud MCP client fetches `/.well-known/...` before it ever reaches `/mcp`, and a
 * user whose tunnel works but whose OAuth does not must still see that traffic is arriving.
 *
 * Never throws: it is on the request hot path of a public edge, and a header is not worth a 500.
 */
export function noteReachedAt(host: string | undefined): void {
  const h = normalizeHost(host);
  if (h === null) return;
  seen.delete(h); // repeat sighting → move to the newest end (keeps eviction least-recently-seen)
  seen.set(h, true);
  while (seen.size > REACHED_AT_MAX) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
}

/**
 * Hostnames observed since boot, newest first. ADVISORY — never authority.
 *
 * Returns a fresh array every call: the caller must not be able to reach the store through it.
 */
export function reachedAtHosts(): readonly string[] {
  return [...seen.keys()].reverse();
}

/**
 * Has this process been reached at `publicUrl`? The ONE derivation behind the served
 * `observedAtConfiguredAddress` field — the Console renders this, it never computes it.
 *
 *   null  — we cannot say. Either there is no configured address, or nothing has reached this
 *           process at all yet. "We have no evidence" is a different answer from "the evidence says
 *           no", and collapsing them would turn a fresh boot into a reported failure.
 *   false — traffic HAS arrived, but never carrying this address. That is the diagnostic answer: the
 *           problem is upstream of Postern.
 *   true  — something reached us naming this address. Evidence, not proof (see the header).
 *
 * The comparison direction is load-bearing: the TRUSTED, already-validated configured address is
 * looked up IN the untrusted set. The untrusted set never supplies a value to anything.
 */
export function observedAtAddress(publicUrl: string | null | undefined): boolean | null {
  if (publicUrl == null || publicUrl.length === 0) return null;
  if (seen.size === 0) return null;
  let host: string;
  try {
    host = new URL(publicUrl).host;
  } catch {
    return null; // an address we cannot parse is one we cannot say anything about
  }
  const normalized = normalizeHost(host);
  if (normalized === null) return null;
  return seen.has(normalized);
}

/** Test seam ONLY. The store is process-wide module state; a leaked sighting silently satisfies the
 *  cells that assert "nothing has reached this address yet". */
export function __resetReachedAtForTests(): void {
  seen.clear();
}
