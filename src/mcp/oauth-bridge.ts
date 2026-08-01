// mcp-auth-bridge — the opt-in, same-origin OAuth 2.1 bridge on the MCP HTTP edge (ADR 0029).
//
// A minimal authorization server wrapping the EXISTING agent key: discovery metadata (RFC 9728 +
// RFC 8414), dynamic client registration (RFC 7591), an /authorize page whose "login" is pasting a
// Console-minted agent key, and /token issuing short-lived access + rotating refresh tokens that
// resolve to the SAME agent_grants row (same sectors, same audit identity). Default OFF: the ONE
// switch is MCP_PUBLIC_URL (set = on) — with it unset the edge serves none of these routes, sends
// no WWW-Authenticate header, and never consults the bridge tables (previously-minted bridge
// tokens are inert; fail-closed).
//
// Everything here is deterministic + hash-only: codes/tokens are 32 random bytes base64url with a
// pcgac_/pcgat_/pcgrt_ prefix (prefix INCLUDED in the sha256 preimage); only the sha256 hex ever
// reaches a row; the pasted agent key is validated via the same resolveBearer path and never stored.
//
// PUBLIC-EDGE HARDENING (ADR 0035 §D3 — this file is the gate). What is closed here, each one a
// hole a real caller can fall through (deliberately NOT numbered against the ADR's §D3 list, which
// the mother reconciles — see the accepted limitation below):
//   · DCR registration EVICTS instead of refusing (a stranger can no longer lock the owner out),
//   · ONE bounded in-process DB-slot semaphore, so the public port cannot exhaust the shared pool
//     the loopback admin edge depends on,
//   · loopback redirect URIs may not aim at the gateway's own route namespace, over EITHER scheme
//     (confused deputy) — and the loopback test is a RANGE test, not a three-string allowlist,
//   · a presented RFC 8707 `resource` carrying a query/fragment/userinfo is REFUSED, never
//     normalized into a match (canonicalization must not become a validation bypass),
//   · denial audits are throttled BY COST-TO-TRIGGER (cheap denials share a budget and coalesce;
//     high-value ones are never suppressed) — the queue's drop-newest overflow policy in
//     ../audit/queue.ts is the other half,
//   · a key handed to a cloud client must carry an expiry.
// Plus: MCP_PUBLIC_URL is CANONICALIZED (host lowercased, default port dropped) on both sides of
// every `resource` comparison. ADR 0035 §D6: no route here may ever move to the REST edge.
//
// WHAT IS DELIBERATELY *NOT* HERE, and why (operator ruling, 2026-07-25).
// Behind a Tailscale Funnel there is NO client identity: tailscaled terminates TLS and proxies from
// localhost, and Docker NATs every connection to one source address, so `resolveClientIp` returns
// the SAME constant for the owner and for an attacker. Every "per-caller" limit is therefore really
// a GLOBAL limit, and the owner's own flow passes through anonymous steps (GET /authorize issues the
// CSRF token POST /authorize requires), so no scheme of reserved budgets can guarantee the owner
// gets through while a stranger floods. Three review rounds proved this by probe. So the property
// "an anonymous flood can never refuse the owner" is UNACHIEVABLE in the shipped topology and is not
// attempted: there is ONE plain rate limiter sized for availability, not defence. ACCEPTED
// LIMITATION: a determined attacker who has found the URL may disrupt CONNECTION SETUP while
// attacking. No data, no key and no established connection is at risk — the DB semaphore below is
// what keeps the blast radius off the private edge, and it works regardless of identity.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { pool } from "../db.js";
import { resolveBearer, AccessDenied, ALL_SECTORS, type AuthContext } from "../auth/index.js";
import { audit } from "../audit/index.js";
import { getExposure } from "../gateway/exposure-config.js";

// ── Config (the ONE switch) ──────────────────────────────────────────────────────

/** A parsed CIDR (or bare IP, prefixBits = the full width) from MCP_TRUSTED_PROXIES. */
export interface TrustedProxy {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

export interface BridgeConfig {
  /** CANONICAL public ORIGIN, and never a path: host lowercased, default port dropped, trailing
   *  slashes trimmed. Built from the parsed URL, never from the raw string. MUST be https:// (http
   *  allowed ONLY for localhost/127.0.0.1 dev); NEVER Host-derived — the discovery documents state
   *  it verbatim.
   *
   *  This said "(+ optional path prefix)" until #126, and no router ever honoured one: every route
   *  below is mounted at the origin root, so a prefix produced discovery documents advertising
   *  endpoints that 404 on the gateway that advertised them, with every health signal green.
   *  `validatePublicUrl` now refuses a path outright — see the note there for why refusing beats
   *  stripping, and for the topology that is thereby unsupported. */
  publicUrl: string;
  /** Parsed MCP_TRUSTED_PROXIES. ABSENT or EMPTY ⇒ forwarded headers are NEVER read (safe default). */
  trustedProxies?: readonly TrustedProxy[];
}

/** Minimal structural pg surface so the closure's DB access is injectable in tests (ONE cast at the default). */
export interface BridgeQueryResult {
  rows: unknown[];
  rowCount: number | null;
}
export interface BridgePoolClient {
  query(sql: string, values?: unknown[]): Promise<BridgeQueryResult>;
  release(): void;
}
export interface BridgePool {
  query(sql: string, values?: unknown[]): Promise<BridgeQueryResult>;
  connect(): Promise<BridgePoolClient>;
}

/** Test seams. `now` makes every window/bucket/TTL assertion deterministic and timezone-free. */
export interface BridgeDeps {
  pool?: BridgePool;
  now?: () => number;
}

/** A bridge endpoint handler; the http edge dispatches by `"<METHOD> <path>"` before the /mcp check. */
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Named config failure so boot can refuse with an actionable message (fail-closed, ADR 0029). */
export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConfigError";
  }
}

/**
 * Canonical form of a URL for byte-comparison: origin (WHATWG URL already lowercases the host and
 * drops a default port) + pathname with trailing slashes trimmed. null = unparseable.
 *
 * NOTE what this DISCARDS: query, fragment and userinfo — and note that discarding is only ever safe
 * because SOMETHING ELSE already refused those. `validatePublicUrl` refuses all three (plus a path)
 * before a config value ever reaches here, so building OUR canonical issuer/resource through this
 * function loses nothing that was allowed to be present. It is WRONG as a comparison for a PRESENTED
 * value — canonicalization must never become a validation bypass — and every comparison against a
 * value that came off the wire goes through `resourceMatches` instead.
 *
 * That pairing was ASYMMETRIC until #126: `resourceMatches` below refused userinfo on a presented
 * value while `validatePublicUrl` silently stripped it from a saved one, so `https://gw@evil.example`
 * was accepted and published the gateway as `evil.example`. Both halves refuse it now.
 */
export function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/**
 * The ONE comparison for a PRESENTED RFC 8707 `resource`. Canonicalization is tolerance for case and
 * a default port ONLY: a presented value carrying a query, fragment or userinfo is REFUSED outright
 * rather than silently normalized away (`https://gw/mcp?x=1`, `https://gw/mcp#f` and
 * `https://user:pw@gw/mcp` all canonicalize to `https://gw/mcp` and must not be accepted as it).
 */
export function resourceMatches(presented: string, canonical: string): boolean {
  let u: URL;
  try {
    u = new URL(presented);
  } catch {
    return false;
  }
  if (u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "") return false;
  return canonicalizeUrl(presented) === canonical;
}

// ── Trusted proxies + client identity ────────────────────────────────────────────
//
// MCP_TRUSTED_PROXIES is DEMOTED, not deleted. It is correct for someone fronting the edge with a
// proxy that really does supply a client address, and it costs nothing to honour. It has NOTHING
// TRUE TO BE SET TO BEHIND A TAILSCALE FUNNEL: nothing in that path supplies a client address, so
// setting it there buys no per-caller anything. Nothing in this file, its tests or its docs may
// imply otherwise.

function parseIPv4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const v = Number(parts[i]);
    if (v > 255) return null;
    out[i] = v;
  }
  return out;
}

function parseIPv6(input: string): Uint8Array | null {
  let s = input;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups so one parser handles both forms.
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    if (colon < 0) return null;
    const v4 = parseIPv4(s.slice(colon + 1));
    if (!v4) return null;
    const g1 = (((v4[0] << 8) | v4[1]) >>> 0).toString(16);
    const g2 = (((v4[2] << 8) | v4[3]) >>> 0).toString(16);
    s = `${s.slice(0, colon + 1)}${g1}:${g2}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function parseIp(input: string): { family: 4 | 6; bytes: Uint8Array } | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // drop an IPv6 zone id
  const fam = isIP(s);
  if (fam === 4) {
    const b = parseIPv4(s);
    return b ? { family: 4, bytes: b } : null;
  }
  if (fam === 6) {
    const b = parseIPv6(s);
    return b ? { family: 6, bytes: b } : null;
  }
  return null;
}

/** Canonical string form of an address — IPv4-mapped IPv6 collapses to its v4 form so ONE client
 *  is ONE bucket key however the socket reports it. null = not an IP. */
function normalizeIp(input: string): string | null {
  const p = parseIp(input);
  if (!p) return null;
  const b = p.bytes;
  if (p.family === 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  const mapped =
    b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 && b[4] === 0 && b[5] === 0 &&
    b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0 && b[10] === 0xff && b[11] === 0xff;
  if (mapped) return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((b[i] << 8) | b[i + 1]) >>> 0).toString(16));
  return groups.join(":");
}

function inCidr(bytes: Uint8Array, t: TrustedProxy): boolean {
  const full = t.prefixBits >> 3;
  const rem = t.prefixBits & 7;
  for (let i = 0; i < full; i++) if (bytes[i] !== t.bytes[i]) return false;
  if (rem > 0) {
    const mask = (0xff << (8 - rem)) & 0xff;
    if ((bytes[full] & mask) !== (t.bytes[full] & mask)) return false;
  }
  return true;
}

/**
 * Parse MCP_TRUSTED_PROXIES: comma-separated bare IPs or CIDRs, v4 and v6, whitespace-tolerant.
 * Throws BridgeConfigError on a malformed entry (boot refuses — a typo must never silently degrade
 * to "trust nothing", which reads as working). "" / undefined → [].
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxy[] {
  if (!raw || raw.trim().length === 0) return [];
  const out: TrustedProxy[] = [];
  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    if (entry.length === 0) continue;
    const slash = entry.lastIndexOf("/");
    const addrPart = slash >= 0 ? entry.slice(0, slash) : entry;
    const prefixPart = slash >= 0 ? entry.slice(slash + 1) : null;
    const parsed = parseIp(addrPart);
    if (!parsed) {
      throw new BridgeConfigError(
        `MCP_TRUSTED_PROXIES entry is not a valid IP or CIDR: "${entry}"`,
      );
    }
    const width = parsed.family === 4 ? 32 : 128;
    let prefixBits = width;
    if (prefixPart !== null) {
      if (!/^\d{1,3}$/.test(prefixPart)) {
        throw new BridgeConfigError(`MCP_TRUSTED_PROXIES entry has a malformed prefix: "${entry}"`);
      }
      prefixBits = Number(prefixPart);
      if (prefixBits > width) {
        throw new BridgeConfigError(
          `MCP_TRUSTED_PROXIES prefix /${prefixBits} exceeds the /${width} address width: "${entry}"`,
        );
      }
    }
    out.push({ family: parsed.family, bytes: parsed.bytes, prefixBits });
  }
  return out;
}

export function isTrustedProxy(ip: string, trusted: readonly TrustedProxy[]): boolean {
  if (trusted.length === 0) return false;
  const norm = normalizeIp(ip);
  const target = parseIp(norm ?? ip);
  if (!target) return false;
  for (const t of trusted) {
    if (t.family !== target.family) continue;
    if (inCidr(target.bytes, t)) return true;
  }
  return false;
}

/** `1.2.3.4:5678` → `1.2.3.4`; `[::1]:5678` → `::1`; a bare address is returned untouched. */
function stripPort(s: string): string {
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    return close > 0 ? s.slice(1, close) : s;
  }
  if (isIP(s) !== 0) return s; // a bare v4 or v6 literal (v6 has many colons — never a port)
  const last = s.lastIndexOf(":");
  if (last > 0 && s.indexOf(":") === last) return s.slice(0, last); // exactly one colon → host:port
  return s;
}

/**
 * The ONE client-identity derivation. Socket peer UNLESS the peer is itself a configured trusted
 * proxy; only then is X-Forwarded-For read, walking RIGHT TO LEFT and skipping trusted hops — the
 * first untrusted entry is the client. An empty or all-trusted chain falls back to the peer.
 *
 * A blindly-trusted forwarded header is a WORSE bug than the one it fixes (any client could forge
 * one and mint unlimited buckets), which is why the peer-must-be-trusted precondition is checked
 * FIRST, why the default list is empty, and why xff[0] — fully attacker-controlled even behind a
 * legitimate proxy — is never used.
 *
 * HONEST SCOPE: with no trusted proxy configured — which is every Funnel deployment, because nothing
 * in that path supplies a client address — this returns ONE CONSTANT for every caller on earth. It
 * is "whatever identity is available", not a guarantee of one.
 */
export function resolveClientIp(req: IncomingMessage, trusted: readonly TrustedProxy[]): string {
  const rawPeer = req.socket?.remoteAddress ?? "";
  const peer = normalizeIp(rawPeer) ?? (rawPeer.length > 0 ? rawPeer : "unknown");
  if (trusted.length === 0) return peer;
  if (!isTrustedProxy(peer, trusted)) return peer;
  const header = req.headers?.["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  if (typeof raw !== "string" || raw.trim().length === 0) return peer;
  const hops = raw.split(",").map((h) => stripPort(h.trim()));
  for (let i = hops.length - 1; i >= 0; i--) {
    const norm = normalizeIp(hops[i]);
    if (!norm) continue; // unparseable hop — never an identity
    if (isTrustedProxy(norm, trusted)) continue; // our own infrastructure
    return norm;
  }
  return peer;
}

/**
 * The ONE validator for a public origin — the whole of MCP_PUBLIC_URL's origin half, extracted so the
 * Console's POST /api/exposure runs the EXACT same rules the boot path runs. A value the Console
 * accepts can therefore never be one the gateway refuses to boot with, and vice versa.
 *
 * Returns the ORIGIN ONLY, never a whole BridgeConfig: `trustedProxies` is an env-side concern this
 * function knows nothing about, and returning a config here would silently drop it.
 *
 * Rules (unchanged from bridgeConfigFromEnv, message for message): parseable URL; https, or http only
 * for localhost/127.0.0.1 dev; no query, no fragment; NO USERINFO and NO PATH (#126, below);
 * CANONICALIZED (host lowercased, default port dropped, trailing slashes trimmed) or the PRM
 * `resource` exact-match silently breaks. Throws BridgeConfigError. Messages name MCP_PUBLIC_URL
 * deliberately — the two paths must not drift, and the env var is still the fallback a headless
 * operator sets.
 *
 * EVERY refusal here is a refusal to REWRITE. `canonicalizeUrl` would happily drop a query, a
 * fragment, a username and a path and hand back something that parses — which is how a value the
 * operator consented to becomes a different value the gateway publishes, with nothing anywhere saying
 * so. The rules above are exactly the set of things it would have silently dropped.
 *
 * THE PATH RULE (#126). Every bridge route is mounted at the origin root, so an accepted path was
 * carried straight into the discovery documents and produced `authorization_endpoint` /
 * `token_endpoint` / `registration_endpoint` values that 404 on this same gateway — with the boot log,
 * both well-knowns and the Console's serving indicator all still green. The only symptom was a vendor
 * error on the far end. `https://<host>/mcp` is the address a user hands an agent and therefore the
 * most natural thing to paste here, which is exactly why it must be refused rather than accepted.
 *
 * REFUSED, not stripped. The address is consent-bearing — `setExposure` re-records consent for the
 * value saved — and silently rewriting a consent-bearing value is the same silent-failure class this
 * rule exists to end. Refusal is legible at write time (the Console renders this message verbatim) and
 * at boot (BridgeConfigError). ACCEPTED LIMITATION, stated rather than pretended: fronting this
 * gateway under a path prefix behind a rewriting reverse proxy is not a supported topology. It never
 * worked; the gate now says so.
 */
export function validatePublicUrl(raw: string): { publicUrl: string } {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BridgeConfigError(`MCP_PUBLIC_URL is not a valid URL: "${value}"`);
  }
  const devLoopback =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !devLoopback) {
    throw new BridgeConfigError(
      `MCP_PUBLIC_URL must be https:// (http is allowed only for localhost/127.0.0.1 dev): "${value}"`,
    );
  }
  if (url.search || url.hash) {
    throw new BridgeConfigError(`MCP_PUBLIC_URL must not carry a query or fragment: "${value}"`);
  }
  // Userinfo, refused BEFORE the path — it changes what the host even is. `https://gw.example@evil.example`
  // parses with hostname `evil.example`, so canonicalization silently published the gateway as the
  // attacker's host; the refusal therefore states the origin that WOULD have been published and stops
  // there, rather than offering `url.origin` as the fix the way the path refusals do. That value is
  // the wrong half of exactly this input, and a correction that hands back the attacker's host is a
  // worse failure than no correction.
  if (url.username || url.password) {
    throw new BridgeConfigError(
      `MCP_PUBLIC_URL must not carry a username or password: "${value}" would publish this gateway as ` +
        `"${url.origin}", because everything before the @ is credentials rather than the host. Save the ` +
        `origin you mean, with no @ in it.`,
    );
  }
  // Trailing slashes are not a path — `https://gw.example///` has always been accepted and canonicalized.
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "") {
    // The one paste worth its own sentence: the MCP URL itself. Naming the corrected origin is the
    // whole point of the refusal — a "no paths allowed" message leaves the user guessing which part
    // of what they pasted to delete.
    if (path === "/mcp") {
      throw new BridgeConfigError(
        `MCP_PUBLIC_URL must be this gateway's origin, not its MCP URL: "${value}" is the address you ` +
          `hand an agent, and this gateway builds it from the origin. Save "${url.origin}" instead.`,
      );
    }
    throw new BridgeConfigError(
      `MCP_PUBLIC_URL must not carry a path: "${value}". Every endpoint this gateway publishes is ` +
        `served at the root, so a path would be advertised to clients and answer nothing. Save ` +
        `"${url.origin}" instead.`,
    );
  }
  const publicUrl = canonicalizeUrl(value);
  if (publicUrl === null) throw new BridgeConfigError(`MCP_PUBLIC_URL is not a valid URL: "${value}"`);
  return { publicUrl };
}

/**
 * Parse + validate MCP_PUBLIC_URL (and MCP_TRUSTED_PROXIES, which is meaningless without it).
 * unset/empty → null (bridge OFF). Set-but-invalid → throws BridgeConfigError (boot uses this to
 * refuse to start). The origin half delegates to validatePublicUrl — same rules, same messages, same
 * thrown type, so boot behaviour is byte-identical to before that extraction.
 */
export function bridgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeConfig | null {
  const raw = env.MCP_PUBLIC_URL?.trim();
  if (!raw) return null;
  return {
    ...validatePublicUrl(raw),
    trustedProxies: parseTrustedProxies(env.MCP_TRUSTED_PROXIES),
  };
}

/**
 * The runtime gate (never throws): the active config, or null when unset OR invalid. Fail-closed —
 * an invalid value behaves as OFF here (boot already refused; this guards direct callers).
 */
export function activeBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig | null {
  try {
    return bridgeConfigFromEnv(env);
  } catch {
    return null;
  }
}

// ── Resolution: DB first, env fallback, fail-closed (console-exposure-surface, ADR 0035 §D1) ─────
//
// The public URL is a Console-owned setting stored in `gateway_exposure`; MCP_PUBLIC_URL remains the
// fallback for headless/compose operators. A DB row WINS when present. With neither, exposure is off
// and every bridge path 404s — ADR 0035 §D2's promise, now stated over both sources.
//
// A DB-sourced setting may NEVER refuse boot (§Scope decision 3): a button that bricks the gateway is
// the #97 vault-gate shape. resolveBridgeConfig therefore never throws; it reports a `problem` and the
// caller logs and continues with the bridge OFF. The "is there an MCP edge to publish?" check moved to
// WRITE time (POST /api/exposure) where a refusal is legible.

export type BridgeSource = "db" | "env";
export type BridgeProblem = "db_unreadable" | "db_invalid" | "env_invalid";

export interface ResolvedBridge {
  cfg: BridgeConfig | null;
  source: BridgeSource | null;
  /** Set iff a setting existed but could not be used. cfg is null whenever this is set. */
  problem: BridgeProblem | null;
}

/**
 * DB-first, env-fallback, FAIL-CLOSED, and it NEVER throws.
 *
 * A DB fault yields {cfg:null, problem:"db_unreadable"} and does NOT fall through to env: "the row
 * could not be read" and "there is no row" are different facts and collapsing them would publish a
 * gateway from a stale env var the operator believes they replaced (or, worse, hide that the setting
 * is unreadable behind a plain "off").
 *
 * `trustedProxies` is read from the environment on BOTH branches — it is a property of how the edge is
 * fronted, not of where the address came from, and dropping it on the DB branch would silently revert
 * public-edge-hardening's client-identity fix on exactly the path this unit creates. A malformed
 * MCP_TRUSTED_PROXIES alongside a valid row therefore also reports "db_invalid"; that is a coarse
 * label for a rare env typo, and it is still fail-closed (nothing publishes).
 */
export async function resolveBridgeConfig(): Promise<ResolvedBridge> {
  let row: { publicUrl: string } | null;
  try {
    row = await getExposure();
  } catch {
    return { cfg: null, source: null, problem: "db_unreadable" };
  }

  if (row) {
    try {
      const { publicUrl } = validatePublicUrl(row.publicUrl);
      const trustedProxies = parseTrustedProxies(process.env.MCP_TRUSTED_PROXIES);
      return { cfg: { publicUrl, trustedProxies }, source: "db", problem: null };
    } catch {
      // A row written by a different build (or an env typo beside it) must not brick the gateway and
      // must not silently downgrade to the env var either.
      return { cfg: null, source: "db", problem: "db_invalid" };
    }
  }

  try {
    const cfg = bridgeConfigFromEnv();
    if (!cfg) return { cfg: null, source: null, problem: null };
    return { cfg, source: "env", problem: null };
  } catch {
    return { cfg: null, source: "env", problem: "env_invalid" };
  }
}

// ── What THIS process actually mounted ───────────────────────────────────────────
//
// Noted from src/index.ts at the ONE real mount point and NOWHERE else — in particular NOT from
// bridgeRoutes(), which several test files call at describe scope: a note in there would leak a live
// config into the fail-closed cells and turn "the bridge tables are never consulted" into a pool query
// with no database. Default (never called) = null = nothing is being served, which is the truth when
// the bridge is off, when the MCP edge never started, and in every test.
//
// Nothing clears the note on edge close, deliberately: a single-process gateway mounts at most one
// bridge, and "what was mounted after teardown" is not a question the product asks.
let mounted: BridgeConfig | null = null;

/** Record what this process mounted. Called ONLY from the composition root (src/index.ts). */
export function noteBridgeMount(cfg: BridgeConfig | null): void {
  mounted = cfg;
}

/** What THIS process mounted, or null when nothing is being served. */
export function mountedBridgeConfig(): BridgeConfig | null {
  return mounted;
}

/**
 * The ONE gate on bridge-token resolution: is this process serving the bridge?
 *
 * Mounted config first — a gateway published from the Console has no environment variable describing
 * it, and the pre-exposure env-only test would have mounted the bridge, completed a whole OAuth flow,
 * handed the client a token, and then 401'd that token on every call. The `|| activeBridgeConfig()`
 * term keeps an env-configured gateway byte-identical to before, including the OFF-gate assertions
 * (env unset, never mounted → both null → false → the bridge tables are never touched).
 */
export function bridgeTokensAcceptable(): boolean {
  return mountedBridgeConfig() != null || activeBridgeConfig() != null;
}

// ── Pinned generation + lifetimes ────────────────────────────────────────────────

export const BRIDGE_ACCESS_TOKEN_PREFIX = "pcgat_";
const CODE_PREFIX = "pcgac_";
const REFRESH_PREFIX = "pcgrt_";

const ACCESS_TTL_SEC = 3600; // expires_in — pinned by the endpoint contract
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sliding 30d idle window, capped by grant expiry
const CODE_TTL_MS = 5 * 60 * 1000;
const CSRF_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

/** Hard cap on live DCR clients. Reaching it EVICTS the oldest credential-less client (ADR 0035
 *  §D3 item 2) — refusing here would be an anonymous, permanent DoS against the box owner. */
export const CLIENT_CAP = 50;
/** Fixed advisory-lock key for the cap-count → evict → insert critical section. */
const CLIENT_CAP_LOCK_KEY = 774_821_309;

// ── One plain rate limiter, sized for availability ───────────────────────────────
//
// ONE token bucket per resolved identity, shared by /register, both /authorize methods and /token.
// No tiers, no reserved pools, no global backstop — every one of those was an attempt to guarantee
// the owner gets through, and behind Funnel (where every caller resolves to one identity, and the
// owner's own flow passes through anonymous steps) each became another lever a stranger could pull.
// See the file header: that guarantee is unachievable here and is not attempted.
//
// SIZING IS FOR AVAILABILITY, NOT DEFENCE. Legitimate use is one connection setup every few weeks
// (≈4 requests) plus roughly one /token refresh per hour per connection, so 120/min is four orders
// of magnitude of headroom, while still bounding an accidental client retry storm and keeping the
// bucket map from being the memory bound. BE HONEST ABOUT WHAT THIS IS: with no trusted proxy —
// every Funnel deployment — this degrades to a single global 120/min limit for the whole edge.
//
// Discovery (GET /.well-known/* ×3) is deliberately UNMETERED: static JSON, no DB, no audit, no
// mutable state. Limiting a vendor fleet's cold-start discovery costs availability and buys nothing.
export const BRIDGE_RATE_CAPACITY = 120;
export const BRIDGE_RATE_REFILL_PER_MIN = 120;
export const BUCKET_MAX_KEYS = 10_000;

/**
 * THE ONE GUARD THAT MATTERS, and the only one that works without client identity: a counting
 * semaphore in front of every bridge DB touch. Its job is not fairness — it is preventing the public
 * port from exhausting the shared pool (`src/db.ts:9`'s `max: 10`) that the loopback admin edge
 * depends on. At 4, REST, admin, audit-flush and the scheduler always keep ≥6 connections no matter
 * what arrives on the public port. Anchored here so a later pool resize is caught by review.
 */
export const BRIDGE_DB_CONCURRENCY = 4;

/**
 * Deny-audit throttle (ADR 0035 §D3 item 5), SPLIT BY COST-TO-TRIGGER.
 *
 * One shared window across every deny reason is itself an exhaustible pool: a flood of the cheapest
 * denial (an unknown `client_id` — free to generate) would buy silence on the most valuable one
 * (a refused agent key = someone guessing the owner's credential). So:
 *   - CHEAP denials (anything an anonymous stranger can generate at will) share this small budget,
 *     and whatever is suppressed leaves ONE aggregated row so the FACT of a flood survives;
 *   - HIGH-VALUE denials are NOT throttled at all. An event you would suppress for being frequent is
 *     an event whose frequency IS the alarm. Their volume is bounded by the per-identity limiter and
 *     by the fact that reaching them requires already holding something.
 */
export const BRIDGE_DENY_AUDIT_CAP = 30;
export const BRIDGE_DENY_AUDIT_WINDOW_MS = 60_000;

/** GC cadence (hygiene, never revocation — deadness is enforced at the expiry instant). */
export const GC_INTERVAL_MS = 15 * 60 * 1000;

/** IDENTICAL refusal wording for unknown/revoked/expired keys — the page is never an oracle. */
const KEY_REFUSAL_WORDING = "That agent key was not accepted. Check the key in the Console and try again.";

/**
 * Deliberately DISTINCT from KEY_REFUSAL_WORDING, and NOT an oracle: this message is reachable only
 * by someone who already presented a VALID key, so it distinguishes nothing an attacker did not
 * already hold. Reusing "not accepted" for a perfectly good key would be an unfixable support failure.
 */
const KEY_NO_EXPIRY_WORDING =
  "This agent key never expires. Keys used with a cloud client must have an expiry — mint or rotate a key with a 30/90/365-day expiry in the Console, then try again.";

const TOO_MANY_ATTEMPTS_WORDING = "Too many attempts. Wait a minute and try again.";
const BUSY_WORDING = "The gateway is busy right now. Try again in a moment.";

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function mintSecret(prefix: string): { value: string; hash: string } {
  const value = prefix + randomBytes(32).toString("base64url");
  return { value, hash: sha256Hex(value) }; // prefix included in the preimage (pinned)
}

// ── The rate limiter ─────────────────────────────────────────────────────────────

interface TokenBucket {
  tokens: number;
  last: number;
  /** Monotonic touch sequence — recency ORDER, deliberately not a clock reading: two touches in the
   *  same millisecond must still be orderable, or the LRU sweep degenerates into an arbitrary one. */
  touched: number;
}

export interface RateLimiter {
  /** true = admitted (a token charged); false = refused (nothing charged). */
  take(identity: string): boolean;
  /** Test/diagnostic: live per-identity key count. */
  keyCount(): number;
}

function refillBucket(b: TokenBucket, capacity: number, perMin: number, nowMs: number): void {
  b.tokens = Math.min(capacity, b.tokens + ((nowMs - b.last) / 60_000) * perMin);
  b.last = nowMs;
}

/**
 * A plain per-identity token-bucket limiter. One instance serves the whole bridge.
 *
 * The bucket map's memory bound is the one subtlety worth keeping: a blanket `clear()` at the cap
 * would hand EVERY limited source a fresh full burst, so key churn would reset the limiter. Instead:
 * first drop entries that have refilled to full (they carry no state — dropping them is identical to
 * keeping them), then, if still over, drop least-recently-touched until at 90%.
 */
export function createRateLimiter(opts: {
  capacity: number;
  refillPerMin: number;
  maxKeys?: number;
  now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? BUCKET_MAX_KEYS;
  const buckets = new Map<string, TokenBucket>();
  let touchSeq = 0;

  function evict(nowMs: number): void {
    if (buckets.size < maxKeys) return;
    for (const [k, b] of buckets) {
      refillBucket(b, opts.capacity, opts.refillPerMin, nowMs);
      if (b.tokens >= opts.capacity) buckets.delete(k);
    }
    const target = Math.floor(maxKeys * 0.9);
    if (buckets.size <= target) return;
    const byAge = [...buckets.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (const [k] of byAge) {
      if (buckets.size <= target) break;
      buckets.delete(k);
    }
  }

  return {
    take(identity: string): boolean {
      const nowMs = now();
      evict(nowMs);
      let b = buckets.get(identity);
      if (!b) {
        b = { tokens: opts.capacity, last: nowMs, touched: 0 };
        buckets.set(identity, b);
      }
      b.touched = ++touchSeq;
      refillBucket(b, opts.capacity, opts.refillPerMin, nowMs);
      if (b.tokens < 1) return false; // a refusal charges nothing
      b.tokens -= 1;
      return true;
    },
    keyCount(): number {
      return buckets.size;
    },
  };
}

// ── Small HTTP helpers (the bridge owns its own body/response plumbing) ──────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a token/authorize POST body: form-encoded is the contract (JSON-only parsing is the
 *  documented claude.ai 415 failure); a JSON content-type is tolerated as a convenience. */
function parseFormBody(req: IncomingMessage, raw: string): Record<string, string> {
  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("json")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function oauthError(
  res: ServerResponse,
  status: number,
  error: string,
  description?: string,
  extraHeaders: Record<string, string> = {},
): void {
  sendJson(res, status, description ? { error, error_description: description } : { error }, extraHeaders);
}

const htmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Every page response carries the clickjacking denials (X-Frame-Options + CSP frame-ancestors). */
function sendPage(
  res: ServerResponse,
  status: number,
  html: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(html);
}

// ── Redirect-URI policy (pinned end-to-end) ──────────────────────────────────────

/**
 * Is this URL host the local machine? A RANGE test, not a three-string allowlist: the whole of
 * 127.0.0.0/8 is loopback (`http://127.0.0.2:8787/api/export` reaches the same admin edge as
 * `127.0.0.1`), `::1` is loopback in every bracket/zone spelling, `::ffff:127.x.x.x` is the mapped
 * form of the same range, and RFC 6761 makes `localhost` AND every `*.localhost` name resolve to
 * loopback in browsers. An allowlist of three literals let every one of those fall through the
 * confused-deputy guard below.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const p = parseIp(h); // strips [] brackets and any zone id
  if (!p) return false;
  if (p.family === 4) return p.bytes[0] === 127;
  const b = p.bytes;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false;
  if (b[10] === 0xff && b[11] === 0xff) return b[12] === 127; // ::ffff:127.0.0.0/8
  return b[10] === 0 && b[11] === 0 && b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 1; // ::1
}

/**
 * The gateway's OWN route namespace. A genuine loopback OAuth callback never lives under it, and a
 * browser 302 carrying `code`/`state` aimed at one of these turns approval into a confused deputy
 * pointed at the `localOnly` admin surface (ADR 0035 §D3 item 4).
 */
const RESERVED_LOOPBACK_PATHS = /^\/(api|admin|healthz|mcp|authorize|token|register)(\/|$)/i;

function loopbackPathIsReserved(u: URL): boolean {
  const forms = [u.pathname];
  try {
    forms.push(decodeURIComponent(u.pathname)); // defeat /%61pi/export
  } catch {
    return true; // a malformed escape is never a legitimate callback
  }
  // No dot-segment arm: WHATWG `URL` resolves `..`/`.` at parse time, so `u.pathname` can never
  // contain one — an arm that cannot fire is worse than no arm (it reads as a guard and is not).
  return forms.some((p) => RESERVED_LOOPBACK_PATHS.test(p));
}

/**
 * Registration-time rule: https anywhere, or http on a loopback host — and, for EITHER scheme, never
 * aimed at a loopback host inside the gateway's own route namespace.
 *
 * The scheme is not what makes the confused deputy work; the LOOPBACK TARGET is. `https://localhost/
 * api/export` is the identical attack over TLS (the browser follows the 302 to the loopback origin
 * exactly the same way), so the reserved-path guard is host-scoped, not scheme-scoped.
 */
export function isRegistrableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.hostname.length === 0) return false;
  if (isLoopbackHost(u.hostname)) return !loopbackPathIsReserved(u);
  return u.protocol === "https:"; // a non-loopback host is https-only
}

/**
 * Authorize-time match: every component byte-equal EXCEPT the port, which is ignored for http on a
 * loopback HOST (Claude Code declares both localhost and 127.0.0.1 forms with ephemeral ports).
 * Anything non-loopback must be byte-equal.
 *
 * BOTH sides must independently pass isRegistrableRedirectUri FIRST — that neutralizes any
 * dangerous client row planted in a live DB before this guard shipped, which is why no migration is
 * needed. The `registered === presented` fast path MUST stay below it, or a byte-identical
 * dangerous pair still matches.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (!isRegistrableRedirectUri(registered) || !isRegistrableRedirectUri(presented)) return false;
  if (registered === presented) return true;
  let r: URL, p: URL;
  try {
    r = new URL(registered);
    p = new URL(presented);
  } catch {
    return false;
  }
  if (r.protocol !== "http:" || p.protocol !== "http:") return false;
  if (!isLoopbackHost(r.hostname) || r.hostname !== p.hostname) return false;
  // Port ignored; every other component still byte-equal.
  return (
    r.pathname === p.pathname &&
    r.search === p.search &&
    r.hash === p.hash &&
    r.username === p.username &&
    r.password === p.password
  );
}

// ── Resolution (the RS surface) ──────────────────────────────────────────────────

interface BridgeTokenRow {
  access_expires_at: Date;
  user_id: string;
  agent_id: string;
  sectors: string[] | null;
  revoked_at: Date | null;
  grant_expires_at: Date | null;
}

/**
 * Resolve a presented bridge ACCESS token → AuthContext, or null when it is not a (known) bridge
 * token (fall through to the static-key resolve). JOINS agent_grants: the grant row is the living
 * authority — denies (reason 'revoked'/'expired') when the grant is revoked/expired or the token is
 * past access_expires_at, regardless of row retention (GC is hygiene, never revocation). Config-
 * gated fail-closed: with the bridge OFF this never touches the bridge tables.
 *
 * Deliberately NOT slot-guarded (ADR 0035 §D3 item 3): this is the bearer-authenticated /mcp path,
 * not an anonymous public route — guarding it would let anonymous /token traffic 503 a real agent.
 */
export async function resolveBridgeToken(token: string): Promise<AuthContext | null> {
  if (!token.startsWith(BRIDGE_ACCESS_TOKEN_PREFIX)) return null;
  if (!bridgeTokensAcceptable()) return null; // OFF → inert, tables never consulted
  const res = await pool.query<BridgeTokenRow>(
    `select t.access_expires_at, g.user_id, g.agent_id, g.sectors, g.revoked_at,
            g.expires_at as grant_expires_at
       from oauth_bridge_tokens t
       join agent_grants g on g.id = t.agent_grant_id
      where t.access_hash = $1`,
    [sha256Hex(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.revoked_at != null) throw new AccessDenied(undefined, "revoked");
  const now = Date.now();
  const grantExp = row.grant_expires_at ? new Date(row.grant_expires_at).getTime() : null;
  const accessExp = new Date(row.access_expires_at).getTime();
  if (grantExp != null && grantExp <= now) throw new AccessDenied(undefined, "expired");
  if (accessExp <= now) throw new AccessDenied(undefined, "expired");

  const sectors: string[] = Array.isArray(row.sectors) ? row.sectors : [];
  const grantedSectors = sectors.includes("*")
    ? new Set(ALL_SECTORS)
    : new Set(sectors.filter((s) => ALL_SECTORS.includes(s)));
  const expiresAt = new Date(grantExp != null ? Math.min(accessExp, grantExp) : accessExp);
  return { userId: row.user_id, agentId: row.agent_id, grantedSectors, expiresAt };
}

// ── Lifecycle helpers ────────────────────────────────────────────────────────────

/** Minimal queryable so both the pool and a transaction client fit. */
interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Rotation-kill: replacing a grant's key_hash (the admin mint-upsert / rotate path) MUST delete
 * that grant's bridge codes + tokens IN THE SAME TRANSACTION — rotation is the compromise response;
 * derived credentials die with the key (the FK cascade never fires there because the row survives).
 * admin.ts's mint route calls this with its transaction client.
 */
export async function killBridgeRowsForGrant(client: Queryable, agentGrantId: string): Promise<void> {
  await client.query(`delete from oauth_bridge_codes where agent_grant_id = $1`, [agentGrantId]);
  await client.query(`delete from oauth_bridge_tokens where agent_grant_id = $1`, [agentGrantId]);
}

/**
 * GC sweep (owned interval, started at bridge mount by the http edge; torn down in close()).
 * HYGIENE ONLY — deadness is enforced at the expiry instant by resolution + /token regardless of
 * row retention. Consumed/expired codes go immediately; token rows 7 days after refresh expiry
 * (forensic window); client rows only when ≥90d unused AND holding no token rows.
 */
export async function gcBridgeRows(): Promise<void> {
  await pool.query(`delete from oauth_bridge_codes where consumed_at is not null or expires_at <= now()`);
  await pool.query(`delete from oauth_bridge_tokens where refresh_expires_at <= now() - interval '7 days'`);
  await pool.query(
    `delete from oauth_bridge_clients c
      where coalesce(c.last_used_at, c.created_at) < now() - interval '90 days'
        and not exists (select 1 from oauth_bridge_tokens t where t.client_id = c.client_id)`,
  );
}

/** Delete a token row's whole rotation chain (walk rotated_from both directions) — the RFC 9700
 *  response to a rotated-out refresh being presented. */
async function deleteTokenFamily(client: Queryable, tokenRowId: string): Promise<void> {
  await client.query(
    `with recursive fam as (
       select id, rotated_from from oauth_bridge_tokens where id = $1
       union
       select t.id, t.rotated_from
         from oauth_bridge_tokens t
         join fam on t.rotated_from = fam.id or t.id = fam.rotated_from
     )
     delete from oauth_bridge_tokens where id in (select id from fam)`,
    [tokenRowId],
  );
}

// ── The route map ────────────────────────────────────────────────────────────────

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
}

interface CodeRow {
  id: string;
  client_id: string;
  agent_grant_id: string;
  code_challenge: string;
  redirect_uri: string;
  resource: string | null;
  expires_at: Date;
}

interface GrantRow {
  id: string;
  user_id: string;
  agent_id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
}

interface CsrfEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

/** The fields of an authorize request the page round-trips (all validated server-side on POST). */
interface AuthorizeParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  resource: string | null;
}

// ── The published surface (ADR 0035 §D6) ─────────────────────────────────────────
//
// A whole-port Funnel on the MCP edge publishes EXACTLY this set and nothing else: the bridge's seven
// route-map entries plus /mcp. Path-scoped exposure is impossible (a vendor's fleet must fetch
// discovery, /register and /token anonymously, before any credential exists), so the honest thing is
// to state the whole set and what guards each one. The Console renders its "what a stranger can reach"
// disclosure FROM THIS ARRAY — never from a hardcoded list — and a set-equality test pins it against
// the live route map, so a new bridge route cannot ship without appearing in the disclosure.

/** How a published route is guarded — the vocabulary ADR 0035 §D6 describes in prose. */
export type BridgeRouteAuth =
  | "open_no_user_data" // static discovery JSON, and the sign-in page itself
  | "open_write" // the unauthenticated write (DCR) — §D6's "one"
  | "code_gated" // needs a valid single-use code bound to a PKCE verifier
  | "key_login" // the agent-key login
  | "bearer_gated"; // /mcp itself

export interface BridgeRouteDescriptor {
  readonly path: string;
  readonly methods: readonly string[];
  readonly auth: BridgeRouteAuth;
}

/**
 * The COMPLETE set a whole-port Funnel publishes. Seven mirror the map bridgeRoutes returns; the
 * eighth is /mcp, which src/mcp/http.ts serves and the bridge map does not contain.
 *
 * NOTE for the record, because two documents disagree in prose: §D6 (as corrected 2026-07-25) counts
 * THREE static-JSON routes — the protected-resource document served at BOTH its paths, plus the
 * authorization-server document. There are FOUR `open_no_user_data` descriptors here, because the
 * fourth is GET /authorize, which is HTML rather than JSON but still carries no data about the user.
 * The count of eight is right in both; this list is the precise form and the Console renders from it.
 */
export const PUBLISHED_ROUTES: readonly BridgeRouteDescriptor[] = [
  { path: "/.well-known/oauth-protected-resource", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/.well-known/oauth-protected-resource/mcp", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/.well-known/oauth-authorization-server", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/register", methods: ["POST"], auth: "open_write" },
  { path: "/authorize", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/authorize", methods: ["POST"], auth: "key_login" },
  { path: "/token", methods: ["POST"], auth: "code_gated" },
  { path: "/mcp", methods: ["POST", "GET", "DELETE"], auth: "bearer_gated" },
];

/**
 * Build the bridge endpoint map (mounted by the http edge ONLY when the bridge is enabled). All
 * in-memory state (CSRF store, rate-limit buckets, the DB-slot counter, the deny-audit window)
 * lives in this closure — one instance per edge.
 *
 * PURE with respect to process state: it must never note a mount (see noteBridgeMount) — several test
 * files build a route map at describe scope, and a note here would make every one of them look like a
 * published gateway.
 */
export function bridgeRoutes(cfg: BridgeConfig, deps?: BridgeDeps): Map<string, Handler> {
  const db: BridgePool = deps?.pool ?? (pool as unknown as BridgePool);
  const now: () => number = deps?.now ?? Date.now;
  const trusted: readonly TrustedProxy[] = cfg.trustedProxies ?? [];
  // The MCP endpoint, stated once. Appending is only correct because `publicUrl` is a bare origin —
  // validatePublicUrl refuses a path, so a pasted `https://host/mcp` can never reach here and double
  // it (#126). Every absolute URL below is built the same way, and oauth-bridge.discovery.test.ts
  // asserts each one resolves on the edge that served it.
  const canonicalResource = `${cfg.publicUrl}/mcp`;
  const csrfStore = new Map<string, CsrfEntry>();

  // ONE limiter for the whole bridge, keyed on whatever identity is available. Discovery routes are
  // deliberately unmetered. Behind Funnel `identify` returns one constant, so this is in practice a
  // single global 120/min budget — stated plainly rather than dressed up as per-caller fairness.
  const limiter = createRateLimiter({
    capacity: BRIDGE_RATE_CAPACITY,
    refillPerMin: BRIDGE_RATE_REFILL_PER_MIN,
    now,
  });

  const identify = (req: IncomingMessage): string => resolveClientIp(req, trusted);

  // ── The DB semaphore — the guard that actually holds ──
  // A counting semaphore in FRONT of every bridge DB touch bounds the bridge's draw on the shared
  // pool BY CONSTRUCTION, independent of limiter tuning AND independent of client identity. That is
  // why it survived the simplification while every allocation scheme did not: it does not need to
  // tell the owner from an attacker to keep the public port off the private edge's connections.
  // NO QUEUEING: over the limit is an immediate 503 and pool.connect()/query() are never called —
  // queueing under flood just relocates the starvation into the event loop.
  let dbInUse = 0;

  function sendBusy(res: ServerResponse, kind: "json" | "page"): void {
    if (kind === "json") {
      oauthError(res, 503, "temporarily_unavailable", "the gateway is busy — retry shortly", {
        "retry-after": "1",
      });
    } else {
      errorPage(res, 503, BUSY_WORDING, { "retry-after": "1" });
    }
  }

  async function withDbSlot(
    res: ServerResponse,
    kind: "json" | "page",
    fn: () => Promise<void>,
  ): Promise<void> {
    if (dbInUse >= BRIDGE_DB_CONCURRENCY) {
      sendBusy(res, kind);
      return;
    }
    dbInUse += 1;
    try {
      await fn();
    } finally {
      dbInUse -= 1;
    }
  }

  function issueCsrf(entry: Omit<CsrfEntry, "expiresAt">): string {
    // Opportunistic purge so the store stays bounded without a timer.
    const nowMs = now();
    for (const [k, v] of csrfStore) if (v.expiresAt <= nowMs) csrfStore.delete(k);
    const token = randomBytes(32).toString("base64url");
    csrfStore.set(token, { ...entry, expiresAt: nowMs + CSRF_TTL_MS });
    return token;
  }

  /** Single-use consume, bound to the exact (client_id, redirect_uri, code_challenge) it was rendered for. */
  function consumeCsrf(token: string, entry: Omit<CsrfEntry, "expiresAt">): boolean {
    const found = csrfStore.get(token);
    csrfStore.delete(token); // single-use regardless of outcome
    if (!found || found.expiresAt <= now()) return false;
    return (
      found.clientId === entry.clientId &&
      found.redirectUri === entry.redirectUri &&
      found.codeChallenge === entry.codeChallenge
    );
  }

  async function lookupClient(clientId: string | null): Promise<ClientRow | null> {
    if (!clientId) return null;
    const res = await db.query(
      `select client_id, client_name, redirect_uris from oauth_bridge_clients where client_id = $1`,
      [clientId],
    );
    return (res.rows[0] as ClientRow | undefined) ?? null;
  }

  // ── Deny audit, throttled at the SOURCE (ADR 0035 §D3 item 5) ──
  // Enqueue-time, in-memory, synchronous: nothing is awaited, nothing moves onto the response hot
  // path, no confirmation prompt is added — audit stays async and detective.
  let denyWindowStart = 0;
  let denyCount = 0;
  let denyOverflow = 0;

  function emitDeny(reason: string, extra?: Record<string, unknown>): void {
    audit({
      userId: null,
      agentId: null,
      tool: "oauth_token",
      decision: "deny",
      denyReason: reason,
      args: extra,
    });
  }

  /** Roll the window if it has elapsed, flushing the ONE aggregated row that keeps the FACT of a
   *  flood on the record even when the individual rows did not survive. Driven by denials of BOTH
   *  classes, so a high-value denial after a cheap flood still lands the summary. */
  function rollDenyWindow(nowMs: number): void {
    if (nowMs - denyWindowStart < BRIDGE_DENY_AUDIT_WINDOW_MS) return;
    if (denyOverflow > 0) {
      emitDeny(`throttled: ${denyOverflow} further bridge denials suppressed`);
    }
    denyWindowStart = nowMs;
    denyCount = 0;
    denyOverflow = 0;
  }

  /**
   * CHEAP denial — anything an anonymous stranger can generate for free (an unknown client_id, a
   * mismatched redirect, a malformed authorize request, a stale CSRF form, a bad code/refresh
   * token). These share the small budget; the surplus is coalesced into one row.
   */
  function auditBridgeDeny(reason: string, extra?: Record<string, unknown>): void {
    const nowMs = now();
    rollDenyWindow(nowMs);
    if (denyCount >= BRIDGE_DENY_AUDIT_CAP) {
      denyOverflow += 1;
      return;
    }
    denyCount += 1;
    emitDeny(reason, extra);
  }

  /**
   * HIGH-VALUE denial — NEVER throttled, and never charged against the cheap budget either (in
   * EITHER direction: a cheap flood cannot suppress these, and these cannot suppress each other).
   *
   * These are the events whose frequency is itself the alarm: someone guessing the owner's agent
   * key, a key that must not reach a cloud client, an authorization code replayed, a rotated-out
   * refresh token presented (RFC 9700 — the signal that a token was stolen). Suppressing one because
   * it happened a lot is deleting exactly the evidence of the attack. Their volume is bounded by the
   * per-identity limiter, not by silence.
   */
  function auditBridgeDenyHighValue(reason: string, extra?: Record<string, unknown>): void {
    rollDenyWindow(now());
    emitDeny(reason, extra);
  }

  // ── Pages ──

  function errorPage(
    res: ServerResponse,
    status: number,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    sendPage(
      res,
      status,
      // The product renamed to Postern on 2026-07-12 (docs/design/naming-2026.md 🔒). This is a
      // page a user lands on mid-OAuth, whose whole job is to look legitimate enough to trust
      // (ADR 0029 §7 makes that an anti-phishing control) — a product name matching nothing else
      // they have seen undercuts it. Display string only: no behaviour hangs off this title (#109).
      `<!doctype html><html><head><meta charset="utf-8"><title>Postern</title></head>` +
        `<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
        `<h1 style="font-size:1.2rem">Cannot continue</h1><p>${htmlEscape(message)}</p></body></html>`,
      extraHeaders,
    );
  }

  function authorizePage(
    res: ServerResponse,
    status: number,
    client: ClientRow,
    p: AuthorizeParams,
    opts: { error?: string } = {},
  ): void {
    const csrf = issueCsrf({
      clientId: client.client_id,
      redirectUri: p.redirectUri ?? "",
      codeChallenge: p.codeChallenge ?? "",
    });
    // The FULL destination (origin + path), never the origin alone: `http://localhost` reads as
    // SAFE, and the PATH is where a confused deputy would be aimed.
    let destination = "";
    try {
      const du = new URL(p.redirectUri ?? "");
      destination = `${du.origin}${du.pathname}`;
    } catch {
      destination = p.redirectUri ?? "";
    }
    const clientName = client.client_name?.trim() || "An unnamed client";
    const hidden = (name: string, value: string | null): string =>
      value == null ? "" : `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`;
    // Anti-phishing display (mandatory): the requesting client's registered name + the redirect
    // destination — unauthenticated DCR means anyone can register a client and lure the operator
    // here; showing WHERE the sign-in code goes is the one defense the human can exercise.
    sendPage(
      res,
      status,
      `<!doctype html><html><head><meta charset="utf-8"><title>Authorize agent access</title></head>` +
        `<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
        `<h1 style="font-size:1.2rem">Authorize agent access</h1>` +
        `<p><strong>${htmlEscape(clientName)}</strong> is asking to connect to your gateway.</p>` +
        `<p>Approving sends a sign-in code to <strong>${htmlEscape(destination)}</strong>. ` +
        `If you did not start this from that app, close this page.</p>` +
        (opts.error ? `<p style="color:#b00020">${htmlEscape(opts.error)}</p>` : "") +
        `<form method="post" action="${htmlEscape(cfg.publicUrl)}/authorize">` +
        hidden("csrf", csrf) +
        hidden("response_type", p.responseType) +
        hidden("client_id", client.client_id) +
        hidden("redirect_uri", p.redirectUri) +
        hidden("state", p.state) +
        hidden("code_challenge", p.codeChallenge) +
        hidden("code_challenge_method", p.codeChallengeMethod) +
        hidden("resource", p.resource) +
        `<label>Paste an agent key from the Console<br>` +
        `<input type="password" name="key" autocomplete="off" style="width:100%" autofocus></label><br><br>` +
        `<button type="submit">Approve</button>` +
        `</form></body></html>`,
    );
  }

  /** 302 back to the VALIDATED redirect_uri with error (+ state verbatim when the client sent it) + iss. */
  function redirectError(
    res: ServerResponse,
    redirectUri: string,
    error: string,
    description: string,
    state: string | null,
  ): void {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state != null) url.searchParams.set("state", state);
    url.searchParams.set("iss", cfg.publicUrl);
    res.writeHead(302, { location: url.toString(), "cache-control": "no-store" });
    res.end();
  }

  /** The post-redirect-validation checks shared by GET (render) and POST (mint). Returns an OAuth
   *  error to 302 back with, or null when the request is well-formed. */
  function validateAuthorizeRequest(p: AuthorizeParams): { error: string; description: string } | null {
    if (p.responseType !== "code") {
      return { error: "unsupported_response_type", description: "response_type must be 'code'" };
    }
    // PKCE S256-only: absent challenge refused; absent method = RFC 7636 plain default — refused too.
    if (!p.codeChallenge) {
      return { error: "invalid_request", description: "code_challenge is required (PKCE S256)" };
    }
    if (p.codeChallengeMethod !== "S256") {
      return {
        error: "invalid_request",
        description: "code_challenge_method must be 'S256' (plain is not accepted)",
      };
    }
    // Both sides canonicalized: a capitalised host or an explicit :443 is the SAME resource.
    if (p.resource != null && !resourceMatches(p.resource, canonicalResource)) {
      return { error: "invalid_target", description: `resource must be ${canonicalResource}` };
    }
    return null;
  }

  function authorizeParamsFrom(get: (k: string) => string | null): AuthorizeParams {
    return {
      responseType: get("response_type"),
      clientId: get("client_id"),
      redirectUri: get("redirect_uri"),
      state: get("state"),
      codeChallenge: get("code_challenge"),
      codeChallengeMethod: get("code_challenge_method"),
      resource: get("resource"),
    };
  }

  // ── Handlers ──

  const prmHandler: Handler = async (_req, res) => {
    sendJson(res, 200, {
      resource: canonicalResource,
      authorization_servers: [cfg.publicUrl],
      bearer_methods_supported: ["header"],
    });
  };

  const asMetadataHandler: Handler = async (_req, res) => {
    // The FULL RFC 8414 document — every field load-bearing for client discovery.
    sendJson(res, 200, {
      issuer: cfg.publicUrl,
      authorization_endpoint: `${cfg.publicUrl}/authorize`,
      token_endpoint: `${cfg.publicUrl}/token`,
      registration_endpoint: `${cfg.publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  };

  /**
   * Registration EVICTS at the cap; it never refuses an owner out of their own connector.
   * Count → evict → insert run in ONE transaction under a fixed advisory lock, so two concurrent
   * registrations cannot both blow past the cap. Victims are clients holding NO live token row,
   * oldest-first by coalesce(last_used_at, created_at) — a connected client is never evicted, and a
   * stranger holding no credential can only ever evict other credential-less registrations.
   */
  async function registerClientRow(res: ServerResponse, uris: string[], clientName: string | null): Promise<void> {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(`select pg_advisory_xact_lock($1::bigint)`, [CLIENT_CAP_LOCK_KEY]);
      const cap = await client.query(`select count(*)::int as n from oauth_bridge_clients`);
      const live = (cap.rows[0] as { n: number }).n;
      if (live >= CLIENT_CAP) {
        const need = live - CLIENT_CAP + 1;
        const victims = await client.query(
          `select c.client_id from oauth_bridge_clients c
            where not exists (
              select 1 from oauth_bridge_tokens t
               where t.client_id = c.client_id and t.refresh_expires_at > now())
            order by coalesce(c.last_used_at, c.created_at) asc
            limit $1`,
          [need],
        );
        const ids = (victims.rows as { client_id: string }[]).map((r) => r.client_id);
        if (ids.length < need) {
          // Reaching here needs ≥CLIENT_CAP clients EACH holding a live token, and a token exists
          // only where someone pasted a valid agent key — so this is not an anonymous DoS lever.
          await client.query("rollback");
          oauthError(
            res,
            400,
            "invalid_client_metadata",
            `client registration cap reached (${CLIENT_CAP} live clients) and every one holds a live token; revoke a connection in the Console and retry`,
          );
          return;
        }
        // oauth_bridge_codes.client_id is plain text with no FK — it must be swept explicitly.
        await client.query(`delete from oauth_bridge_codes where client_id = any($1)`, [ids]);
        await client.query(`delete from oauth_bridge_clients where client_id = any($1)`, [ids]);
      }
      const clientId = "pcgcl_" + randomBytes(16).toString("base64url");
      await client.query(
        `insert into oauth_bridge_clients (client_id, client_name, redirect_uris) values ($1, $2, $3)`,
        [clientId, clientName, uris],
      );
      await client.query("commit");
      sendJson(res, 201, {
        client_id: clientId,
        client_name: clientName ?? undefined,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        // already rolled back / connection gone
      }
      throw e;
    } finally {
      client.release();
    }
  }

  const registerHandler: Handler = async (req, res) => {
    if (!limiter.take(identify(req))) {
      oauthError(res, 429, "too_many_requests", "rate limited — retry shortly", {
        "retry-after": "60",
      });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      oauthError(res, 400, "invalid_client_metadata", "body must be a JSON object");
      return;
    }
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
      oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty array (max 10)");
      return;
    }
    for (const u of uris) {
      if (typeof u !== "string" || u.length > 2000 || !isRegistrableRedirectUri(u)) {
        oauthError(
          res,
          400,
          "invalid_redirect_uri",
          "each redirect_uri must be https, or http on a loopback host (localhost, 127.0.0.0/8, ::1) " +
            "outside the gateway's reserved paths (/api, /admin, /healthz, /mcp, /authorize, /token, /register)",
        );
        return;
      }
    }
    const clientName =
      typeof body.client_name === "string" && body.client_name.trim().length > 0
        ? body.client_name.trim().slice(0, 200)
        : null;

    await withDbSlot(res, "json", () => registerClientRow(res, uris as string[], clientName));
  };

  const authorizeGetHandler: Handler = async (req, res) => {
    // FIRST statement: the three auditBridgeDeny calls below are otherwise reachable at line rate
    // (GET /authorize shipped entirely unmetered), and an unmetered denial path is how the audit
    // log gets flooded.
    if (!limiter.take(identify(req))) {
      errorPage(res, 429, TOO_MANY_ATTEMPTS_WORDING, { "retry-after": "60" });
      return;
    }
    const url = new URL(req.url ?? "/", cfg.publicUrl);
    const p = authorizeParamsFrom((k) => url.searchParams.get(k));

    await withDbSlot(res, "page", async () => {
      // The open-redirect guard: an unknown client or a non-matching redirect_uri renders an ERROR
      // PAGE and NEVER redirects. Only past this line is redirecting back allowed.
      const client = await lookupClient(p.clientId);
      if (!client) {
        auditBridgeDeny("authorize: unknown client", { clientId: p.clientId });
        errorPage(res, 400, "Unknown client. This connection request did not come from a registered app.");
        return;
      }
      if (!p.redirectUri || !client.redirect_uris.some((r) => redirectUriMatches(r, p.redirectUri!))) {
        auditBridgeDeny("authorize: redirect_uri mismatch", { clientId: client.client_id });
        errorPage(res, 400, "The redirect address does not match this client's registration.");
        return;
      }

      const err = validateAuthorizeRequest(p);
      if (err) {
        auditBridgeDeny(`authorize: ${err.error}`, { clientId: client.client_id });
        redirectError(res, p.redirectUri, err.error, err.description, p.state);
        return;
      }
      authorizePage(res, 200, client, p);
    });
  };

  const authorizePostHandler: Handler = async (req, res) => {
    // Metered on the same budget as everything else. Reserving capacity for this route was tried and
    // removed: it protects step 3 of a 4-step flow (the CSRF token it requires is issued by the
    // ANONYMOUS GET above), so flooding step 2 makes the reserve unreachable anyway.
    if (!limiter.take(identify(req))) {
      errorPage(res, 429, TOO_MANY_ATTEMPTS_WORDING, { "retry-after": "60" });
      return;
    }
    const form = parseFormBody(req, await readBody(req));
    const p = authorizeParamsFrom((k) => (k in form ? form[k] : null));

    await withDbSlot(res, "page", async () => {
      // Same open-redirect guard as GET — the hidden fields are never trusted.
      const client = await lookupClient(p.clientId);
      if (!client) {
        auditBridgeDeny("authorize: unknown client", { clientId: p.clientId });
        errorPage(res, 400, "Unknown client. This connection request did not come from a registered app.");
        return;
      }
      if (!p.redirectUri || !client.redirect_uris.some((r) => redirectUriMatches(r, p.redirectUri!))) {
        auditBridgeDeny("authorize: redirect_uri mismatch", { clientId: client.client_id });
        errorPage(res, 400, "The redirect address does not match this client's registration.");
        return;
      }
      const err = validateAuthorizeRequest(p);
      if (err) {
        auditBridgeDeny(`authorize: ${err.error}`, { clientId: client.client_id });
        redirectError(res, p.redirectUri, err.error, err.description, p.state);
        return;
      }

      // CSRF: in-memory, single-use, TTL 10 min, bound to the exact triple it was rendered for.
      const csrfOk = consumeCsrf(form.csrf ?? "", {
        clientId: client.client_id,
        redirectUri: p.redirectUri,
        codeChallenge: p.codeChallenge ?? "",
      });
      if (!csrfOk) {
        auditBridgeDeny("authorize: csrf", { clientId: client.client_id });
        errorPage(res, 400, "This form has expired. Go back to the app and start the connection again.");
        return;
      }

      // The pasted key IS the login — validated via the SAME resolveBearer path. Unknown/revoked/
      // expired all refuse with IDENTICAL page wording (no oracle); the key is never stored.
      const key = form.key ?? "";
      let grant: GrantRow | null = null;
      if (key.length > 0) {
        try {
          await resolveBearer(key);
          const g = await db.query(
            `select id, user_id, agent_id, revoked_at, expires_at from agent_grants where key_hash = $1`,
            [sha256Hex(key)],
          );
          grant = (g.rows[0] as GrantRow | undefined) ?? null;
        } catch (e) {
          if (!(e instanceof AccessDenied)) throw e;
          grant = null;
        }
      }
      if (!grant) {
        auditBridgeDenyHighValue("authorize: key refused", { clientId: client.client_id });
        authorizePage(res, 400, client, p, { error: KEY_REFUSAL_WORDING });
        return;
      }

      // ADR 0035 §D3 item 6 — this is the ONE place in the system that knows a key is being handed
      // to a cloud client. NOT enforced at mint (admin.ts cannot tell a cloud key from a local one)
      // and NOT at /token refresh (that would kill every already-connected session on deploy).
      if (grant.expires_at == null) {
        auditBridgeDenyHighValue("authorize: key has no expiry", { clientId: client.client_id });
        authorizePage(res, 400, client, p, { error: KEY_NO_EXPIRY_WORDING });
        return;
      }

      const code = mintSecret(CODE_PREFIX);
      await db.query(
        `insert into oauth_bridge_codes
           (code_hash, client_id, agent_grant_id, code_challenge, redirect_uri, resource, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          code.hash,
          client.client_id,
          grant.id,
          p.codeChallenge,
          p.redirectUri,
          p.resource,
          new Date(now() + CODE_TTL_MS),
        ],
      );

      const target = new URL(p.redirectUri);
      target.searchParams.set("code", code.value);
      if (p.state != null) target.searchParams.set("state", p.state); // verbatim (RFC 6749 MUST)
      target.searchParams.set("iss", cfg.publicUrl); // 2026 spec-RC forward-compat; stable issuer
      res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
      res.end();
    });
  };

  // ── /token ──

  async function redeemAuthorizationCode(
    res: ServerResponse,
    form: Record<string, string>,
  ): Promise<void> {
    const client = await db.connect();
    try {
      await client.query("begin");
      // ATOMIC single-use: exactly one redemption can flip consumed_at.
      const consumed = await client.query(
        `update oauth_bridge_codes set consumed_at = now()
          where code_hash = $1 and consumed_at is null
          returning *`,
        [sha256Hex(form.code ?? "")],
      );
      const row = consumed.rows[0] as CodeRow | undefined;
      if (!row) {
        // Absent OR already consumed. Reuse of a consumed code additionally revokes the tokens that
        // code's redemption issued (RFC 9700 §4.5) — scoped to the grant×client the code was bound to.
        const prior = await client.query(
          `select agent_grant_id, client_id from oauth_bridge_codes where code_hash = $1`,
          [sha256Hex(form.code ?? "")],
        );
        const p = prior.rows[0] as { agent_grant_id: string; client_id: string } | undefined;
        if (p) {
          await client.query(
            `delete from oauth_bridge_tokens where agent_grant_id = $1 and client_id = $2`,
            [p.agent_grant_id, p.client_id],
          );
          auditBridgeDenyHighValue("token: code reuse — issued tokens revoked", { clientId: p.client_id });
        }
        await client.query("commit");
        oauthError(res, 400, "invalid_grant");
        return;
      }

      // The code is burned from here on — a failed validation never un-consumes it (RFC 9700).
      const fail = async (error: string): Promise<void> => {
        await client.query("commit");
        auditBridgeDeny(`token: ${error}`, { clientId: row.client_id });
        oauthError(res, 400, error);
      };
      if (new Date(row.expires_at).getTime() <= now()) return fail("invalid_grant");
      if (!form.client_id || form.client_id !== row.client_id) return fail("invalid_grant");
      if (!form.redirect_uri || form.redirect_uri !== row.redirect_uri) return fail("invalid_grant");
      if (form.resource != null && !resourceMatches(form.resource, canonicalResource)) {
        return fail("invalid_target");
      }
      const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
      if (challenge !== row.code_challenge) return fail("invalid_grant");

      // Re-read the grant row: revoked/expired grants refuse — the key governs everything derived.
      const g = await client.query(
        `select id, user_id, agent_id, revoked_at, expires_at from agent_grants where id = $1`,
        [row.agent_grant_id],
      );
      const grant = g.rows[0] as GrantRow | undefined;
      if (!grant || grant.revoked_at != null) return fail("invalid_grant");
      const grantExp = grant.expires_at ? new Date(grant.expires_at).getTime() : null;
      if (grantExp != null && grantExp <= now()) return fail("invalid_grant");

      const { response } = await mintTokenPair(client, grant, row.client_id, null);
      await client.query("commit");
      sendJson(res, 200, response);
      audit({
        userId: grant.user_id,
        agentId: grant.agent_id,
        tool: "oauth_token",
        decision: "allow",
        outcome: "ok",
        args: { grant: "authorization_code", clientId: row.client_id },
      });
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        // already rolled back / connection gone
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async function redeemRefreshToken(res: ServerResponse, form: Record<string, string>): Promise<void> {
    const presented = form.refresh_token ?? "";
    const client = await db.connect();
    try {
      await client.query("begin");
      // FOR UPDATE serializes concurrent presentations of the same refresh token: exactly one
      // rotation wins; the loser (re-checking under the lock) sees the successor and hits the
      // reuse path below.
      const found = await client.query(
        `select id, agent_grant_id, client_id, refresh_expires_at from oauth_bridge_tokens
          where refresh_hash = $1 for update`,
        [sha256Hex(presented)],
      );
      const row = found.rows[0] as
        | { id: string; agent_grant_id: string; client_id: string; refresh_expires_at: Date }
        | undefined;
      if (!row) {
        await client.query("commit");
        oauthError(res, 400, "invalid_grant"); // exact string — client recovery depends on it
        return;
      }

      // Rotated-out reuse: this row already has a successor → the whole chain is revoked (RFC
      // 9700). NOTE the predecessor's refresh_hash is deliberately RETAINED at rotation (successor-
      // existence is the rotated-out marker): nulling it — the spec-sketched alternative — would
      // make the presented value unrecognizable and this mandated chain revocation impossible.
      const successor = await client.query(
        `select 1 from oauth_bridge_tokens where rotated_from = $1 limit 1`,
        [row.id],
      );
      if ((successor.rowCount ?? 0) > 0) {
        await deleteTokenFamily(client, row.id);
        await client.query("commit");
        auditBridgeDenyHighValue("token: rotated-out refresh reuse — chain revoked", { clientId: row.client_id });
        oauthError(res, 400, "invalid_grant");
        return;
      }

      const fail = async (error: string): Promise<void> => {
        await client.query("commit");
        auditBridgeDeny(`token: ${error}`, { clientId: row.client_id });
        oauthError(res, 400, error);
      };
      if (new Date(row.refresh_expires_at).getTime() <= now()) return fail("invalid_grant");
      if (form.client_id != null && form.client_id !== row.client_id) return fail("invalid_grant");
      if (form.resource != null && !resourceMatches(form.resource, canonicalResource)) {
        return fail("invalid_target");
      }

      const g = await client.query(
        `select id, user_id, agent_id, revoked_at, expires_at from agent_grants where id = $1`,
        [row.agent_grant_id],
      );
      const grant = g.rows[0] as GrantRow | undefined;
      if (!grant || grant.revoked_at != null) return fail("invalid_grant");
      const grantExp = grant.expires_at ? new Date(grant.expires_at).getTime() : null;
      if (grantExp != null && grantExp <= now()) return fail("invalid_grant");

      // Rotate: successor row with FRESH hashes and a fresh sliding window (still capped by the
      // grant's expiry — a refresh chain can never outlive its key). The old ACCESS token stays
      // valid until its own access_expires_at (stated, deliberate).
      const { response } = await mintTokenPair(client, grant, row.client_id, row.id);
      await client.query("commit");
      sendJson(res, 200, response);
      audit({
        userId: grant.user_id,
        agentId: grant.agent_id,
        tool: "oauth_token",
        decision: "allow",
        outcome: "ok",
        args: { grant: "refresh_token", clientId: row.client_id },
      });
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        // already rolled back / connection gone
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** Mint + insert an access/refresh pair for a grant (hashes only) and bump the client's
   *  last_used_at (so the 90-day client GC never reaps a live connection). */
  async function mintTokenPair(
    client: Queryable,
    grant: GrantRow,
    clientId: string,
    rotatedFrom: string | null,
  ): Promise<{ response: Record<string, unknown> }> {
    const access = mintSecret(BRIDGE_ACCESS_TOKEN_PREFIX);
    const refresh = mintSecret(REFRESH_PREFIX);
    const nowMs = now();
    const grantExp = grant.expires_at ? new Date(grant.expires_at).getTime() : null;
    const refreshExp = new Date(
      grantExp != null ? Math.min(nowMs + REFRESH_TTL_MS, grantExp) : nowMs + REFRESH_TTL_MS,
    );
    await client.query(
      `insert into oauth_bridge_tokens
         (agent_grant_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, rotated_from)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        grant.id,
        clientId,
        access.hash,
        refresh.hash,
        new Date(nowMs + ACCESS_TTL_SEC * 1000),
        refreshExp,
        rotatedFrom,
      ],
    );
    await client.query(`update oauth_bridge_clients set last_used_at = now() where client_id = $1`, [
      clientId,
    ]);
    return {
      response: {
        access_token: access.value,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SEC,
        refresh_token: refresh.value,
      },
    };
  }

  const tokenHandler: Handler = async (req, res) => {
    // /token shipped with NO limiter at all and opens a pooled transaction per request — the exact
    // pair that let public traffic starve the loopback admin edge. Metered BEFORE readBody, and
    // slot-guarded below; the required-parameter checks sit ahead of the slot so a malformed body
    // never consumes one.
    if (!limiter.take(identify(req))) {
      oauthError(res, 429, "too_many_requests", "rate limited — retry shortly", {
        "retry-after": "60",
      });
      return;
    }
    const form = parseFormBody(req, await readBody(req)); // form-encoded is the contract
    const grantType = form.grant_type ?? "";
    if (grantType === "authorization_code") {
      if (!form.code || !form.code_verifier) {
        oauthError(res, 400, "invalid_request", "code and code_verifier are required");
        return;
      }
      await withDbSlot(res, "json", () => redeemAuthorizationCode(res, form));
    } else if (grantType === "refresh_token") {
      if (!form.refresh_token) {
        oauthError(res, 400, "invalid_request", "refresh_token is required");
        return;
      }
      await withDbSlot(res, "json", () => redeemRefreshToken(res, form));
    } else {
      oauthError(res, 400, "unsupported_grant_type");
    }
  };

  return new Map<string, Handler>([
    // PRM at BOTH paths — claude.ai probes the path-inserted form first.
    ["GET /.well-known/oauth-protected-resource", prmHandler],
    ["GET /.well-known/oauth-protected-resource/mcp", prmHandler],
    ["GET /.well-known/oauth-authorization-server", asMetadataHandler],
    ["POST /register", registerHandler],
    ["GET /authorize", authorizeGetHandler],
    ["POST /authorize", authorizePostHandler],
    ["POST /token", tokenHandler],
  ]);
}
