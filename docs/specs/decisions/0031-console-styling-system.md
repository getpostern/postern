# ADR 0031 — The Console's styling system: CSS Modules over inline styles

**Status:** Accepted 2026-07-24 · **Supersedes:** the U0 Console's inline-style convention · **Related:** #66 #67 #68 #69 #81, ADR 0023 (the server names the state)

## Context

The Console being replaced is **100% inline-styled** — every component builds a `style={{…}}` object. The 2026-07-21 UX audit found that this is not a stylistic preference but a structural blocker, and it named the consequences precisely:

- **No responsive layout is possible** (#67). The Shell is a fixed two-column grid with a hard 248px sidebar and a 1440px cap; there is not one width media query in the app, because an inline style cannot express one. The documented 64px collapse rail exists as a token and is referenced nowhere.
- **No focus system is possible** (#69). `grep ':focus|focus-visible'` over the entire app returned **zero matches**. An inline style cannot express a pseudo-class, so the app drove focus rings off `onFocus` state flags — which fire on mouse click too. Sortable headers were `<th onClick>` and drill rows `<tr onClick>`: unreachable by keyboard.
- **No systematic contrast guarantee** (#68). Two of four text tokens failed WCAG AA in both themes, on content-bearing metadata, and nothing could catch it.

The audit's own conclusion: *"Because the app is 100% inline-styled, breakpoints and focus states are a structural rebuild, not a patch"* — and it lists a styling-system decision as a prerequisite the revamp spec must make.

## Decision

**CSS Modules**, colocated: every component ships `X.module.css` beside `X.tsx`. The token layer stays plain CSS custom properties in one `tokens.css`, reproduced 1:1 from the Paper design file so the Console and the landing site cannot drift.

Inline `style={{…}}` is banned for anything a stylesheet can express. The only sanctioned survivors are genuinely dynamic values — a computed width, a colour the *server* named.

## Alternatives considered

- **One global stylesheet with BEM naming.** Simplest, no build concern, but 43 pages of globally-scoped names collide, and the discipline that prevents it is convention rather than the compiler. Rejected.
- **Tailwind.** A second vocabulary layered over a design system that is *already* fully tokenised in Paper — and the port's binding rule is that tokens map 1:1 to `var(--…)` names read from the design file. Utility classes would restate that system in a different alphabet, and every value would need translating on the way in and back out. It also adds a dependency and a build step to a self-hosted app whose whole promise is that it is small and local. Rejected.
- **CSS-in-JS (styled-components / emotion).** Solves pseudo-classes and media queries, but adds a runtime dependency and re-introduces the "styles live in the component file" habit that made the old app hard to audit. Rejected.

## Consequences

- Breakpoints, `:focus-visible`, `prefers-reduced-motion` and `aria-*`-driven styling all become ordinary CSS. **One** focus ring is declared globally and inherited, rather than re-implemented per component.
- Zero new runtime dependencies: Vite handles `*.module.css` natively and `vite/client` already types it, so the adopting unit needed **no config change at all**.
- The token layer is machine-checkable. A 42-test validator now computes WCAG contrast for every (text token × ground) pair, fails the build if an ink-alpha or rule token is used as a `color:` value, and asserts that no stylesheet — or `index.html` — references any third-party origin.
- Two dev-only dependencies (`jsdom`, `@testing-library/react`) are added so keyboard and focus behaviour can be *tested* rather than asserted in prose. They ship to no server.

## Note on scope

This ADR covers *how* styles are expressed. **What** they express is the design system itself — the design file the tokens are read from, and the paper/ink constitution in `docs/design/soul.md` — neither of which this decision may reinterpret.
