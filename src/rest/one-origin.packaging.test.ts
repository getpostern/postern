// Packaging tests for the ONE-ORIGIN unit (ADR 0035 §D4/§D5): the gateway's own public-base-URL
// knob must actually REACH a container, no origin may be hardcoded for every user of this repo, and
// the Console image must never be built against somebody else's origin.
//
// The defect class this file exists for is invisible to every runtime test: `canonicalBaseUrl()` was
// correct, documented and honoured — and `PCI_PUBLIC_BASE_URL` was declared NOWHERE in compose, so
// Docker (which passes no undeclared host env into a container) could never deliver it. Same shape
// as #97's PCI_MASTER_KEY.
//
// ── The text helpers below are ported VERBATIM from `src/secrets/packaging.test.ts:19-112`
//    (servicesBlock / serviceSlice / stripComment / commentFree / envBlock). They are DUPLICATED
//    rather than imported because that file is not owned by this unit's wave and extracting a shared
//    module would mean editing it. Read the `commentFree` docstring there before adding an assertion
//    here: matching raw compose text is this repo's most-repeated defect (a commented-out line
//    satisfies the guard while compose delivers nothing).

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { callbackUrl, canonicalBaseUrl } from "./oauth-routes.js";
import type { RouteContext } from "./router.js";

const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const bootstrapSrc = readFileSync(new URL("../bootstrap.ts", import.meta.url), "utf8");

// Every slicer below takes the compose TEXT, defaulting to the shipped file. The parameter is what
// lets the port guards be pointed at a HAND-BUILT fixture that carries the exact defect they exist
// for — a guard nobody tried to fool is not a guard (day-22, `vault-key-packaging`).

/** The `services:` block only — so top-level `volumes:` entries are never mistaken for services. */
function servicesBlock(text: string = compose): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start < 0) throw new Error("docker-compose.yml has no top-level `services:` block");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** The text of one service, from `  <name>:` to the next `  <something>:` (or the block's end). */
function serviceSlice(name: string, text: string = compose): string {
  const block = servicesBlock(text).split("\n");
  const start = block.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`docker-compose.yml has no service named '${name}'`);
  let end = block.length;
  for (let i = start + 1; i < block.length; i++) {
    if (/^ {2}\S+:\s*$/.test(block[i])) {
      end = i;
      break;
    }
  }
  return block.slice(start, end).join("\n");
}

/**
 * One line with its YAML comment removed — a whole-line `#` comment, or a trailing ` # …`.
 * Quote-aware, so a `#` inside a quoted scalar is left alone.
 */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/** A whole service's text with COMMENTS AND BLANK LINES REMOVED. Every assertion goes through this. */
function commentFree(service: string, text: string = compose): string {
  return serviceSlice(service, text)
    .split("\n")
    .map(stripComment)
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/** One service's `environment:` mapping, sliced out of the comment-free text. */
function envBlock(service: string, text: string = compose): string {
  const lines = commentFree(service, text).split("\n");
  const start = lines.findIndex((l) => /^ {4}environment:\s*$/.test(l));
  if (start < 0) throw new Error(`docker-compose.yml service '${service}' has no environment: block`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // Any key back at the service's own indent (`    ports:`, `    volumes:`) ends the block.
    if (/^ {4}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

const app = commentFree("app");
const appEnv = envBlock("app");

describe("one-origin packaging: guards", () => {
  it("the packaging slices are real", () => {
    // The landmark. Without it every assertion below is about an empty string.
    expect(app).toContain('image: "ghcr.io/getpostern/postern');
    expect(app).toContain("DATABASE_URL:");
    expect(appEnv).not.toBe("");
    expect(appEnv).not.toContain("#");
    expect(dockerfile).toContain("FROM node:22-slim AS builder");
  });
});

describe("one-origin packaging: the public base URL reaches the container (ADR 0035 §D4)", () => {
  it("a container actually receives the gateway's public base URL setting", () => {
    // Comment-free: a `# PCI_PUBLIC_BASE_URL: …` line delivers exactly nothing, which is how the
    // knob was inert in the first place.
    expect(appEnv).toContain('PCI_PUBLIC_BASE_URL: "${PCI_PUBLIC_BASE_URL:-}"');
  });

  it("no origin is hardcoded into the compose file for every user of this repo", () => {
    // The default literal lives in src/rest/oauth-routes.ts and NOWHERE else. A
    // `"${PCI_PUBLIC_BASE_URL:-http://localhost:8787}"` here would be a second copy — the exact
    // drift this unit removes — and it would also defeat the empty-string treatment.
    const mapping = appEnv
      .split("\n")
      .filter((l) => /^ {6}PCI_PUBLIC_BASE_URL:/.test(l));
    expect(mapping).toHaveLength(1);
    expect(mapping[0]).not.toContain("://");
  });

  it("the setting is discoverable — .env.example documents it", () => {
    // The value side stays EMPTY: src/secrets/packaging.test.ts:186-199 fails any `.env.example`
    // line with a `#` after the `=`, because compose's dotenv parser would deliver the comment text
    // AS the value. Its coupling to compose (every documented knob must be delivered) is enforced
    // by src/secrets/packaging.test.ts:157-176 — this cell is about DISCOVERABILITY, not delivery,
    // so it does not duplicate that one.
    expect(envExample).toMatch(/^#\s*PCI_PUBLIC_BASE_URL=\s*$/m);
  });
});

describe("one-origin packaging: MCP_TRUSTED_PROXIES rides along (delivery only)", () => {
  it("a container actually receives the trusted-proxy list the edge hardening needs", () => {
    // DELIVERY ONLY, on behalf of the parallel `public-edge-hardening` unit, which owns src/mcp/ and
    // touches no packaging file — so without this declaration its fix would be correct and
    // permanently unconfigurable (the failure recorded at docs/specs/implemented/mcp-auth-bridge.md:24).
    // We assert ONLY that the KEY reaches a container. Parsing, validation, defaults and every
    // semantic are that unit's; asserting one here would couple two units' tests across a wave.
    expect(appEnv).toContain('MCP_TRUSTED_PROXIES: "${MCP_TRUSTED_PROXIES:-}"');
    expect(envExample).toMatch(/^#\s*MCP_TRUSTED_PROXIES=\s*$/m);
  });
});

/** Every Dockerfile line that DOES something — whole-line `#` comments removed, because a
 *  commented-out `RUN`/`ENV` builds nothing and sets nothing. */
const dockerfileCode = dockerfile.split("\n").filter((l) => !/^\s*#/.test(l));

describe("one-origin packaging: the Console image bakes no origin (ADR 0035 §D4)", () => {
  it("the Console build line exists exactly once and carries no origin", () => {
    const buildLines = dockerfileCode.filter((l) => l.includes("apps/web") && l.includes("npm run build"));
    // EXACTLY one: a deleted build line must fail loudly here, not pass silently, and a second one
    // must not hide behind the first.
    expect(buildLines).toHaveLength(1);
    // The Console resolves its origin at RUNTIME from the browser (GATEWAY_URL defaults to ""), so
    // handing the build an absolute VITE_GATEWAY_URL re-bakes the bug this unit removes.
    expect(buildLines[0]).not.toContain("://");
  });

  it("NO line of the Dockerfile, in ANY form, hands the Console build an origin", () => {
    // WIDENED after review (2026-07-25). The cell above inspects only the `RUN … apps/web … npm run
    // build` line, so an `ENV VITE_GATEWAY_URL=https://…` or `ARG VITE_GATEWAY_URL=https://…`
    // ANYWHERE else in the file re-bakes an absolute origin with that cell still green — and both
    // reach vite exactly as a prefix on the RUN line would (ENV is exported into every later RUN;
    // an ARG with a default is substituted into it). So the guard is the WHOLE file, not one line.
    const offenders = dockerfileCode
      .filter((l) => l.includes("VITE_GATEWAY_URL"))
      .filter((l) => {
        // The assigned token: group 1 present only when there is an `=`; group 2 is the value.
        // `ENV VITE_GATEWAY_URL http://x` (the legacy space form) and a bare `ARG VITE_GATEWAY_URL`
        // both leave group 1 undefined and are offenders too — the bare ARG because it makes the
        // origin injectable with `--build-arg`, which is the same bug arriving from outside the file.
        // No `\s*` around the `=`: Dockerfile ENV/ARG assignment is `KEY=value` with no spaces, and
        // allowing them would swallow the next word of `RUN VITE_GATEWAY_URL= npm run build`.
        const m = /VITE_GATEWAY_URL(=(\S*))?/.exec(l);
        const assigned = m?.[1] === undefined ? undefined : (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
        return assigned !== ""; // "" (and `=""` / `=''`) is the ONLY permitted value
      });
    // toEqual([]) not toHaveLength(0): the failure message then NAMES the offending line.
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #117 — the listening ports are KNOBS, not literals.
//
// A user whose 8787 is already taken had exactly one way out: edit docker-compose.yml, a TRACKED
// file, which their next `git pull` reverts. Everything that has to agree with that port — the host
// publish, the in-container healthcheck, and the OAuth redirect default — must move with it. The
// healthcheck is the one that gets missed: pinned, it probes a dead port while the app serves
// perfectly, and `scripts/deploy-to-mini.sh` blocks on that health status, so the symptom is a failed
// deploy with a cause that looks nothing like ports.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The ports this repo ships as defaults. A bare one of these on a LIVE compose line is the defect. */
const SHIPPED_PORTS = [8787, 8788] as const;

/**
 * Every LIVE compose line carrying a shipped port literal that is NOT inside a `${VAR:-NNNN}`
 * default. Comments are stripped first (prose explaining the default must not read as a violation),
 * and each `${VAR:-…}` is blanked before the scan (that is the ONE approved home for the literal).
 */
function barePortLiterals(text: string): string[] {
  return text
    .split("\n")
    .filter((raw) => {
      const live = stripComment(raw).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}/g, "«interpolated»");
      return SHIPPED_PORTS.some((p) => new RegExp(`(?<!\\d)${p}(?!\\d)`).test(live));
    })
    .map((l) => l.trim());
}

/** The RAW (uninterpolated) value the app service delivers for one env key. Throws if undelivered. */
function envValueToken(name: string, text: string = compose): string {
  const line = envBlock("app", text)
    .split("\n")
    .find((l) => new RegExp(`^ {6}${name}:`).test(l));
  if (line === undefined) throw new Error(`docker-compose.yml app service does not deliver ${name}`);
  return line
    .slice(line.indexOf(":") + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}

/** The RAW port token inside the healthcheck's `/healthz` probe. Throws if there is no probe. */
function healthcheckPortToken(text: string = compose): string {
  const m = /fetch\('http:\/\/127\.0\.0\.1:(.+?)\/healthz'\)/.exec(commentFree("app", text));
  if (m === null) throw new Error("the app service has no /healthz probe in its healthcheck");
  return m[1];
}

/** What compose resolves a `${VAR:-default}` token to for a given host environment. */
function resolve(token: string, env: Record<string, string> = {}): string {
  return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g, (_m, name: string, dflt: string) => {
    const v = env[name];
    return v === undefined || v === "" ? dflt : v; // compose's `:-` = unset OR empty takes the default
  });
}

/**
 * The day-22 trap, rebuilt on purpose. The CORRECT interpolated healthcheck sits in a COMMENT and the
 * LIVE probe is the bare literal — i.e. a naive `compose.includes("${REST_PORT:-8787}/healthz")`
 * passes while the shipped container probes a port nothing may be listening on.
 */
const FOOLED_COMPOSE = [
  "services:",
  "  app:",
  "    build: .",
  "    environment:",
  "      DATABASE_URL: postgres://pci:pci@db:5432/pci",
  '      REST_PORT: "${REST_PORT:-8787}"',
  "    healthcheck:",
  "      test:",
  '        # - "fetch(\'http://127.0.0.1:${REST_PORT:-8787}/healthz\').then(r=>process.exit(0))"',
  '        - "fetch(\'http://127.0.0.1:8787/healthz\').then(r=>process.exit(0))"',
  "",
].join("\n");

/** The same shape, correct — and with prose that MENTIONS the literal, which must not be a finding. */
const CLEAN_COMPOSE = [
  "services:",
  "  app:",
  "    build: .",
  "    environment:",
  "      DATABASE_URL: postgres://pci:pci@db:5432/pci",
  "      # 8787 is the default; set REST_PORT in .env to move it. MCP is 8788.",
  '      REST_PORT: "${REST_PORT:-8787}"',
  "    healthcheck:",
  "      test:",
  '        - "fetch(\'http://127.0.0.1:${REST_PORT:-8787}/healthz\').then(r=>process.exit(0))"',
  "",
].join("\n");

describe("first-run ports: the listening ports are knobs, not literals (#117)", () => {
  it("no bare 8787 or 8788 literal survives in docker-compose.yml outside a ':-' default", () => {
    // toEqual([]) not toHaveLength(0): the failure message NAMES the line that has to change.
    expect(barePortLiterals(compose)).toEqual([]);
    // Anti-vacuity: the scanner is looking at a real file that really does contain these ports —
    // an empty/renamed compose would otherwise satisfy the assertion above by having nothing in it.
    expect(compose).toContain("${REST_PORT:-8787}");
    expect(compose).toContain("${MCP_HTTP_PORT:-8788}");
  });

  it("a port literal parked in a COMMENT cannot satisfy the guard for a real one", () => {
    // The naive check IS fooled — stated out loud, because this is the exact shape that shipped a
    // green guard over a live defect once already.
    expect(FOOLED_COMPOSE).toContain("${REST_PORT:-8787}/healthz");
    // The guards are not: the bare live probe is reported…
    const offenders = barePortLiterals(FOOLED_COMPOSE);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("127.0.0.1:8787/healthz");
    // …and the extractor reads the LIVE probe, so the disagreement with REST_PORT is visible.
    expect(healthcheckPortToken(FOOLED_COMPOSE)).toBe("8787");
    expect(resolve(envValueToken("REST_PORT", FOOLED_COMPOSE), { REST_PORT: "9000" })).toBe("9000");
    expect(resolve(healthcheckPortToken(FOOLED_COMPOSE), { REST_PORT: "9000" })).toBe("8787");

    // And the mirror image: prose that merely MENTIONS the literal is not a violation, or the guard
    // would be unfixable except by deleting the comments that explain the default.
    expect(CLEAN_COMPOSE).toContain("# 8787 is the default");
    expect(barePortLiterals(CLEAN_COMPOSE)).toEqual([]);
  });

  it("the healthcheck reaches the port the app was told to listen on", () => {
    const rest = envValueToken("REST_PORT");
    const probe = healthcheckPortToken();
    // Stock install and a moved port BOTH agree. The second case is the whole point: pinned to 8787,
    // the container never goes healthy and scripts/deploy-to-mini.sh fails on an unrelated-looking
    // cause. Asserting the resolved values (not the raw strings) also catches a `:-9000` typo.
    expect(resolve(probe)).toBe(resolve(rest));
    expect(resolve(probe, { REST_PORT: "9000" })).toBe(resolve(rest, { REST_PORT: "9000" }));
    // Anti-vacuity: the "moved" case must actually move, or both sides could be a frozen constant.
    expect(resolve(rest, { REST_PORT: "9000" })).toBe("9000");
    expect(resolve(rest)).toBe("8787");
  });

  it("the host publishes each port 1:1, so the address in the browser IS the port that was set", () => {
    // Matched against the COMMENT-FREE app slice, and against the SAME token the environment block
    // delivers — so a publish frozen at 8787 (or rewritten to a different outside port, which would
    // silently break the OAuth default's derivation) fails here.
    const appPorts = commentFree("app");
    expect(appPorts).toContain(`- "127.0.0.1:${envValueToken("REST_PORT")}:${envValueToken("REST_PORT")}"`);
    expect(appPorts).toContain(
      `- "127.0.0.1:${envValueToken("MCP_HTTP_PORT")}:${envValueToken("MCP_HTTP_PORT")}"`,
    );
  });

  it("both ports are documented in .env.example, so a user can find the knob at all", () => {
    // `#`-commented with the shipped default as the value: the delivery guard in
    // src/secrets/packaging.test.ts:157-176 then requires compose to deliver them (it does), and its
    // sibling at :186-199 forbids a trailing comment after the `=`.
    expect(envExample).toMatch(/^#\s*REST_PORT=8787\s*$/m);
    expect(envExample).toMatch(/^#\s*MCP_HTTP_PORT=8788\s*$/m);
    // The redirect_uri consequence has to be next to the knob, not only in the runbook: a provider
    // exact-matches it, and "consent broke" is a long way from "I changed a port".
    expect(envExample).toMatch(/redirect/i);
  });
});

// ── Decision 3: the OAuth redirect default follows REST_PORT ──────────────────────────────────────

const savedRestPort = process.env.REST_PORT;
const savedBaseUrl = process.env.PCI_PUBLIC_BASE_URL;
afterEach(() => {
  // Restored explicitly: vitest reuses a worker process across FILES, and src/rest/oauth-routes.test.ts
  // asserts the stock `:8787` default with REST_PORT unset. A leak from here would break that file.
  if (savedRestPort === undefined) delete process.env.REST_PORT;
  else process.env.REST_PORT = savedRestPort;
  if (savedBaseUrl === undefined) delete process.env.PCI_PUBLIC_BASE_URL;
  else process.env.PCI_PUBLIC_BASE_URL = savedBaseUrl;
});

/** A RouteContext carrying an arbitrary/hostile Host header — the base must never come from it. */
function ctxWithHost(host: string): RouteContext {
  return {
    req: { headers: { host } } as unknown as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    query: new URLSearchParams(),
  };
}

describe("first-run ports: the OAuth redirect default follows REST_PORT (#117, ADR 0035 §D4)", () => {
  it("the OAuth redirect default follows REST_PORT", () => {
    delete process.env.PCI_PUBLIC_BASE_URL;
    delete process.env.REST_PORT;
    expect(canonicalBaseUrl()).toBe("http://localhost:8787"); // stock install, unchanged

    process.env.REST_PORT = "9000";
    expect(canonicalBaseUrl()).toBe("http://localhost:9000");
    expect(callbackUrl(ctxWithHost("localhost:9000"), "whoop")).toBe(
      "http://localhost:9000/api/oauth/whoop/callback",
    );
    // The empty string is what compose actually delivers for PCI_PUBLIC_BASE_URL on every install
    // whose operator never edited .env — it must take the DERIVED default, not the frozen one.
    process.env.PCI_PUBLIC_BASE_URL = "";
    expect(canonicalBaseUrl()).toBe("http://localhost:9000");
    // An explicit setting still wins: this derivation only fills the default.
    process.env.PCI_PUBLIC_BASE_URL = "https://gw.example.com";
    expect(canonicalBaseUrl()).toBe("https://gw.example.com");
  });

  it("the redirect default's HOST is pinned to localhost — never the inbound Host, never a tailnet name", () => {
    // ANTI-VACUITY PARTNER for the cell above, and the §D5 guard. Deriving the PORT from env must not
    // become an excuse to derive the HOST from the request: a Host-derived redirect_uri silently
    // mismatches what the operator registered, and a *.ts.net one can NEVER be registered with Google
    // (nobody owns ts.net but Tailscale).
    //
    // It asserts NO PORT, deliberately. Pin defaultBaseUrl() back to the old frozen ":8787" constant
    // and the cell above goes red while THIS one stays green — which is what makes it a partner and
    // not a second copy of the same assertion. It is the Host-independence that is under test, so it
    // is stated as "the inbound Host changes nothing", against a baseline the same call produces.
    process.env.REST_PORT = "9000";
    delete process.env.PCI_PUBLIC_BASE_URL;
    const baseline = callbackUrl(ctxWithHost("localhost"), "google");
    for (const host of ["evil.com", "127.0.0.1:9999", "gateway.example-tailnet.ts.net", "gw.example.com:443"]) {
      expect(callbackUrl(ctxWithHost(host), "google")).toBe(baseline);
    }
    expect(new URL(canonicalBaseUrl()).hostname).toBe("localhost");
    expect(canonicalBaseUrl()).not.toMatch(/ts\.net/);
    expect(canonicalBaseUrl()).toMatch(/^http:\/\/localhost(:\d+)?$/);
    // …and the baseline is the real thing, not an empty string every host would trivially match.
    expect(baseline).toMatch(/^http:\/\/localhost(:\d+)?\/api\/oauth\/google\/callback$/);
  });

  it("an unusable REST_PORT falls back instead of bricking consent", () => {
    delete process.env.PCI_PUBLIC_BASE_URL;
    // "0" and out-of-range are the values that DISABLE the REST edge in bootstrap.ts; the rest are
    // fat-fingers. None of them may throw — a bad knob must never take consent down (#97's lesson).
    for (const bad of ["", "   ", "abc", "0", "-1", "65536", "8787.5", "8787abc"]) {
      process.env.REST_PORT = bad;
      expect(canonicalBaseUrl()).toBe("http://localhost:8787");
    }
  });

  it("REST_PORT=80 emits the address a browser actually shows", () => {
    // http's default port: a browser sends `http://localhost/…`, never `http://localhost:80/…`, and
    // providers exact-match the literal. Emitting the port would mismatch what the user registered.
    delete process.env.PCI_PUBLIC_BASE_URL;
    process.env.REST_PORT = "80";
    expect(canonicalBaseUrl()).toBe("http://localhost");
    expect(callbackUrl(ctxWithHost("localhost"), "microsoft")).toBe(
      "http://localhost/api/oauth/microsoft/callback",
    );
  });

  it("the OAuth default and the REST edge agree on the port when REST_PORT says nothing", () => {
    // The one duplicated literal this design could not remove: `REST_DEFAULT_PORT` must exist in
    // BOTH src/bootstrap.ts (where the edge binds) and src/rest/oauth-routes.ts (where the redirect
    // is composed), because bootstrap.ts → rest/index.ts → oauth-routes.ts makes an import a cycle.
    // So the agreement is asserted here instead of assumed. Change either side alone ⇒ RED.
    const m = /^const REST_DEFAULT_PORT = (\d+);$/m.exec(bootstrapSrc);
    expect(m).not.toBeNull(); // landmark: the constant still exists under that name
    delete process.env.PCI_PUBLIC_BASE_URL;
    delete process.env.REST_PORT;
    expect(canonicalBaseUrl()).toBe(`http://localhost:${m![1]}`);
    // …and compose's own default is that same number, so a stock container agrees with both.
    expect(resolve(envValueToken("REST_PORT"))).toBe(m![1]);
  });
});
