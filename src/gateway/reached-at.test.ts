// The bounded "what address has anything actually reached me at?" recorder (#119) — DB-FREE.
//
// Two things are under test and they are not equally important:
//
//   1. the store is BOUNDED and it is actually WIRED to the public edge, and
//   2. **an observed Host never widens any check.**
//
// (2) is the unit. Every value this module holds arrived as a `Host` header on a public,
// unauthenticated edge, chosen by whoever opened the socket. If any gate ever consults it, a stranger
// picks our configured address — the confused-deputy shape public-edge-hardening spent three rounds
// closing. The cells below assert that the flow is one-directional by exercising the REAL gates
// (validatePublicUrl, bridgeTokensAcceptable, mountedBridgeConfig) before and after an observation,
// each paired with an anti-vacuity partner so "everything is always null/false" cannot pass.
//
// Host control needs node:http — fetch/undici forbids overriding Host — exactly as in
// src/rest/exposure-routes.db.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
import {
  REACHED_AT_MAX,
  noteReachedAt,
  reachedAtHosts,
  observedAtAddress,
  __resetReachedAtForTests,
} from "./reached-at.js";
import { startHttpEdge } from "../mcp/http.js";
import {
  bridgeTokensAcceptable,
  mountedBridgeConfig,
  noteBridgeMount,
  validatePublicUrl,
} from "../mcp/oauth-bridge.js";

const savedPublicUrl = process.env.MCP_PUBLIC_URL;

beforeEach(() => {
  __resetReachedAtForTests();
  noteBridgeMount(null);
  delete process.env.MCP_PUBLIC_URL;
});

afterEach(() => {
  __resetReachedAtForTests();
  noteBridgeMount(null);
  if (savedPublicUrl === undefined) delete process.env.MCP_PUBLIC_URL;
  else process.env.MCP_PUBLIC_URL = savedPublicUrl;
});

/** A request with FULL control over the Host header, against a live edge. */
function rawRequest(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path, headers: { host }, setHost: false },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the reached-at store", () => {
  it("a hostname we were reached at is recorded, and the set is bounded", () => {
    // The anti-vacuity partner FIRST: a single ordinary sighting really is stored. Without this,
    // a recorder that dropped everything would satisfy every cap assertion below.
    noteReachedAt("gw.example.ts.net");
    expect(reachedAtHosts()).toEqual(["gw.example.ts.net"]);

    __resetReachedAtForTests();
    const pushed = REACHED_AT_MAX + 5;
    for (let i = 0; i < pushed; i++) noteReachedAt(`h${i}.example.ts.net`);

    const hosts = reachedAtHosts();
    expect(pushed).toBeGreaterThan(REACHED_AT_MAX); // the cell really does overflow the cap
    expect(hosts).toHaveLength(REACHED_AT_MAX);
    // Newest first, and the five oldest are gone — the cap evicts the least recently seen, it does
    // not refuse new sightings (a store that stopped recording after 16 would answer "nothing has
    // reached this address" forever on a busy gateway).
    expect(hosts[0]).toBe(`h${pushed - 1}.example.ts.net`);
    expect(hosts).not.toContain("h0.example.ts.net");
    expect(hosts).not.toContain("h4.example.ts.net");
    expect(hosts).toContain(`h${pushed - REACHED_AT_MAX}.example.ts.net`);
  });

  it("eviction is by LAST sighting, so a host still being reached is not dropped for being oldest", () => {
    // The keeper is the FIRST host ever seen — and then it is seen again, after every other host in
    // a full window. Four newcomers then force four evictions.
    //
    //   evicting by last sighting  → the four hosts NOT seen since go; the keeper survives.
    //   evicting by first sighting → the keeper goes first, and the one host we KNOW is still being
    //                                reached is the one we forget. A user whose Funnel works and
    //                                whose gateway is getting other traffic is then told nothing has
    //                                reached them, which is the exact wrong answer.
    //
    // The counts are load-bearing: the window must be FULL before the refresh, or nothing evicts and
    // the cell passes either way (it did, in the first draft of this file).
    noteReachedAt("keeper.example.ts.net");
    for (let i = 1; i < REACHED_AT_MAX; i++) noteReachedAt(`h${i}.example.ts.net`);
    expect(reachedAtHosts()).toHaveLength(REACHED_AT_MAX); // full, so the next four DO evict

    noteReachedAt("keeper.example.ts.net"); // still arriving
    for (let i = 0; i < 4; i++) noteReachedAt(`x${i}.example.ts.net`);

    expect(reachedAtHosts()).toHaveLength(REACHED_AT_MAX);
    expect(reachedAtHosts()).toContain("keeper.example.ts.net");
    // …and the four that really were least-recently seen are the ones that went.
    for (let i = 1; i <= 4; i++) expect(reachedAtHosts()).not.toContain(`h${i}.example.ts.net`);
    expect(reachedAtHosts()).toContain(`h${REACHED_AT_MAX - 1}.example.ts.net`);

    // A repeat sighting moves a host to newest; it never adds a second entry.
    const before = reachedAtHosts().length;
    noteReachedAt("keeper.example.ts.net");
    expect(reachedAtHosts()).toHaveLength(before);
    expect(reachedAtHosts()[0]).toBe("keeper.example.ts.net");
  });

  it("a header too long or too strange to be a hostname is never stored", () => {
    noteReachedAt("a".repeat(4096) + ".example"); // the memory-exhaustion shape, one header at a time
    noteReachedAt("");
    noteReachedAt("   ");
    noteReachedAt(undefined);
    noteReachedAt("has spaces.example");
    noteReachedAt("<script>alert(1)</script>"); // this string is RENDERED in a UI
    noteReachedAt("gw.example.ts.net/../../etc/passwd");
    expect(reachedAtHosts()).toEqual([]);

    // The partner: the shapes we DO accept are still accepted, so the filter is a filter and not a
    // blanket refusal. Host is case-insensitive, so it is stored folded.
    // REBOUND AT MERGE (Decision 2a): this partner used to prove the filter is not a blanket refusal
    // with `127.0.0.1:8788` / `[::1]:8788`. Those are now refused for a DIFFERENT and correct reason —
    // they are private-path traffic — so they no longer demonstrate anything about hostname SHAPE.
    // Public-shaped names carry the partner instead.
    noteReachedAt("GW.Example.TS.net");
    noteReachedAt("other.example.ts.net:443");
    expect([...reachedAtHosts()].sort()).toEqual([
      "gw.example.ts.net",
      "other.example.ts.net",
    ]);
  });

  it("the caller cannot reach the store through the array it is handed", () => {
    noteReachedAt("gw.example.ts.net");
    const handed = reachedAtHosts() as string[];
    handed.push("injected.example");
    handed[0] = "rewritten.example";
    expect(reachedAtHosts()).toEqual(["gw.example.ts.net"]);
  });
});

describe("observedAtAddress — the three answers", () => {
  it("'we cannot say' and 'the evidence says no' are different answers", () => {
    // Nothing configured → nothing to be observed at.
    expect(observedAtAddress(null)).toBeNull();
    expect(observedAtAddress("")).toBeNull();

    // Configured, but nothing has arrived AT ALL: null, not false. A fresh boot must not be reported
    // as a failure — that is the difference between "no evidence yet" and "traffic is going nowhere".
    expect(observedAtAddress("https://gw.example.ts.net")).toBeNull();

    // Traffic HAS arrived, naming something else: false. This is the diagnostic answer.
    // REBOUND AT MERGE (Decision 2a): this used to be driven by `localhost:8788`, which is the very
    // inversion the review found — a loopback client is not evidence about PUBLIC reachability, and
    // letting it answer told users with a correct hostname to go and check it. Only genuinely public
    // traffic under a different name may produce `false`.
    noteReachedAt("wrong.example.ts.net");
    expect(observedAtAddress("https://gw.example.ts.net")).toBe(false);

    // …and once it names this address, true.
    noteReachedAt("gw.example.ts.net");
    expect(observedAtAddress("https://gw.example.ts.net")).toBe(true);
    // Still false for an address nothing named — one sighting does not vouch for every address.
    expect(observedAtAddress("https://other.example.ts.net")).toBe(false);
  });

  it("the same address spelled differently is the same address", () => {
    noteReachedAt("GW.Example.TS.net");
    expect(observedAtAddress("https://gw.example.ts.net")).toBe(true);
    expect(observedAtAddress("https://gw.example.ts.net:443")).toBe(true); // URL drops the default port

    // The explicit-default-port spelling on the WIRE matches too: a client that sends `Host:
    // x:443` over the tunnel is at the same address, and reporting "nothing has reached you" there
    // would send the user off to debug a Funnel that works.
    __resetReachedAtForTests();
    noteReachedAt("gw.example.ts.net:443");
    expect(observedAtAddress("https://gw.example.ts.net")).toBe(true);

    // REBOUND AT MERGE (Decision 2a). This used to assert that `:10000` is "a different address" and
    // therefore answers `false`. It is not a different address — it is THE SAME gateway reached over
    // `tailscale serve`, i.e. private traffic, and treating it as evidence is what inverted the whole
    // diagnosis. It is now not recorded at all, so it can answer NOTHING: `null`, not `false`.
    // The :443 lesson survives intact and is asserted above — port-less and `:443` are one address.
    __resetReachedAtForTests();
    noteReachedAt("gw.example.ts.net:10000");
    expect(observedAtAddress("https://gw.example.ts.net")).toBeNull();
    expect(reachedAtHosts()).toEqual([]);
  });

  it("an address we cannot parse is one we cannot say anything about", () => {
    noteReachedAt("gw.example.ts.net");
    expect(observedAtAddress("not a url")).toBeNull();
    // The partner: a parseable one still answers.
    expect(observedAtAddress("https://gw.example.ts.net")).toBe(true);
  });
});

describe("the security property", () => {
  it("an observed Host never widens any check", () => {
    // The gateway is OFF: no env var, nothing mounted. This is the state a stranger would love to
    // change by choosing our address for us.
    expect(mountedBridgeConfig()).toBeNull();
    expect(bridgeTokensAcceptable()).toBe(false);

    // A stranger names us anything they like, repeatedly, including our own would-be address.
    for (const h of ["attacker.example", "gw.example.ts.net", "localhost:8788", "169.254.169.254"]) {
      for (let i = 0; i < 50; i++) noteReachedAt(h);
    }
    expect(reachedAtHosts().length).toBeGreaterThan(0); // the observations really landed

    // 1. It never becomes what this process is serving.
    expect(mountedBridgeConfig()).toBeNull();
    // 2. It never makes this gateway start accepting bridge tokens.
    expect(bridgeTokensAcceptable()).toBe(false);
    // 3. It never makes the ONE validator accept a value it rejected. `http://` to a public name is
    //    refused whether or not we have "been reached" there.
    expect(() => validatePublicUrl("http://attacker.example")).toThrow();
    expect(() => validatePublicUrl("https://attacker.example/?x=1")).toThrow();

    // ANTI-VACUITY, and it is what makes the three assertions above mean something: the same three
    // checks DO say yes when the legitimate path says yes. Without this block, a build that answered
    // "no" to everything would pass every assertion above.
    expect(validatePublicUrl("https://attacker.example").publicUrl).toBe("https://attacker.example");
    noteBridgeMount({ publicUrl: "https://real.example.ts.net" });
    expect(mountedBridgeConfig()).toEqual({ publicUrl: "https://real.example.ts.net" });
    expect(bridgeTokensAcceptable()).toBe(true);

    // And with a real mount in place, the observations STILL do not touch it: `serving` is what this
    // process mounted, never the loudest name on the wire.
    for (let i = 0; i < 50; i++) noteReachedAt("attacker.example");
    expect(mountedBridgeConfig()).toEqual({ publicUrl: "https://real.example.ts.net" });
  });

  it("observing an address is not the same as being configured with it", () => {
    // The whole flow is one-directional: the configured address is looked up IN the observations.
    // Nothing here can produce a configured address, so there is no setter to abuse.
    noteReachedAt("attacker.example");
    expect(observedAtAddress("https://attacker.example")).toBe(true);
    // …and that `true` changed nothing about what this gateway serves or accepts.
    expect(mountedBridgeConfig()).toBeNull();
    expect(bridgeTokensAcceptable()).toBe(false);
    expect(process.env.MCP_PUBLIC_URL).toBeUndefined();
  });
});

describe("the wiring", () => {
  it("the MCP edge records the address it was reached at, on every path", async () => {
    const edge = startHttpEdge({ port: 0, audit: () => {}, bridge: null });
    for (let i = 0; i < 200 && edge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    try {
      __resetReachedAtForTests();

      // /mcp itself. A GET with no session id is a 400 — the point is that the request ARRIVED.
      expect(await rawRequest(edge.port, "/mcp", "gw.example.ts.net")).toBe(400);
      expect(reachedAtHosts()).toContain("gw.example.ts.net");

      // …and a path the edge does not serve at all. A cloud MCP client fetches discovery before it
      // ever reaches /mcp, so recording only on /mcp would answer "nothing has reached this address"
      // for exactly the user whose tunnel works and whose OAuth does not.
      __resetReachedAtForTests();
      const st = await rawRequest(
        edge.port,
        "/.well-known/oauth-protected-resource",
        "discovery.example.ts.net",
      );
      expect(st).toBe(404); // bridge OFF — the response shape is untouched by this unit
      expect(reachedAtHosts()).toContain("discovery.example.ts.net");
    } finally {
      await edge.close();
    }
  });
});

// ── Added by the mother at merge (spec Decision 2a). The adversarial review of the Console child
// proved by probe that the diagnosis INVERTED on the default topology: `tailscale serve --https=10000`
// and the Funnel point at the same backend, so an ordinary Claude Code request from the owner's own
// laptop arrived as `<machine>.<tailnet>.ts.net:10000`, flipped the served answer to "reached — but
// never at this address", and the Console told a user whose hostname was CORRECT to go check it.
describe("only traffic that could have crossed the public internet is recorded (Decision 2a)", () => {
  beforeEach(() => __resetReachedAtForTests());

  it("tailnet-serve traffic on :10000 is NOT recorded — it never left the tailnet", () => {
    noteReachedAt("box.tail1234.ts.net:10000");
    expect(reachedAtHosts()).toEqual([]);
    // MUTATION: drop the `port !== "443"` refusal in publicCandidate → this goes RED, and with it the
    // whole point of the field: a private request would answer a question about public reachability.
  });

  it("a loopback client is NOT recorded, port or no port", () => {
    for (const h of ["localhost:8788", "127.0.0.1:8788", "localhost", "127.0.0.1", "[::1]", "app.localhost"]) {
      noteReachedAt(h);
    }
    expect(reachedAtHosts()).toEqual([]);
  });

  it("the ingest path on :8443 is NOT recorded either — Funnel-eligible is not the same as funnelled", () => {
    noteReachedAt("box.tail1234.ts.net:8443");
    expect(reachedAtHosts()).toEqual([]);
  });

  // ANTI-VACUITY PARTNER — must stay GREEN under every mutation above, or "record nothing" would
  // pass all three refusals while destroying the feature.
  it("genuine public traffic IS still recorded, port-less or spelled :443", () => {
    noteReachedAt("box.tail1234.ts.net");
    noteReachedAt("other.tail1234.ts.net:443");
    expect(reachedAtHosts()).toContain("box.tail1234.ts.net");
    expect(reachedAtHosts()).toContain("other.tail1234.ts.net");
  });
});
