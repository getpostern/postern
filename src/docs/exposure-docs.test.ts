// exposure-docs — the mechanical gate on the public-exposure runbooks (U3, ADR 0035 §D1/§D6/§D8).
//
// A runbook whose commands were never executed is this repo's documentation equivalent of a test
// that cannot fail. Most of U3 is prose and is verified by a human running the commands; this file
// pins the handful of things that can silently DRIFT into being wrong — a port that Tailscale will
// not accept, an origin the gateway refuses at boot, the operator's own hostname leaking into the
// world-facing page, a retired instruction surviving a rewrite.
//
// House rule, applied to every cell below: an extraction assertion FIRST asserts its own harvest is
// non-empty. A regex that silently matches nothing passes forever and guards nothing. An ABSENCE
// assertion has no harvest to guard, so the last cell carries a dated mutation receipt instead —
// that is the substitute, and it is not optional.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeConfigFromEnv } from "../mcp/oauth-bridge.js";

// SPEC constants, not code constants.
/** Tailscale offers Funnel on exactly these ports (vendor-documented; last checked 2026-07-25).
 *  `tailscale serve` is unrestricted — this set applies to Funnel alone. */
const FUNNEL_ELIGIBLE_PORTS: readonly number[] = [443, 8443, 10000];
/** Cloud MCP connector backends egress on 443 only — this repo's 2026-07-21 experiment, and
 *  vendor-undocumented (ADR 0024 postscript 2026-07-25). */
const CLOUD_REACHABLE_PORT = 443;

/** Every host `remote-access.md` is allowed to print in a URL, LOWERCASE — the harvest folds case
 *  before comparing, because `HTTPS://` and `.TS.NET` are the same host to every resolver on earth
 *  and a case-sensitive allowlist is a bypass wearing a shift key. The page states its own convention
 *  ("Placeholders in this file"): loopback, or the parseable substitute-your-own name. Nothing here
 *  belongs to anybody, which is the property — a real box's name is anything NOT on this list. */
const PLACEHOLDER_URL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "gateway.example-tailnet.ts.net"];
/** …and every `*.ts.net` name it may print, including the two wildcard forms it discusses in prose
 *  (`*.ts.net` for "its own name", `%.ts.net` for the Certificate-Transparency query). */
const PLACEHOLDER_TS_NAMES: readonly string[] = [
  "<machine>.<tailnet>.ts.net",
  "gateway.example-tailnet.ts.net",
  "*.ts.net",
  "%.ts.net",
];

/**
 * The OPTIONAL, UNTRACKED exact-token list — and untracked is the design, not an oversight.
 *
 * A shape rule can only see what has a shape. `https://mini.tailXXXXXX.ts.net` is a shape; a bare
 * machine name dropped into this page's `ssh -L …:… <host>` slot is not — no scheme, no domain, no
 * hex, nothing to match on. The tokens that name one particular box therefore have to be listed
 * SOMEWHERE to be caught exactly, and the one place they can be listed without publishing them is a
 * file that never enters git.
 *
 * FORMAT — `<repo-root>/.exposure-tokens.local`, one token per line, `#` starts a comment, blank
 * lines ignored, matched case-insensitively as substrings. To create one on a machine that has real
 * tokens to protect:
 *
 *     printf '%s\n' 'my-machine-name' 'tailabc123' 'deadbeef' > .exposure-tokens.local
 *
 * It is in `.gitignore`. A COMMITTED DIGEST was considered and rejected: an 8-hex token brute-forces
 * in milliseconds and this test ships in the public tree, so a digest publishes the token it claims
 * to hide. The exact-token net for the PUBLISHED tree is the publish pipeline's private-side needle
 * scan (`docs/specs/publish-pipeline.md`) — that split is deliberate defense in depth, not a gap.
 *
 * ABSENT IS THE NORMAL CASE. CI, every fresh clone and the public tree have no such file and run the
 * shape rules alone. Absence degrades coverage; it never degrades the cell to vacuity — the shape
 * rules below are unconditional, and the cell reports which mode it ran in.
 */
const LOCAL_TOKEN_FILE = fileURLToPath(new URL("../../.exposure-tokens.local", import.meta.url));

/** The local tokens, lower-cased and paired with their 1-based line number, or `null` when this
 *  machine has no such file. The line number is what failures quote — printing the token itself
 *  would copy it into a CI log, which is the thing the file exists to prevent. */
function localForbiddenTokens(): Array<{ token: string; line: number }> | null {
  if (!existsSync(LOCAL_TOKEN_FILE)) return null;
  return readFileSync(LOCAL_TOKEN_FILE, "utf8")
    .split("\n")
    .map((raw, i) => ({ token: raw.split("#")[0].trim().toLowerCase(), line: i + 1 }))
    .filter(({ token }) => token.length > 0);
}

const REMOTE_ACCESS = fileURLToPath(new URL("../../docs/runbooks/remote-access.md", import.meta.url));
const ADR_0024 = fileURLToPath(
  new URL("../../docs/specs/decisions/0024-remote-access-tailscale.md", import.meta.url),
);

const read = (p: string): string => readFileSync(p, "utf8");
const RUNBOOKS: ReadonlyArray<[string, string]> = [
  ["remote-access.md", REMOTE_ACCESS],
];

/** All `funnel … --https=<port>` occurrences on a single line. Case-sensitive on purpose: prose
 *  says "Funnel", commands say "funnel", and `AllowFunnel` (a JSON key we tell operators to look
 *  for) must not be mistaken for a command. */
function funnelPorts(text: string): number[] {
  const out: number[] = [];
  const re = /funnel\b[^\n]{0,120}?--https=(\d+)/g;
  for (const m of text.matchAll(re)) out.push(Number(m[1]));
  return out;
}

/** Every `MCP_PUBLIC_URL=<value>` the docs tell a reader to write. Stops at whitespace or a
 *  markdown/quote delimiter so a backticked assignment yields the bare value. */
function publicUrlAssignments(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/MCP_PUBLIC_URL=([^\s`"'<>\n]+)/g)) {
    const v = m[1].replace(/[.,;:)]+$/, "");
    if (v.length > 0) out.push(v);
  }
  return out;
}

/** The body of a `## <name>` section, up to the next `## ` heading or EOF. */
function section(text: string, headingStartsWith: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).startsWith(headingStartsWith));
  expect(start, `section "## ${headingStartsWith}…" must exist`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** GitHub-flavoured heading slug: lowercase, drop everything outside [a-z0-9 _-], spaces → `-`. */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .trim()
    .replace(/ /g, "-");
}

function headingSlugs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) out.add(slugify(m[1]));
  return out;
}

describe("exposure docs — the parts that can drift into being wrong", () => {
  it("every funnel command in the runbooks names a port Tailscale will actually accept", () => {
    const found: Array<[string, number]> = [];
    for (const [name, path] of RUNBOOKS) for (const p of funnelPorts(read(path))) found.push([name, p]);
    expect(found.length, "no `funnel --https=<port>` command found — the regex or the runbooks broke").toBeGreaterThan(0);
    for (const [name, port] of found) {
      expect(FUNNEL_ELIGIBLE_PORTS, `${name}: funnel --https=${port} is not a Funnel-eligible port`).toContain(port);
    }
  });

  it("the recipe that hosted cloud clients follow is pinned to 443", () => {
    const cells: Array<[string, string]> = [
      ["remote-access.md §Going public", section(read(REMOTE_ACCESS), "Going public")],
    ];
    for (const [label, body] of cells) {
      const ports = funnelPorts(body);
      expect(ports.length, `${label}: no funnel command found in the hosted-client recipe`).toBeGreaterThan(0);
      for (const port of ports) {
        expect(port, `${label}: a hosted-client funnel on :${port} is unreachable from a vendor cloud`).toBe(
          CLOUD_REACHABLE_PORT,
        );
      }
    }
  });

  it("every public origin the docs tell a user to configure is port-less", () => {
    // The two runbooks only. `.env.example` documents the switch as a commented, EMPTY
    // `# MCP_PUBLIC_URL=`, which harvests as no value and would fail this cell for the wrong reason.
    const found: Array<[string, string]> = [];
    for (const [name, path] of RUNBOOKS) for (const v of publicUrlAssignments(read(path))) found.push([name, v]);
    expect(found.length, "no MCP_PUBLIC_URL assignment found in either runbook").toBeGreaterThan(0);
    for (const [name, value] of found) {
      const url = new URL(value);
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if (loopback) continue;
      // Check the documented STRING, not the parsed URL. `new URL()` drops a scheme-default port, so
      // `url.port` is "" for `https://host:443` exactly as for the port-less form — which makes a
      // parsed check vacuous for `:443`, the ONE value this cell exists to forbid. The raw text is
      // what `bridgeConfigFromEnv` keeps and `prmHandler` echoes into `authorization_servers`, where
      // a vendor's exact string match decides whether the client proceeds, so the raw text is what
      // must be port-less.
      const authority = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
      const explicitPort = /:(\d+)$/.exec(authority);
      expect(
        explicitPort?.[1] ?? null,
        `${name}: ${value} carries an explicit port — vendors send the port-less origin and match it as a literal string`,
      ).toBeNull();
    }
  });

  it("every curl command in the runbooks is pasteable into a shell", () => {
    // Nothing here inspected `curl` URLs before, which is how `…/api/ingest/<id>` shipped: `<` and
    // `>` are redirection operators, so a pasted line is a shell syntax error (bash and zsh alike)
    // or, worse, silently redirects instead of calling the API. Angle brackets are also illegal in a
    // hostname. Use `YOUR-CONNECTION-ID` / `$CONNECTION_ID` — never a fake UUID, which the
    // world-facing cell below forbids for its own reason. Prose may keep `<machine>.<tailnet>`;
    // only fenced command lines are scanned. Redirection in a documented curl is not a use case
    // here — `-o` is the flag for that.
    const lines: Array<[string, string]> = [];
    for (const [name, path] of RUNBOOKS) {
      for (const block of read(path).matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
        for (const line of block[1].split("\n")) {
          const code = line.split("#")[0];
          // `\b` and nothing narrower: inside a fence, `curl` is always a command, and it turns up
          // preceded by a quote (`ssh host "curl …"`), a pipe, or nothing at all. A char-class of
          // "plausible" preceding characters silently skipped the ssh-wrapped form on the first try.
          if (/\bcurl\s/.test(code)) lines.push([name, code]);
        }
      }
    }
    expect(lines.length, "no fenced curl command found in either runbook — the harvest broke").toBeGreaterThan(0);
    for (const [name, line] of lines) {
      expect(
        /[<>]/.test(line),
        `${name}: this curl line carries an angle-bracket placeholder and is a shell syntax error when pasted — "${line.trim()}"`,
      ).toBe(false);
    }
  });

  it("every public origin the docs tell a user to configure is one the gateway will boot with", () => {
    const found: Array<[string, string]> = [];
    for (const [name, path] of RUNBOOKS) for (const v of publicUrlAssignments(read(path))) found.push([name, v]);
    expect(found.length, "no MCP_PUBLIC_URL assignment found in either runbook").toBeGreaterThan(0);
    for (const [name, value] of found) {
      // Throws BridgeConfigError on anything boot would refuse; a runbook that prints a value the
      // gateway rejects at boot is a runbook that bricks the user who follows it.
      const config = bridgeConfigFromEnv({ MCP_PUBLIC_URL: value } as NodeJS.ProcessEnv);
      expect(config, `${name}: ${value} yields no bridge config`).not.toBeNull();
      expect(config?.publicUrl, `${name}: ${value} does not round-trip through bridgeConfigFromEnv`).toBe(value);
    }
  });

  it("the world-facing runbook's hosts are placeholders, and it carries nothing tailnet-, uuid- or secret-shaped", () => {
    // TWO LAYERS, AND EACH COVERS WHAT THE OTHER CANNOT.
    //
    // The first version of this guard was a denylist of the four tokens it existed to keep out — so
    // the file that guarded the leak published it, and shipping the repo shipped the machine name.
    // The second was shapes alone, which fixed that and lost three catches: a bare machine name in
    // this page's `ssh -L …:… <host>` slot has no scheme, no domain and no hex, and a product name in
    // prose has no shape at all. Neither layer is sufficient, so both run:
    //
    //   · SHAPES (rules 1-5) run everywhere, unconditionally, and catch a real host nobody has ever
    //     seen before — which a denylist by construction cannot.
    //   · EXACT tokens (rule 0) run only where the machine has an untracked `.exposure-tokens.local`,
    //     and catch the shapeless ones — which a shape by construction cannot.
    //
    // ANTI-VACUITY, STATED EXACTLY BECAUSE AN INACCURATE RECEIPT IS WORSE THAN NONE. Rules 0, 1 and 2
    // extract, and each asserts its own extraction is non-empty before judging it. Rules 3, 4 and 5
    // are absence assertions over the whole page: there is no harvest to be non-empty, so what keeps
    // them honest is that each was mutated and observed red, on the dates in the receipt below.
    //
    // MUTATION-VERIFIED 2026-07-28 — each planted in remote-access.md, run BOTH WAYS, reverted. The
    // second column is the point of the two-layer design: it is where shapes alone are not enough.
    //
    // Every plant is described by its SHAPE. Writing the actual tokens here would put them back in the
    // tracked tree — which is the defect the whole two-layer design exists to remove, and it is how
    // the FIRST version of this cell leaked them. Each row below is reproducible from its description
    // plus a matching line in a local `.exposure-tokens.local`.
    //
    //   plant                                            file present   file absent   first rule to fire
    //   ────────────────────────────────────────────────────────────────────────────────────────────
    //   a token-file machine name in the `ssh <host>`     RED            green         0 — no shape exists
    //     slot (a bare label: no scheme, no dots)
    //   a token-file product name in prose                RED            green         0 — no shape exists
    //   `https://mini-gw.tail7d31ac.ts.net/mcp`           RED            RED           1
    //   the same URL UPPER-CASED, scheme included         RED            RED           1 (scheme+host folded)
    //   `mini-gw.corp-net.ts.net` in prose, no scheme     RED            RED           2
    //   both placeholder forms deleted, not fixed         RED            RED           2's landmark
    //   bare `tail7d31ac`                                 RED            RED           3
    //   an 8-hex token-file fragment, lower case          RED            RED           4
    //   the same fragment UPPER-CASED                     RED            RED           4 (the case-fold)
    //   a full hex UUID (`3f2a9c11-8b4e-…`)               RED            RED           4, not 5 — its
    //                                                                                   head is a hex run
    //   a DIGIT-HEADED UUID (`12345678-1234-…`)           RED            RED           5 — rule 4's
    //                                                                                   letter filter
    //                                                                                   passes it through,
    //                                                                                   which is why 5 is
    //                                                                                   not redundant
    //   ⚠ NOT a mutation, a REGRESSION TEST: a bare unix timestamp (`1735689600`) stays GREEN both
    //     ways — an all-digit run is not hex, and rule 4 reddening on one is how a guard gets deleted.
    const text = read(REMOTE_ACCESS);
    // One lower-cased copy, used by every rule. A hostname is case-insensitive to every resolver on
    // earth and hex is case-insensitive to every encoder, so a case-sensitive rule is a bypass that
    // costs one shift key. This was a real regression: an UPPER-CASED hex fragment sailed past the
    // folded-only-in-parts version of this cell.
    const lower = text.toLowerCase();

    // 0. EXACT tokens, on machines that have any. See `LOCAL_TOKEN_FILE` for why this is untracked
    //    and why a committed digest is not an option. Failures quote the LINE, never the token.
    const tokens = localForbiddenTokens();
    if (tokens !== null) {
      expect(
        tokens.length,
        `${LOCAL_TOKEN_FILE} exists but parses to no tokens — an empty denylist passes forever`,
      ).toBeGreaterThan(0);
      for (const { token, line } of tokens) {
        expect(
          lower.includes(token),
          `remote-access.md contains the private token on line ${line} of .exposure-tokens.local — this page is for any box`,
        ).toBe(false);
      }
    }

    // 1. Every URL the page prints points at a placeholder or at loopback. Schemes are folded and
    //    `ws(s)://` is included — an MCP endpoint is as likely to be written as a websocket URL as an
    //    https one. The bracketed alternative is the IPv6 literal form (`http://[::1]:8787`): without
    //    it the `[::1]` placeholder this repo declares legal would be harvested as `[` and turn the
    //    cell red on its own allowlist. `<` / `>` are illegal in a hostname, which is why the
    //    pasteable placeholder exists beside the prose one — the curl cell above enforces that split
    //    from the other side.
    const urlHosts = [...text.matchAll(/(?:https?|wss?):\/\/(\[[0-9a-f:]+\]|[a-z0-9._~%-]+)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(urlHosts.length, "no URL found in remote-access.md — the harvest broke").toBeGreaterThan(0);
    for (const host of urlHosts) {
      expect(
        PLACEHOLDER_URL_HOSTS,
        `remote-access.md points at "${host}" — this page is for any box, so every host on it is a placeholder`,
      ).toContain(host);
    }

    // 2. Every `*.ts.net` name, in prose as well as in commands. A tailnet FQDN is `<machine>.<tailnet>`
    //    and BOTH labels identify a person's box, so the whole name has to be a documented form.
    const tsNames = [...text.matchAll(/[a-z0-9<>._~%*-]*\.ts\.net/gi)].map((m) => m[0].toLowerCase());
    expect(tsNames.length, "no *.ts.net name found in remote-access.md — the harvest broke").toBeGreaterThan(0);
    for (const name of tsNames) {
      expect(
        PLACEHOLDER_TS_NAMES,
        `remote-access.md names the tailnet host "${name}" — substitute-your-own is the only form this page may print`,
      ).toContain(name);
    }
    // …and both documented forms are actually on the page, so rule 2 cannot go quiet by the examples
    // being deleted rather than fixed.
    for (const form of ["<machine>.<tailnet>.ts.net", "gateway.example-tailnet.ts.net"]) {
      expect(lower, `remote-access.md no longer shows the "${form}" placeholder`).toContain(form);
    }

    // 3. A Tailscale-generated tailnet id is `tail` + hex and names exactly one real tailnet. It can
    //    ride in on a URL, a policy snippet or a shell prompt, so it is checked over the whole page.
    expect(lower, "remote-access.md carries a generated tailnet id — that names one real tailnet").not.toMatch(
      /\btail[0-9a-f]{6,}\b/,
    );

    // 4. Secret-shaped material: any bare hex run long enough to be a fragment of an ingest secret
    //    (256-bit hex, whose leading segment alone identifies a box). BOTH filters are load-bearing
    //    and each was added for a failure: a run with no digit is an English word, and a run with no
    //    a-f letter is a number — a unix timestamp reddened this rule before the letter filter, and a
    //    guard that cries wolf on `1735689600` is a guard somebody deletes.
    const hexRuns = (lower.match(/\b[0-9a-f]{8,}\b/g) ?? []).filter(
      (run) => /[0-9]/.test(run) && /[a-f]/.test(run),
    );
    expect(hexRuns, "remote-access.md carries a hex run — an ingest secret or id fragment").toEqual([]);

    // 5. A connection UUID, which is the one identifier this page has an honest reason to want to
    //    show and must never show: the curl cell above requires `YOUR-CONNECTION-ID` instead.
    expect(lower, "remote-access.md carries a real-looking connection UUID").not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
  });

  it("no runbook tells a user to put a tailnet hostname in the host allowlist", () => {
    // Landmark first: both runbooks must still CARRY the ADR 0024 §D2 invariant, so a silent
    // deletion reads as red rather than as "nothing to check".
    for (const [name, path] of RUNBOOKS) {
      expect(read(path), `${name}: the REST_ALLOWED_HOSTS invariant has gone missing`).toContain("REST_ALLOWED_HOSTS");
    }
    for (const [name, path] of RUNBOOKS) {
      for (const m of read(path).matchAll(/REST_ALLOWED_HOSTS\s*=\s*([^\s`"'\n]+)/g)) {
        expect(m[1], `${name}: REST_ALLOWED_HOSTS is set to a tailnet name — ADR 0024 §D2 forbids it`).not.toContain(
          ".ts.net",
        );
      }
    }
  });

  it("no runbook still tells a user to deny Funnel outright", () => {
    const claims: Array<[string, string]> = [];
    for (const [name, path] of RUNBOOKS) {
      for (const line of read(path).split("\n")) {
        if (/funnel/i.test(line) && /\b(attribute|nodeattr|autogroup)\b/i.test(line)) claims.push([name, line]);
      }
    }
    expect(claims.length, "no funnel-node-attribute guidance found in either runbook").toBeGreaterThan(0);
    for (const [name, line] of claims) {
      expect(
        /scope|scoped|scoping|gateway node/i.test(line),
        `${name}: funnel-attribute guidance is unqualified by scoping language (ADR 0035 §D8 rescopes it) — "${line.slice(0, 120)}…"`,
      ).toBe(true);
    }
  });

  it("the self-hoster is not told the authorization server is unshipped", () => {
    const text = read(REMOTE_ACCESS);
    expect(text, "remote-access.md no longer mentions the authorization server at all").toMatch(
      /authorization server/i,
    );
    for (const stale of [/does ?n[o']?t ship yet/i, /does not ship yet/i, /Release-wave R/i]) {
      expect(text, `remote-access.md still claims the OAuth server is unshipped (${stale})`).not.toMatch(stale);
    }
  });

  it("every relative link in the exposure docs resolves", () => {
    const docs: ReadonlyArray<[string, string]> = [
      ["remote-access.md", REMOTE_ACCESS],
      ["0024-remote-access-tailscale.md", ADR_0024],
    ];
    let checked = 0;
    for (const [name, path] of docs) {
      const text = read(path);
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [rel, anchor] = target.split("#");
        if (rel !== "" && !rel.endsWith(".md")) continue;
        const targetPath = rel === "" ? path : resolve(dirname(path), rel);
        checked++;
        expect(existsSync(targetPath), `${name}: link target "${target}" does not exist`).toBe(true);
        if (anchor !== undefined && anchor !== "") {
          expect(headingSlugs(read(targetPath)), `${name}: anchor "#${anchor}" matches no heading in ${rel || name}`).toContain(
            anchor,
          );
        }
      }
    }
    expect(checked, "no relative markdown links found across the three exposure docs").toBeGreaterThan(0);
  });
});
