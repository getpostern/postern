# Vendored fonts — three families, six cuts

These `.woff2` binaries are **committed to the repository and served from this app's own
origin**. The Console makes **zero third-party requests** — no CDN fonts, no CDN icons, no
CDN scripts, no runtime-fetched institution logos, now or ever
(`docs/specs/console-port-plan.md` §7 law 3). Replacing any of these with a
`fonts.googleapis.com` `@import` re-opens issue **#81**.

They were copied byte-for-byte from the Postern landing page's own self-hosted set
(`posternLandingPage/site/fonts/`, verified by sha256 at copy time), so the landing and the
Console render identically. The `@font-face` declarations live in
`apps/web/src/styles/fonts.css` and mirror the landing's
(`posternLandingPage/site/css/main.css` lines 7–48).

## The files

| file | family | weights / style | role (locked-assets §8) |
|---|---|---|---|
| `cormorant-garamond-var.woff2` | Cormorant Garamond | 300–700, normal (variable) | the voice — headlines, the argument at the threshold (`--font-display`, `--font-sc`) |
| `cormorant-garamond-500-italic.woff2` | Cormorant Garamond | 500, italic | — |
| `eb-garamond-var.woff2` | EB Garamond | 400–800, normal (variable) | running text + the italic specimen captions (`--font-body`) |
| `eb-garamond-400-italic.woff2` | EB Garamond | 400, italic | the italic gloss used throughout the Console |
| `courier-prime-400.woff2` | Courier Prime | 400, normal | IDs, keys, timestamps, tabular numerals — the record (`--font-mono`, `--font-type`) |
| `courier-prime-700.woff2` | Courier Prime | 700, normal | — |

**Coverage was measured, not assumed.** Against all 47 artboards of the Paper app file
(`01KY3S7JMA16R0QZVSX084WWDD`, `find_nodes`, 2026-07-23): every italic node is `--font-body`
at weight 400; there is no Cormorant italic, no Courier Prime italic, no weight 300 and no
weight 800 in the file. Chivo Mono and IM Fell English SC are loaded in Paper but used by
**zero** nodes. Libre Caslon Text is used by exactly **five** text nodes — drift, which ports
to `--font-display` (program plan §1.2). If a future artboard needs a cut outside these six,
the answer is **another committed binary**, never a fetch.

## Upstream and licence

All three families are under the **SIL Open Font License, Version 1.1**, and each family's full
licence text ships in this directory:

| family | version | upstream | licence text |
|---|---|---|---|
| Cormorant Garamond | 4.001 | Google Fonts (designer: Christian Thalmann / Catharsis Fonts) | `OFL-Cormorant-Garamond.txt` |
| EB Garamond | 1.003 | Google Fonts (designers: Georg Duffner, Octavio Pardo) | `OFL-EB-Garamond.txt` |
| Courier Prime | 3.018 | Google Fonts (Quote-Unquote Apps) | `OFL-Courier-Prime.txt` |

**The versions above were read out of these binaries, not looked up.** An earlier note here said
they were "not determinable from the binaries as vendored" — that was wrong. Subsetting stripped the
licence-description field (`name` ID 13), but the version string (`name` ID 5) survived in every
file. Read it back with `fontTools`:

```
python3 -c "from fontTools.ttLib import TTFont; import sys; \
  t=TTFont(sys.argv[1]); print({r.nameID: str(r) for r in t['name'].names}[5])" <file>.woff2
```

The same read confirms the two variable cuts carry the weight ranges this table claims
(`wght` 300–700 for Cormorant Garamond, 400–800 for EB Garamond).

Each `OFL-*.txt` was fetched **verbatim** on 2026-07-28 from the family's own directory in the
upstream Google Fonts repository —
`https://raw.githubusercontent.com/google/fonts/main/ofl/{cormorantgaramond,ebgaramond,courierprime}/OFL.txt`
— and committed unmodified. Do not edit, reflow, or regenerate them from memory: the licence
obligation is the *verbatim* text, and a hand-typed copy is not one.

## sha256 of the vendored binaries

Recorded so a future change to any file is visible as a change to this list, and so an upstream
refresh can be diffed rather than trusted.

```
efd94eb5c51ddfccfc1bf7b2536cb6f76b234a1cc64bf08149e96415bad160f7  cormorant-garamond-500-italic.woff2
5d618c462b7a5b74f442e1548880086af71764d9cc7d35c16ab45353da934621  cormorant-garamond-var.woff2
21bf7ff8d9e067443a3fe0832ee8e4364faee9ace1fb0ec3e625cd09d231802f  courier-prime-400.woff2
06622415713b4150c18f4489db7c8850300d9f3e55051fc78ed33dca88c5ff08  courier-prime-700.woff2
078bb1c082255b93ded45a05e4009221edb4727f64a77d4f19c9d4715d02e297  eb-garamond-400-italic.woff2
68fd4b247dde89984ee835d99953d235e4927be2b1b732ad81173b519869cee8  eb-garamond-var.woff2
```

## What the licence asks of us

OFL 1.1 permits redistribution — bundled with software, and sold — on three conditions: the fonts
are never sold on their own, the copyright and licence notices travel with them, and no Reserved
Font Name is used on a modified version. We redistribute these cuts unmodified under their original
names and sell no font, so the only live obligation is the notice, and shipping the three `OFL-*.txt`
files beside the binaries is what discharges it. They are also linked from the repository root's
`THIRD-PARTY-NOTICES.md`.

⚠️ These files sit under `public/`, so Vite copies them into `apps/web/dist` verbatim and the gateway
serves them. That is deliberate: it means the licence text reaches anyone who receives the built
Console, not only someone who clones the repository. Deleting them to "clean up static assets" would
put us back in violation.
