#!/usr/bin/env bash
#
# scrub-shapes.sh — the standing leak gate for this repository.
#
# WHAT THIS IS. Postern is published as a snapshot: a private working repository is filtered and
# re-emitted here. The filter runs once per release and it is only as good as the list it was given.
# This script is the part that keeps running afterwards, on every push and every pull request, and it
# checks SHAPES — patterns that identify one particular person's machine, network or account, no
# matter whose machine it is. It needs no list of secrets, which is exactly why it can live in a
# public repository and be read by anyone.
#
# WHAT IT DELIBERATELY DOES NOT DO. It does not scan for any specific real value. A denylist of the
# tokens it exists to keep out would publish them; that is not hypothetical, it is a mistake this
# project made once and fixed. Exact-token scanning happens on the private side, before the snapshot
# is emitted, against a file that never enters git.
#
# SO NEITHER LAYER IS SUFFICIENT AND BOTH RUN. A shape catches a hostname nobody has ever seen, which
# a denylist by construction cannot. A denylist catches a bare machine label or a person's name in
# prose, which has no shape at all. This file is the half that can be public.
#
# USAGE
#     .github/scripts/scrub-shapes.sh [root]      # default: the current directory
#
# Exit 0 = clean · 1 = violations, each printed as `path:line: reason — text` · 2 = the scan itself
# is broken (no directory, no files), which is never reported as "clean".
#
# PORTABILITY: POSIX-ish bash, no `mapfile`, no associative arrays — it runs on the ubuntu runner and
# on a macOS box whose /bin/bash is still 3.2.

set -uo pipefail

ROOT="${1:-.}"
cd "$ROOT" || { printf 'scrub-shapes: no such directory: %s\n' "$ROOT" >&2; exit 2; }

# This script's own path, relative to the root it scans. It necessarily CONTAINS every pattern it
# forbids, so scanning it would report itself forever. The exemption is one exact path, and it is
# covered from the other side: the private-side pipeline runs its exact-token needle scan over the
# whole emitted tree with nothing exempted, this file included.
SELF=".github/scripts/scrub-shapes.sh"

# ── Allowlists, and the reasoning behind each one ──────────────────────────────────────────────────
#
# Every allowlist here is a hole, so each is written as narrowly as the evidence allows and each says
# what covers the hole from the other side.

# TEST FILES are exempt from the two HOSTNAME rules (2 and 3). A test's hostnames are its fixture
# corpus — invented strings fed to a parser to prove it accepts and rejects the right things — and
# the parser under test here is literally the one that reads tailnet names, so its corpus MUST
# contain tailnet-shaped strings that are not placeholders. Forbidding them would mean deleting the
# tests that prove the feature works, which is not a security improvement.
#
# What covers the hole: the private-side needle scan runs over the whole tree, tests included, with
# the real token list, and nothing is exempt from it. A real hostname pasted into a test is caught
# there — before the snapshot is emitted — rather than here.
is_test_file() {
  case "$1" in
    *.test.ts | *.test.tsx | *.test.js | *.test.jsx | *.test.mjs | *.spec.ts | *.spec.tsx) return 0 ;;
    *) return 1 ;;
  esac
}

# NON-TEST files may print a `*.ts.net` name only in a substitute-your-own form. A tailnet FQDN is
# `<machine>.<tailnet>` and BOTH labels identify somebody's box, so the test is on the whole name:
#
#   · it contains `example`            — the reserved-for-documentation convention, and what the
#                                        shipped Console placeholders and the runbooks already use
#   · its tailnet label is `tailnet`   — `your-mac.tailnet.ts.net`, the form the Console shows a user
#   · it carries `<`, `>`, `*` or `%`  — the prose and query wildcards (`<machine>.<tailnet>.ts.net`)
#
# Compared lower-cased, because a hostname is case-insensitive to every resolver on earth and a
# case-sensitive rule is a bypass that costs one shift key.
is_placeholder_ts_name() {
  case "$1" in
    *example*) return 0 ;;
    *.tailnet.ts.net) return 0 ;;
    *"<"* | *">"* | *"*"* | *"%"*) return 0 ;;
    # The bare suffix, which is what the harvest yields when a name is assembled from a variable and
    # a literal (`\${host}.ts.net`). There is no host in it to leak.
    .ts.net) return 0 ;;
    *) return 1 ;;
  esac
}

# SECTOR NAMES collide with the `/home/<user>/` shape, and the collision is this product's own
# vocabulary: `home` is one of the six sectors, so prose like "contacts/home/health/finance do not
# clear AA" reads as an absolute path to rule 1. A guard that reddens on a sentence about lenses is a
# guard somebody deletes, so the six names are excluded where a username would go. `/Users/<name>/`
# has no such collision and is checked unconditionally.
SECTOR_WORDS="
mail
calendar
contacts
finance
health
home
"

# Path prefixes allowed to contain a bare UUID. Fixtures and tests need stable identifiers, and a
# random UUID in a test is not a leak — a UUID in a DOCUMENT is, because the only place a writer gets
# one is a real row. Keep this list short and path-anchored: widening it to `docs/` retires the rule.
UUID_ALLOWED_PREFIXES="
src/
apps/web/src/
db/
"

# ── Reporting ──────────────────────────────────────────────────────────────────────────────────────

violations=0
report() { # report <path:line> <reason> <offending text>
  printf '%s: %s — %s\n' "$1" "$2" "$3"
  violations=$((violations + 1))
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/scrub-shapes.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LIST="$WORK/files"

# Every file under the root, minus dependency and build directories and this script itself. The
# prune keeps the walk cheap on a tree somebody has already built in; `grep -I` below skips binaries.
# One path per line — this repository has no path containing a newline, and `git archive` could not
# produce one that git itself would have to quote.
find . \
  \( -name node_modules -o -name .git -o -name dist -o -name coverage \) -prune -o \
  -type f -print |
  sed 's|^\./||' |
  grep -v -x -F "$SELF" |
  sort >"$LIST"

file_count=$(wc -l <"$LIST" | tr -d ' ')
if [ "$file_count" -eq 0 ]; then
  printf 'scrub-shapes: found no files under %s — the walk is broken, not the tree\n' "$ROOT" >&2
  exit 2
fi

# One grep per rule over the whole list. `-H` is load-bearing: xargs batches, and a final batch of
# exactly one file makes grep drop the filename prefix, which would silently mis-attribute every hit
# in it. `-I` skips binaries. A rule that matches nothing exits 1 from grep, which is the normal case
# and must not kill the script — hence no `set -e`.
scan() { # scan <grep flags…> <pattern>
  tr '\n' '\0' <"$LIST" | xargs -0 grep -I -H -n "$@" -- 2>/dev/null
}

# Split a `path:line:text` hit. Uses the FIRST two colons only, so a match containing colons (a URL,
# always) survives intact.
hit_path() { printf '%s' "${1%%:*}"; }
hit_line() { local r="${1#*:}"; printf '%s' "${r%%:*}"; }
hit_text() { local r="${1#*:}"; printf '%s' "${r#*:}"; }

in_list() { # in_list <needle> <newline-separated list>
  local needle="$1" item
  while IFS= read -r item; do
    [ -n "$item" ] || continue
    [ "$needle" = "$item" ] && return 0
  done <<EOF
$2
EOF
  return 1
}

# ── Rule 1 — absolute home-directory paths ─────────────────────────────────────────────────────────
# `/Users/<name>/…` and `/home/<name>/…` name a person and a machine at once, and they are worse than
# private: nobody else can follow them. Documentation says "the repository root". The trailing slash
# in the pattern is deliberate — a real home path always has something under it, and requiring it
# drops the prose match on "Finance/home/etc." without weakening anything.
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  text="$(hit_text "$hit")"
  # The sector-name exemption applies to `/home/` ONLY, exactly as the comment beside SECTOR_WORDS
  # says: the collision is between this product's `home` sector and Linux's home directory. macOS's
  # `/Users/` shares no word with the sector vocabulary, so it is checked unconditionally — an
  # earlier cut applied the exemption to both and quietly contradicted its own documentation, which
  # would have let `/Users/mail/...` through.
  case "$text" in
    /home/*)
      # The segment where a username would sit.
      who="$(printf '%s' "$text" | sed -E 's#^/home/##; s#/.*##' | tr '[:upper:]' '[:lower:]')"
      in_list "$who" "$SECTOR_WORDS" && continue
      ;;
  esac
  report "$(hit_path "$hit"):$(hit_line "$hit")" \
    "an absolute home-directory path names one machine" "$text"
done < <(scan -E -o '(/Users/|/home/)[A-Za-z0-9._-]+/[A-Za-z0-9._/-]*')

# ── Rule 2 — tailnet FQDNs that are not placeholders ───────────────────────────────────────────────
# Checked case-folded, in prose as well as in commands: a tailnet name reaches the world through a
# sentence just as easily as through a `curl`.
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  path="$(hit_path "$hit")"
  is_test_file "$path" && continue
  name="$(hit_text "$hit")"
  folded="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  is_placeholder_ts_name "$folded" && continue
  report "$path:$(hit_line "$hit")" \
    "a *.ts.net name that is not a substitute-your-own placeholder" "$name"
done < <(scan -E -o -i '[A-Za-z0-9<>._~%*-]*\.ts\.net')

# ── Rule 3 — generated tailnet ids ─────────────────────────────────────────────────────────────────
# Tailscale names a tailnet `tail` + hex. There is exactly one real tailnet behind any such string,
# and it rides in through URLs, ACL snippets and pasted shell prompts alike.
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  path="$(hit_path "$hit")"
  is_test_file "$path" && continue
  report "$path:$(hit_line "$hit")" \
    "a generated tailnet id names one real tailnet" "$(hit_text "$hit")"
done < <(scan -E -o -i '\btail[0-9a-f]{6,}\b')

# ── Rule 4 — bare UUIDs outside fixtures ───────────────────────────────────────────────────────────
# A connection id, a credential id, an ingest path segment. The only place a documentation writer
# gets a real UUID is a real row, so a UUID in prose is a row identifier that escaped. Documentation
# writes `YOUR-CONNECTION-ID`; fixtures and tests are allowlisted above.
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  path="$(hit_path "$hit")"
  allowed=0
  while IFS= read -r prefix; do
    [ -n "$prefix" ] || continue
    case "$path" in "$prefix"*) allowed=1; break ;; esac
  done <<EOF
$UUID_ALLOWED_PREFIXES
EOF
  [ "$allowed" -eq 1 ] && continue
  report "$path:$(hit_line "$hit")" \
    "a bare UUID outside fixtures — documentation uses YOUR-CONNECTION-ID" "$(hit_text "$hit")"
done < <(scan -E -o -i '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b')

# ── Rule 5 — links into the private source repository ──────────────────────────────────────────────
# The repository this tree is filtered out of is private and its issue numbers are not these issue
# numbers. A link to it is dead for every reader and it names the account that owns it.
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  report "$(hit_path "$hit"):$(hit_line "$hit")" \
    "a reference to the private upstream repository" "$(hit_text "$hit")"
done < <(scan -E -o -i '(github\.com/[A-Za-z0-9_.-]+/)?Personal-context-gateway[A-Za-z0-9_./#-]*')

# ── Verdict ────────────────────────────────────────────────────────────────────────────────────────
printf -- '---\n'
printf 'scrub-shapes: scanned %s files under %s\n' "$file_count" "$ROOT"
if [ "$violations" -gt 0 ]; then
  printf 'scrub-shapes: FAILED — %d violation(s)\n' "$violations"
  exit 1
fi
printf 'scrub-shapes: clean\n'
exit 0
