// Flat ESLint config — a FORWARD gate, deliberately light.
//
// Goal (wave 9C): catch real mistakes going forward without churning the existing tree. So the
// typescript-eslint *recommended* set is on, but the rules that the current code legitimately trips
// are downgraded to WARN — `npm run lint` exits 0 today (eslint is non-zero only on ERRORs), and a
// reviewer still sees the warnings. New code should aim for zero warnings.
//
// Repo conventions encoded here:
//   - stderr-only logging: `console.log` (stdout) is flagged; `console.error`/`console.warn`
//     (stderr) are allowed. (CLAUDE.md: never log to stdout — stdout is the MCP stdio transport.)
//   - `.js` extensions on relative imports are enforced by NodeNext + `tsc` (the typecheck gate),
//     not duplicated here (would need eslint-plugin-import, which is not a dependency).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Build output (incl. nested, e.g. apps/web/dist), deps, and the harness's transient worktrees.
    // Use **/ so nested build/dep dirs are ignored too — a bare `dist/**` only matches the repo root.
    // `docs/**` holds design-tool exports and vendored UI-kit JavaScript, not source. Linting it
    // produced 969 `no-undef` errors for browser globals in files nobody ships — enough to fail the
    // lint step outright the first time it ever got to run.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      ".claude/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // stdout is reserved for the MCP stdio transport — only stderr logging is allowed.
      "no-console": ["warn", { allow: ["error", "warn"] }],

      // Pre-existing style trips these in places; warn (don't break) so the gate is additive.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "no-empty": "warn",
    },
  },
  {
    // Tests reach for loose types and dynamic shapes; keep those purely advisory there.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // apps/web is the Console: browser code, not Node. Without browser globals every `window`,
    // `document`, `fetch`, `URL`, `Node`, `console` reference is a `no-undef` ERROR — 969 of them,
    // which is what CI reported the first time the lint step ever got to run (before 2026-07-24 the
    // test step always failed first, so apps/web had never actually been linted).
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // The stdout-is-the-MCP-transport rule is a Node concern; it does not apply in a browser.
      // Still discourage stray logging, but nothing here can corrupt a transport.
      "no-console": ["warn", { allow: ["error", "warn"] }],
    },
  },
);
