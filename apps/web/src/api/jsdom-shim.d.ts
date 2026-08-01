// Minimal ambient types for `jsdom`, which ships no `.d.ts` and has no `@types/jsdom` installed.
//
// Only `test-dom.ts` imports it, only in tests, and only for the two members it uses. A full type
// dependency would be dead weight in a package whose production build never touches jsdom. When #90
// makes apps/web a proper workspace with a jsdom test environment, both this shim and `test-dom.ts`
// go away together.

declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis;
  }
}
