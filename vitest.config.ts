import { defineConfig, configDefaults } from "vitest/config";

// Exclude the harness's transient agent worktrees (.claude/worktrees/*) so a main-tree
// `npm test` never discovers and re-runs the same suites copied inside them.
export default defineConfig({
  test: {
    // Fail-closed preflights: run ONCE before any test module and abort the whole run. TWO of them,
    // so "my run aborted before any test" is not always the database: (1) DATABASE_URL pointing at a
    // non-disposable database (anything not matching /_test$/i, absent PCI_TEST_DB=1), and (2)
    // apps/web's own dependencies not installed, whose remedy is `npm ci --prefix apps/web` (#94).
    // Read the thrown sentence — each names its own fix. See vitest.globalSetup.ts +
    // docs/specs/decisions/0015-test-db-isolation.md.
    globalSetup: ["./vitest.globalSetup.ts"],
    // …and the publish pipeline's emitted public tree (release/out/, gitignored): it carries its own
    // full suite, which the pipeline runs INSIDE the tree with the tree's own installed deps. Collected
    // from the private root it double-runs 2700+ tests at best and, with the tree's deps absent, turns
    // every bare `npm test` after a `publish.sh` run into dozens of ENOENT-red suites that look like
    // real failures. This excludes only the generated ARTIFACT — never apps/web or any authored suite.
    exclude: [...configDefaults.exclude, ".claude/**", "**/.claude/**", "release/out/**"],
  },
});
