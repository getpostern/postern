// Release-packaging tests: the build config split, the image's runtime contract, the package
// identity, and the third-party licence obligations. Sibling of src/secrets/packaging.test.ts (which
// owns compose env DELIVERY); this file owns everything that decides what the PUBLISHED artefact is.
//
// Like its sibling, everything here reads the real files as TEXT — no YAML/JSON5 parser, no new
// dependency — and every slice is guarded so it cannot pass vacuously against an empty string. The
// defects these cover are all invisible to runtime tests: they live in the packaging, and the first
// time you learn about them is when a stranger runs `docker run` or reads a licence file that is not
// there.

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRestApp, defaultStaticDir, type RestDeps } from "./rest/index.js";

/** Repo root, resolved from this module so the tsc probe below does not depend on the cwd. */
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const read = (rel: string): string => readFileSync(new URL("../" + rel, import.meta.url), "utf8");

const rootTsconfig = read("tsconfig.json");
const buildTsconfig = read("tsconfig.build.json");
const dockerfile = read("Dockerfile");
const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
const consolePkg = JSON.parse(read("apps/web/package.json")) as Record<string, unknown>;
const notices = read("THIRD-PARTY-NOTICES.md");

/** Strip `//` line comments so a rule cannot be satisfied by a commented-out or documented example. */
function jsoncBody(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("build config: the emit narrows, the CHECK stays wide", () => {
  // The trap this whole split exists for: putting the excludes in tsconfig.json would keep test code
  // out of dist/ AND silently stop type-checking 147 files, because `npm run typecheck`, CI and
  // .claude/hooks/typecheck.sh all run against the root config. The loss would be invisible — vitest
  // resolves those files itself, so the suite stays green while nothing checks their types.
  it("the ROOT tsconfig still includes src wholesale and excludes nothing", () => {
    const body = jsoncBody(rootTsconfig);
    expect(body).toContain('"include": ["src"]'); // guard: this is the config we think it is
    expect(body).not.toMatch(/"exclude"\s*:/);
  });

  it("the BUILD tsconfig extends the root one and keeps every test shape out of the emit", () => {
    const body = jsoncBody(buildTsconfig);
    expect(body).toMatch(/"extends"\s*:\s*"\.\/tsconfig\.json"/); // inherits every compilerOption
    for (const pattern of ["*.test.ts", "*.fixtures.ts", "*.conformance.ts"]) {
      expect(body).toContain(pattern);
    }
    // The barrel + the Vitest-importing harness. `exclude` does NOT stop tsc emitting a file that an
    // INCLUDED file imports, so excluding conformance.ts alone is not enough — the barrel re-exports
    // it and would drag it back into dist/, where `import "vitest"` can only throw (the runner image
    // installs with --omit=dev). Both names must be here or the exclusion is decorative.
    expect(body).toContain("src/sdk/conformance.ts");
    expect(body).toContain("src/sdk/index.ts");
  });

  // THE AUTHORITATIVE WITNESS. Everything else in this describe matches TEXT in a config file, and
  // text is not the property that matters — what matters is which files the compiler actually pulls
  // into the build program, and `exclude` does not decide that alone. `exclude` only removes files
  // from the `include` GLOB; any file an included file IMPORTS is pulled back in and emitted anyway.
  //
  // Demonstrated, not theorised: adding `import type { Connector } from "../sdk/index.js"` to one
  // connector — the exact import src/sdk/README.md used to document — re-emits BOTH dist/sdk/index.js
  // and dist/sdk/conformance.js, and the latter `import`s "vitest", which the runner image does not
  // install. Every text assertion above stayed green through that, and `npm run typecheck` too. Only
  // asking the compiler for its file list catches it, so that is what this does.
  it("the build PROGRAM contains no test, fixture, conformance or sdk-barrel input", () => {
    const listed = execFileSync(
      path.join(REPO_ROOT, "node_modules", ".bin", "tsc"),
      ["-p", "tsconfig.build.json", "--listFilesOnly"],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const srcRoot = path.join(REPO_ROOT, "src") + path.sep;
    const ours = listed.filter((f) => f.startsWith(srcRoot)).map((f) => f.slice(REPO_ROOT.length));

    // Guard: a program that somehow listed nothing of ours would pass every filter below vacuously.
    expect(ours.length).toBeGreaterThan(50);
    expect(ours).toContain(path.join("src", "index.ts")); // the real entrypoint is in there
    expect(ours).toContain(path.join("src", "sdk", "contract.ts")); // …and the types connectors need

    const forbidden = ours.filter(
      (f) =>
        /\.(test|fixtures|conformance)\.ts$/.test(f) ||
        f === path.join("src", "sdk", "index.ts") ||
        f === path.join("src", "sdk", "conformance.ts"),
    );
    expect(forbidden).toEqual([]);
  }, 120_000);

  it("the SDK README tells connector authors to import the contract, not the barrel", () => {
    // The doc is the upstream of the defect above: it used to show `../sdk/index.js` for a
    // connector's own types, which is exactly the import that drags the Vitest harness into dist/.
    // The program assertion catches anyone who follows bad advice; this keeps the advice good.
    const readme = readFileSync(new URL("./sdk/README.md", import.meta.url), "utf8");
    expect(readme).toContain("../sdk/contract.js");
    expect(readme).toContain("Never import `sdk/index.js` from a file that ships");
  });

  it("`npm run build` compiles the BUILD config while `npm run typecheck` checks the root one", () => {
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.build).toContain("tsconfig.build.json");
    // typecheck must NOT name the build config — that would re-open the hole from the other side.
    expect(scripts.typecheck).not.toContain("tsconfig.build.json");
    expect(scripts.typecheck).toContain("--noEmit");
  });
});

describe("Dockerfile: what a bare `docker run` gets", () => {
  it("is the real multi-stage build (guard)", () => {
    expect(dockerfile).toContain("AS builder");
    expect(dockerfile).toContain("AS runner");
  });

  it("copies BOTH tsconfigs into the builder — the build config extends the root one", () => {
    // Copying only tsconfig.build.json fails the image build outright ("File not found: tsconfig.json"),
    // but copying only tsconfig.json fails it just as hard, and a `COPY tsconfig*.json` that someone
    // later narrows would ship test code again. Assert both names reach the builder.
    const copies = dockerfile.match(/^COPY .*tsconfig.*$/gm)?.join("\n") ?? "";
    expect(copies).toContain("tsconfig.json");
    expect(copies).toContain("tsconfig.build.json");
  });

  it("binds 0.0.0.0 INSIDE the container for both edges", () => {
    // src/bootstrap.ts defaults REST_HOST to 127.0.0.1 and that is right for `npm start` on a laptop.
    // Inside a container it means container-loopback, so `docker run -p 8787:8787` reaches nothing and
    // the Console times out silently. Safety is the HOST publish (compose publishes on 127.0.0.1),
    // never the in-container bind. Anchored to ENV lines so a mention in a comment cannot satisfy it.
    expect(dockerfile).toMatch(/^ENV REST_HOST=0\.0\.0\.0\s*$/m);
    expect(dockerfile).toMatch(/^ENV MCP_HTTP_HOST=0\.0\.0\.0\s*$/m);
  });

  it("carries the OCI labels GHCR needs to link, license and describe the package", () => {
    // Without `source` the published package is not linked to its repository: it defaults to private
    // and renders no README. `licenses` must match LICENSE and both package.json files.
    expect(dockerfile).toContain("org.opencontainers.image.source=");
    expect(dockerfile).toContain("https://github.com/getpostern/postern");
    expect(dockerfile).toContain('org.opencontainers.image.licenses="Apache-2.0"');
    expect(dockerfile).toContain("org.opencontainers.image.description=");
  });

  it("the entrypoint starts the server directly — no racing pre-boot migrate step", () => {
    const entrypoint = dockerfile.match(/^ENTRYPOINT .*$/m)?.[0] ?? "";
    expect(entrypoint).toContain("dist/index.js"); // guard: we found the real line
    // `node dist/db/migrate.js && …` opened ONE pg.Client with no retry, so any gap before Postgres
    // accepted TCP killed the container on a race the server itself survives: src/index.ts runs
    // awaitDbReady() (retrying) and THEN runMigrations(), fail-closed, before any edge serves.
    expect(entrypoint).not.toContain("migrate");
  });
});

// This block guards PROSE, which is unusual, and it is here because the prose IS the control. The
// image binds 0.0.0.0 inside the container — correct, and non-negotiable, since a container-loopback
// bind makes every port mapping reach nothing. That makes `docker run -p 8787:8787` a command that
// works, and the addressless form publishes on every interface. Port 8787 carries onboarding, audit
// and agent-key minting with NO per-request authentication behind a Host-header allowlist that a
// client can simply satisfy, so the publish address is the entire boundary. Nothing in code can
// enforce how someone runs the image; the only available control is telling them, unmissably, in the
// two files they read. If that text goes, the control goes, and these assertions are what notices.
describe("the image says how to publish it safely", () => {
  const envExample = read(".env.example");

  it("the Dockerfile leads with the safe publish form and names the unsafe one", () => {
    expect(dockerfile).toContain("-p 127.0.0.1:8787:8787"); // the form that is safe
    expect(dockerfile).toMatch(/UNSAFE\s+docker run -p 8787:8787/); // …labelled against the one that is not
  });

  it("the Dockerfile explains WHY this image in particular", () => {
    expect(dockerfile).toContain("NO per-request authentication");
    expect(dockerfile).toMatch(/Host: localhost/); // the header that defeats the allowlist
    expect(dockerfile).toContain("0.0.0.0"); // what the addressless form actually means
  });

  it(".env.example carries the same guidance, in the section about binding", () => {
    expect(envExample).toMatch(/SAFE\s+docker run -p 127\.0\.0\.1:8787:8787/);
    expect(envExample).toMatch(/UNSAFE\s+docker run -p 8787:8787/);
    expect(envExample).toContain("NO per-request authentication");
    // …and the supported alternative, so the reader is not left with only a prohibition.
    expect(envExample).toMatch(/tailscale serve|SSH tunnel|reverse proxy/);
  });

  it("no file hands the reader a recipe for opening the port", () => {
    // docker-compose.yml used to say: "to expose deliberately, drop the 127.0.0.1: prefix AND set
    // REST_ALLOWED_HOSTS" — a step-by-step for the exact exposure, phrased as a supported option,
    // with a second setting alongside it that reads like a safety measure and is not one
    // (REST_ALLOWED_HOSTS widens which Host values are ACCEPTED; it adds no identity check).
    // Assert the RECIPE is gone rather than the words: compose still says "DO NOT DROP THE
    // 127.0.0.1: PREFIX", which contains the same words and is the opposite instruction.
    const compose = read("docker-compose.yml");
    for (const text of [dockerfile, compose, envExample]) {
      expect(text).not.toMatch(/to expose (it )?deliberately/i);
      expect(text).not.toMatch(/drop the ["'`]?127\.0\.0\.1[:"'`]* ?prefix AND set/i);
    }
    // …and the prohibition that replaced it is really there (guard: the two assertions above are
    // satisfied by a file that says nothing at all about the prefix).
    expect(compose).toMatch(/DO NOT DROP THE "127\.0\.0\.1:" PREFIX/);
  });
});

describe("package identity and license", () => {
  it("the gateway package is Postern, Apache-2.0, node>=22 — and still private", () => {
    expect(pkg.name).toBe("postern");
    // The tree relicensed AGPL-3.0-or-later -> Apache-2.0: an AGPL SDK cannot be linked by a
    // commercial connector or agent author without opening their source, which forecloses the
    // third-party ecosystem the platform is. This assertion, the Dockerfile label and LICENSE
    // must agree; the three drifting apart is how a repo ends up claiming two licences at once.
    expect(pkg.license).toBe("Apache-2.0");
    expect((pkg.engines as Record<string, string>).node).toBe(">=22");
    expect((pkg.repository as Record<string, string>).url).toContain("getpostern/postern");
    // npm publication is deliberately out of scope — private:true is what keeps an accidental
    // `npm publish` from shipping a package whose `files`/.npmignore nobody has designed yet.
    expect(pkg.private).toBe(true);
  });

  it("the Console package matches it", () => {
    expect(consolePkg.name).toBe("@postern/console");
    expect(consolePkg.license).toBe("Apache-2.0");
    expect(consolePkg.private).toBe(true);
  });

  it("LICENSE is the Apache-2.0 text itself, not just a claim about it", () => {
    // The metadata assertions above prove the three CLAIMS agree with each other — they never
    // read the LICENSE body, so Apache metadata over an AGPL LICENSE passed green. That gap is
    // the exact drift this block exists to refuse, so the text is read, not trusted.
    const license = read("LICENSE");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).not.toMatch(/GNU AFFERO|AGPL/);
  });

  it("the wire/env/DB identifiers keep their historical pci prefix", () => {
    // Deliberately NOT renamed with the package (spec §6): PCI_* env names, the `pci` DB role and the
    // X-PCI-Webhook-Secret header are live-deployment contracts, and renaming them breaks every
    // existing install for cosmetics. This asserts the decision so a future "finish the rename" pass
    // has to argue with a test instead of quietly breaking upgrades.
    const compose = read("docker-compose.yml");
    expect(compose).toContain("PCI_MASTER_KEY");
    expect(compose).toContain("POSTGRES_USER:-pci");
  });
});

describe("the Console directory is found relative to the MODULE, never the cwd", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    delete process.env.PCI_CONSOLE_DIR;
  });

  it("resolves to the same absolute path from any working directory", () => {
    // THE BUG: it was the cwd-relative literal "apps/web/dist", so `node dist/index.js` started from
    // anywhere but the image/repo root served a JSON 404 for every browser request with nothing in
    // the logs explaining it. Two calls from two different cwds is the only assertion that can tell
    // a module-relative resolution apart from a cwd-relative one.
    const fromRepo = defaultStaticDir();
    process.chdir(tmpdir());
    const fromElsewhere = defaultStaticDir();
    expect(path.isAbsolute(fromRepo)).toBe(true);
    expect(fromElsewhere).toBe(fromRepo);
    expect(fromRepo.endsWith(path.join("apps", "web", "dist"))).toBe(true);
  });

  it("PCI_CONSOLE_DIR overrides it, and an EMPTY value is read as unset", () => {
    const builtin = defaultStaticDir();
    process.env.PCI_CONSOLE_DIR = path.join(tmpdir(), "somewhere-else");
    expect(defaultStaticDir()).toBe(path.join(tmpdir(), "somewhere-else"));
    // Empty must mean unset: docker-compose's `${VAR:-}` idiom delivers "" for every unset knob, so a
    // naive truthiness-free read would point the Console at the process cwd for every Docker user.
    process.env.PCI_CONSOLE_DIR = "";
    expect(defaultStaticDir()).toBe(builtin);
  });
});

// The "say it once" flag is module-level, so these cases share it. That is safe WITHOUT relying on
// which other suites exist: vitest gives every test FILE its own module registry (isolate defaults to
// true), so the flag starts unset here no matter how many other suites import createRestApp — and
// several do (rest/healthz, rest/app, rest/ingest, rest/exposure-routes, plus src/bootstrap.ts at
// boot). Order still matters WITHIN this block: the no-repeat case has to follow the case that fires.
describe("a missing Console announces itself exactly once, on a real miss", () => {
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Console assets not found"));

  /** Mount the app on a real socket, make one request, tear it down. Returns the status. */
  async function requestOnce(deps: RestDeps, pathname: string): Promise<number> {
    const server = createServer(createRestApp(deps));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      return (await fetch(`http://127.0.0.1:${port}${pathname}`)).status;
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("stays silent when the directory exists — a missing FILE is an ordinary 404", async () => {
    // tmpdir() exists but holds no index.html, so this is a genuine static miss against a present
    // build directory. Commenting on that would make the line fire on every 404 a real deploy serves.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await requestOnce({ staticDir: tmpdir() }, "/some-page")).toBe(404);
    expect(lines(spy)).toEqual([]);
    spy.mockRestore();
  });

  it("stays silent for an /api miss — that is never a Console request", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = path.join(tmpdir(), "postern-no-console-here");
    expect(await requestOnce({ staticDir: missing }, "/api/nope")).toBe(404);
    expect(lines(spy)).toEqual([]);
    spy.mockRestore();
  });

  it("names the path, the failing request, and both fixes when the build is absent", async () => {
    // Without this line the failure is completely silent: /healthz green, the API answering, and the
    // browser getting {"error":"not found"} with nothing anywhere connecting it to a missing build.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = path.join(tmpdir(), "postern-no-console-here");
    expect(await requestOnce({ staticDir: missing }, "/sources")).toBe(404);
    expect(lines(spy)).toHaveLength(1);
    expect(lines(spy)[0]).toContain(missing); // the directory we ACTUALLY looked in
    expect(lines(spy)[0]).toContain("/sources"); // the request that failed
    expect(lines(spy)[0]).toContain("PCI_CONSOLE_DIR"); // the knob that fixes it
    expect(lines(spy)[0]).toContain("npm run build --prefix apps/web"); // the other way to fix it
    spy.mockRestore();
  });

  it("does not repeat itself on the next request", async () => {
    // A browser retrying, or a health-checking proxy, must not turn one diagnostic into a log flood.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = path.join(tmpdir(), "postern-still-no-console");
    expect(await requestOnce({ staticDir: missing }, "/audit")).toBe(404);
    expect(lines(spy)).toEqual([]);
    spy.mockRestore();
  });
});

describe("third-party licence obligations", () => {
  const FONT_LICENSES = [
    "apps/web/public/fonts/OFL-Cormorant-Garamond.txt",
    "apps/web/public/fonts/OFL-EB-Garamond.txt",
    "apps/web/public/fonts/OFL-Courier-Prime.txt",
  ];

  it("every vendored font family ships the VERBATIM OFL 1.1 text, not a summary", () => {
    for (const rel of FONT_LICENSES) {
      const text = read(rel);
      // Length + the licence's own structural headings: a one-line "licensed under OFL 1.1" note or a
      // paraphrase satisfies neither. These strings are from the licence body itself.
      expect(text.length).toBeGreaterThan(3000);
      expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(text).toContain("PERMISSION & CONDITIONS");
      expect(text).toContain("Reserved Font Name");
      expect(text).toContain("TERMINATION");
      expect(text).toMatch(/^Copyright \d{4}/m); // the per-family copyright line
    }
  });

  it("each of the six woff2 binaries is covered by one of those three texts", () => {
    // Guard against a seventh cut being vendored with no licence: the family list here is derived from
    // the file names on disk, so adding `some-new-family-400.woff2` fails until its OFL ships too.
    const dir = new URL("../apps/web/public/fonts/", import.meta.url);
    const files = readFileSync(new URL("README.md", dir), "utf8");
    const covered = ["cormorant-garamond", "eb-garamond", "courier-prime"];
    const cuts = [...files.matchAll(/`([a-z0-9-]+)\.woff2`/g)].map((m) => m[1]);
    expect(cuts.length).toBe(6); // guard: the README table was actually parsed
    for (const cut of cuts) {
      expect(covered.some((fam) => cut.startsWith(fam))).toBe(true);
    }
  });

  it("THIRD-PARTY-NOTICES.md names the two dependencies that carry real obligations", () => {
    expect(notices).toContain("ical.js");
    expect(notices).toContain("MPL-2.0");
    expect(notices).toContain("caniuse-lite");
    expect(notices).toContain("CC-BY-4.0");
    // …and points at the font texts, so the fonts are discoverable from the repository root.
    for (const rel of FONT_LICENSES) expect(notices).toContain(rel);
  });
});
