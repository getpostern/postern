// The backend↔frontend REDIRECT CONTRACT (#96 §1/§2) — this unit's regression guard.
//
// The gateway 302s a finished OAuth consent onto a Console path. That path is a STRING in
// `src/rest/oauth-routes.ts` and the route table is DATA in `apps/web/src/App.tsx`: two packages,
// two test suites, ~1,700 tests, and nothing that compares them. `/connections` was deleted with the
// dark-SaaS surface (4bbb22f) while it was still the redirect default, so every consent — success
// AND failure — landed on the `*` "— not found" placeholder with the credential already created.
// Nothing went red. This file is the only artifact that makes that defect class catchable.
//
// Precedent for a source-scanning cross-package test: `apps/web/src/api/dead-surface.test.ts`.
//
// `PCI_CONSOLE_SUCCESS_URL` can point the SUCCESS redirect anywhere and is deliberately OUTSIDE this
// contract — it is the operator's own override, and its query-join rule is covered by
// `src/rest/admin.db.test.ts`.

import "../../api/test-dom"; // App.tsx calls createBrowserRouter at module scope → needs window.history
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router-dom";
import { ROUTE_TABLE } from "../../App";
import { providerBySlug } from "./catalog";

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/src/pages/connect
const OAUTH_ROUTES = join(HERE, "../../../../../src/rest/oauth-routes.ts");

const src = readFileSync(OAUTH_ROUTES, "utf8");

/** The redirect targets, read off the NAMED declaration rather than "any string in the file" — so a
 *  rename or a deletion is a failure here, not a silently empty scan. */
function redirectTargets(): string[] {
  const block = /export const CONSOLE_REDIRECT_TARGETS[^{]*\{([\s\S]*?)\n\} as const/.exec(src);
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
}

describe("the OAuth redirect contract", () => {
  it("the declaration is found and carries exactly the four known targets", () => {
    // The vacuity guard. A regex that matched nothing would make every assertion below trivially
    // true — this repo's recorded "test that cannot fail" failure mode (defect-catalog 12).
    const targets = redirectTargets();
    expect(targets.length).toBe(4);
    expect(new Set(targets).size).toBe(4);
    expect([...targets].sort()).toEqual(
      ["/connect/google", "/connect/microsoft", "/connect/whoop", "/sources"].sort(),
    );
  });

  it("every redirect target the gateway can emit resolves to a real Console route", () => {
    for (const target of redirectTargets()) {
      expect(matchRoutes(ROUTE_TABLE, target), `no route matched ${target}`).not.toBeNull();
    }
  });

  it("a redirect target that only matches the catch-all is a dead end, not a match", () => {
    // `matchRoutes(...) !== null` alone is worthless here: `{ path: "*" }` matches EVERYTHING,
    // including the deleted `/connections`. Matching only the splat IS the bug.
    for (const target of redirectTargets()) {
      const m = matchRoutes(ROUTE_TABLE, target);
      expect(m).not.toBeNull();
      expect(m!.at(-1)!.route.path, `${target} matched only the catch-all`).not.toBe("*");
    }
    // …and the guard itself is honest: the splat DOES match a path that no longer exists.
    const dead = matchRoutes(ROUTE_TABLE, "/connections");
    expect(dead).not.toBeNull();
    expect(dead!.at(-1)!.route.path).toBe("*");
  });

  it("every /connect/<slug> target names a provider the catalog can render", () => {
    // `connect/:provider` matches ANY segment, so route resolution alone does not prove the screen
    // exists — ConnectProvider renders "No such source" for an unknown slug.
    const connectTargets = redirectTargets().filter((t) => t.startsWith("/connect/"));
    expect(connectTargets.length).toBe(3);
    for (const target of connectTargets) {
      const slug = target.slice("/connect/".length);
      expect(providerBySlug(slug), `no catalog provider for slug ${slug}`).toBeDefined();
    }
  });

  it("the deleted /connections route appears nowhere in oauth-routes.ts", () => {
    expect(src).not.toContain('"/connections"');
  });
});
