// A DOM for tests that need one, bootstrapped explicitly rather than via vitest's `environment`.
//
// Why not `// @vitest-environment jsdom`: the suite is run by the ROOT vitest (`npm test` at the
// repo root discovers `apps/web/**`), and vitest resolves an environment package from its OWN
// install — `<repo>/node_modules/vitest` — while `jsdom` lives in `apps/web/node_modules` because
// `apps/web` is not a root workspace (it carries its own lockfile, which the Dockerfile relies on;
// see console-port-plan §1.1 / #90). So the magic comment fails with ERR_MODULE_NOT_FOUND.
//
// A plain `import { JSDOM }` from a file INSIDE apps/web resolves normally (node walks up from the
// importing file), so the DOM is installed here by hand. This is a test-only shim; when #90 is
// fixed — apps/web becomes a workspace, or the root config declares the environment — this file
// deletes and the magic comment works.
//
// Not exported from any production path. Import it for its side effect: `import "./test-dom";`.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const win = dom.window as unknown as Window & typeof globalThis;

// Some of these globals (notably `navigator` on Node 22) are getter-only on globalThis, so a plain
// assignment throws. `put` defines the property forcefully and skips the ones the platform already
// provides compatibly.
function put(name: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    // Already present and non-redefinable (e.g. Node's own `navigator`) — the built-in is fine.
  }
}

put("window", win);
put("document", win.document);
put("navigator", win.navigator);
put("location", win.location);
put("history", win.history);
put("HTMLElement", win.HTMLElement);
put("Element", win.Element);
put("Node", win.Node);
put("Event", win.Event);
put("CustomEvent", win.CustomEvent);
put("MutationObserver", win.MutationObserver);
put("getComputedStyle", win.getComputedStyle.bind(win));
put("requestAnimationFrame", win.requestAnimationFrame?.bind(win));
put("cancelAnimationFrame", win.cancelAnimationFrame?.bind(win));

// React 18 refuses to run `act()` without this, and @testing-library/react wraps every render in it.
put("IS_REACT_ACT_ENVIRONMENT", true);

export { dom };
