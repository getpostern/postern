# Third-party notices

Postern itself is licensed under the **Apache License, Version 2.0** — the full
text is in [`LICENSE`](LICENSE). This file covers everything Postern *redistributes* that somebody
else wrote: the vendored font binaries, and the npm packages that ride along in the published Docker
image and in the built Console bundle.

Nothing here overrides or is overridden by `LICENSE`. Each component below stays under its own terms.

## What is actually redistributed

Three artefacts leave this repository, and they carry different third-party payloads:

| artefact | third-party content |
|---|---|
| the git repository | the six `.woff2` font binaries (committed); no vendored npm code — only `package-lock.json` references |
| the Docker image | the fonts, the **135**-package production npm tree, and the built Console bundle |
| `apps/web/dist` (the Console bundle) | the fonts, plus **10** MIT packages compiled into the JS |

Build-time tooling (TypeScript, Vite, ESLint, Vitest and their trees) is **not** redistributed: the
runner stage installs with `npm ci --omit=dev`, so none of it exists in the image. It is surveyed
below anyway, because it is resolved from the lockfile a reader of this repository will install.

## Fonts (vendored binaries)

Six `.woff2` cuts of three families live in `apps/web/public/fonts/` and are served from Postern's
own origin — the Console makes zero third-party requests. All three families are under the
**SIL Open Font License, Version 1.1**, and the verbatim upstream licence text for each ships beside
the binaries:

| family | version | licence text | copyright |
|---|---|---|---|
| Cormorant Garamond | 4.001 | [`apps/web/public/fonts/OFL-Cormorant-Garamond.txt`](apps/web/public/fonts/OFL-Cormorant-Garamond.txt) | Copyright 2015 the Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) |
| EB Garamond | 1.003 | [`apps/web/public/fonts/OFL-EB-Garamond.txt`](apps/web/public/fonts/OFL-EB-Garamond.txt) | Copyright 2017 The EB Garamond Project Authors (github.com/octaviopardo/EBGaramond12) |
| Courier Prime | 3.018 | [`apps/web/public/fonts/OFL-Courier-Prime.txt`](apps/web/public/fonts/OFL-Courier-Prime.txt) | Copyright 2015 The Courier Prime Project Authors (github.com/quoteunquoteapps/CourierPrime) |

Each licence file was fetched verbatim on 2026-07-28 from that family's directory in the upstream
Google Fonts repository (`https://raw.githubusercontent.com/google/fonts/main/ofl/<family>/OFL.txt`)
and committed unmodified — not transcribed, not summarised. Versions are the `name` table version
string read out of the vendored binaries themselves, so they describe *these* files rather than
whatever is upstream today. `apps/web/public/fonts/README.md` carries the per-file breakdown and the
sha256 of each binary.

**OFL obligations, and how they are met.** The licence permits redistribution — bundled with software
and sold — provided the fonts are not sold on their own, the copyright and licence notices travel
with them (the three files above), and no Reserved Font Name is used on a modified version. Postern
redistributes the cuts unmodified under their original names and sells no font, so the only live
obligation is the notice, which is satisfied by shipping the texts alongside the binaries and linking
them here. Note the binaries are subset/converted builds whose `name` table carries no embedded
licence field — which is precisely why the standalone texts are required.

## npm packages

Every dependency was surveyed from the installed trees on 2026-07-28. Reproduce with:

```
npm ls --omit=dev --all --parseable      # the 135 packages that ship in the image
```

then read the `license` field of each resolved `package.json`.

### Production tree — ships in the Docker image (135 packages)

| licence | count |
|---|---|
| MIT | 118 |
| ISC | 10 |
| BSD-3-Clause | 2 (`fast-uri`, `qs`) |
| BSD-2-Clause | 1 (`json-schema-typed`) |
| MPL-2.0 | 1 (`ical.js`) |
| MIT-0 | 1 (`nodemailer`) |
| BlueOak-1.0.0 | 1 (`sax`) |
| MIT OR EUPL-1.1+ | 1 (`@zone-eu/mailsplit`, taken under MIT) |

### Console bundle — compiled into `apps/web/dist` (10 packages, all MIT)

`react`, `react-dom`, `scheduler`, `react-router`, `react-router-dom`, `@remix-run/router`,
`@tanstack/react-query`, `@tanstack/query-core`, `loose-envify`, `js-tokens`.

### Development tree — resolved from the lockfile, not redistributed

Across all 405 distinct packages in both lockfiles the additional licences seen are Apache-2.0 (18),
BSD-2-Clause (9), BSD-3-Clause (5), BlueOak-1.0.0 (3), MIT-0 (3), Python-2.0 (1, `argparse`),
CC0-1.0 (1, `mdn-data`) and CC-BY-4.0 (1, `caniuse-lite`). Every one is a permissive licence
compatible with distributing this Apache-2.0 work; none is copyleft over Postern's own source.

### The two with obligations worth naming

**`ical.js` — MPL-2.0 (production dependency; ships in the image).** The Mozilla Public License is
*file-level* copyleft, not project-level: it attaches to the MPL-covered files themselves, and
combining them with differently-licensed code in a "Larger Work" is explicitly permitted (MPL-2.0
§3.3). Postern uses `ical.js` as an unmodified npm dependency and never vendors or edits its sources,
so the obligation is the one MPL §3.2 sets out — anyone receiving the image is entitled to the source
of *those files*, which is published at https://github.com/kewisch/ical.js under the same licence.
If a future change ever modifies `ical.js` sources in-tree, those modified files must be published
under MPL-2.0; that is the line to watch, and today nothing crosses it.

**`caniuse-lite` — CC-BY-4.0 (development dependency; does NOT ship in the image).** The browser
support database behind `browserslist`, used by Vite while building the Console. CC-BY requires
attribution wherever the *data* is redistributed. Postern redistributes the build's output, not the
database, and the runner image never installs it — but it is named here because it is the one entry
in the tree whose licence is a content licence rather than a software licence, and a reader auditing
the lockfile should find it accounted for rather than have to work out whether it was missed.

## Corrections

Found something misattributed, or a package whose licence changed under a version bump? Open an issue
at https://github.com/getpostern/postern/issues — an attribution error is a bug like any other.
