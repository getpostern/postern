#!/usr/bin/env bash
#
# link-check.sh — every relative link in the shipped documentation resolves to a file that ships.
#
# WHY THIS EXISTS AT ALL, AND WHY IT IS NOT COSMETIC. This tree is a FILTERED snapshot: a private
# working repository minus everything that was never meant to be public. A document that survives the
# filter keeps every link it had, including the ones that pointed at a document that did not survive.
# The result is a public README linking to a file nobody outside can see, or worse, a security page
# citing an operating procedure that was deliberately withheld. Nothing else in the pipeline notices
# — the file is gone, the link is text, the build is green. This check is the thing that notices.
#
# WHAT IT CHECKS
#   · markdown  `[text](target)`  and reference definitions  `[label]: target`
#   · html      href="target"  and  src="target"
#   · the target file exists, relative to the linking file
#   · for a markdown target, an `#anchor` matches a heading in the target document
#
# WHAT IT SKIPS, deliberately: absolute URLs (http/https/mailto/tel/data), protocol-relative URLs,
# and anchors into non-markdown files (an HTML page's ids are not headings and guessing at them
# produces false failures, which is how a check gets deleted).
#
# USAGE
#     .github/scripts/link-check.sh [root]        # default: the current directory
#
# Exit 0 = every link resolves · 1 = dead links, listed · 2 = the check itself is broken (no docs
# found, no links found), which is never reported as "clean".
#
# PORTABILITY: POSIX-ish bash, no `mapfile`, no associative arrays, no `realpath -m` — it runs on the
# ubuntu runner and on a macOS box whose /bin/bash is still 3.2.

set -uo pipefail

ROOT="${1:-.}"
cd "$ROOT" || { printf 'link-check: no such directory: %s\n' "$ROOT" >&2; exit 2; }

dead=0
checked=0

WORK="$(mktemp -d "${TMPDIR:-/tmp}/link-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DOCS="$WORK/docs"

find . \
  \( -name node_modules -o -name .git -o -name dist -o -name coverage \) -prune -o \
  -type f \( -name '*.md' -o -name '*.html' \) -print |
  sed 's|^\./||' |
  sort >"$DOCS"

doc_count=$(wc -l <"$DOCS" | tr -d ' ')
if [ "$doc_count" -eq 0 ]; then
  printf 'link-check: found no .md or .html under %s — the walk is broken, not the tree\n' "$ROOT" >&2
  exit 2
fi

# Collapse `.` and `..` textually. `realpath -m` would be one line and does not exist on macOS, and
# the physical variants resolve symlinks, which is the wrong answer for a link inside a document.
normalize() { # normalize <path>
  local path="$1" out="" part
  local IFS='/'
  # shellcheck disable=SC2086
  set -- $path
  for part in "$@"; do
    case "$part" in
      "" | ".") ;;
      "..")
        case "$out" in
          */*) out="${out%/*}" ;;
          *) out="" ;;
        esac
        ;;
      *) out="${out:+$out/}$part" ;;
    esac
  done
  printf '%s' "$out"
}

# GitHub-flavoured heading slug: lower-case, drop everything outside [a-z0-9 _-], spaces to dashes.
# The same derivation the repository's own exposure-docs guard uses, so the two agree about anchors.
slugify() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -e 's/[^a-z0-9 _-]//g' -e 's/^ *//' -e 's/ *$//' -e 's/ /-/g'
}

anchor_exists() { # anchor_exists <markdown file> <anchor>
  local file="$1" want="$2" heading
  # Explicit HTML anchors are legitimate targets too — `<a id="…">` / `<a name="…">`.
  if grep -qE "(id|name)=\"$want\"" "$file" 2>/dev/null; then return 0; fi
  while IFS= read -r heading; do
    [ "$(slugify "$heading")" = "$want" ] && return 0
  done < <(sed -n 's/^#\{1,6\}[[:space:]]\{1,\}\(.*\)$/\1/p' "$file")
  return 1
}

report() { # report <linking file> <target> <reason>
  printf '%s: %s — %s\n' "$1" "$3" "$2"
  dead=$((dead + 1))
}

while IFS= read -r doc; do
  [ -n "$doc" ] || continue
  dir="$(dirname "$doc")"
  [ "$dir" = "." ] && dir=""

  # Harvest markdown inline links, markdown reference definitions, and html href/src, one target per
  # line. Each pattern extracts the target and nothing else, so the loop below sees plain paths.
  {
    grep -oE '\]\([^)[:space:]]+\)' "$doc" 2>/dev/null | sed -e 's/^](//' -e 's/)$//'
    grep -oE '^\[[^]]+\]:[[:space:]]*[^[:space:]]+' "$doc" 2>/dev/null | sed 's/^.*:[[:space:]]*//'
    grep -oE '(href|src)="[^"]+"' "$doc" 2>/dev/null | sed -e 's/^[a-z]*="//' -e 's/"$//'
  } | while IFS= read -r target; do
    [ -n "$target" ] || continue
    case "$target" in
      http://* | https://* | mailto:* | tel:* | data:* | //*) continue ;;
      # A ROOT-RELATIVE target resolves against the SERVED root, which is not the repository root
      # and is not knowable from the filesystem. `apps/web/index.html` is the live example: its
      # `/postern-door.svg` and `/src/main.tsx` are served from `apps/web/`, both files exist, and
      # resolving them from the repository root would report two dead links that are not dead. A
      # checker that cries wolf on working links is a checker somebody switches off.
      /*) continue ;;
    esac

    rel="${target%%#*}"
    case "$target" in
      *"#"*) anchor="${target#*#}" ;;
      *) anchor="" ;;
    esac

    # A bare `#anchor` points into the linking document itself.
    if [ -z "$rel" ]; then
      resolved="$doc"
    else
      resolved="$(normalize "${dir:+$dir/}$rel")"
    fi

    printf 'CHECK\n'
    if [ ! -e "$resolved" ]; then
      printf 'DEAD\t%s\t%s\t%s\n' "$doc" "$target" "link target does not exist in the published tree"
      continue
    fi
    if [ -n "$anchor" ]; then
      case "$resolved" in
        *.md)
          if ! anchor_exists "$resolved" "$anchor"; then
            printf 'DEAD\t%s\t%s\t%s\n' "$doc" "$target" "anchor matches no heading in the target document"
          fi
          ;;
      esac
    fi
  done
done <"$DOCS" >"$WORK/results"

checked=$(grep -c '^CHECK$' "$WORK/results" 2>/dev/null || true)
[ -n "$checked" ] || checked=0

while IFS="$(printf '\t')" read -r tag doc target reason; do
  [ "$tag" = "DEAD" ] || continue
  report "$doc" "$target" "$reason"
done <"$WORK/results"

printf -- '---\n'
printf 'link-check: %s relative link(s) across %s document(s) under %s\n' "$checked" "$doc_count" "$ROOT"

# ANTI-VACUITY. A harvest that silently stops matching turns this check into a green light forever.
# The tree always has relative links; zero means the extraction broke, not that the docs are perfect.
if [ "$checked" -eq 0 ]; then
  printf 'link-check: FAILED — harvested no relative links at all, so the extraction is broken\n' >&2
  exit 2
fi

if [ "$dead" -gt 0 ]; then
  printf 'link-check: FAILED — %d dead link(s)\n' "$dead"
  exit 1
fi
printf 'link-check: clean\n'
exit 0
