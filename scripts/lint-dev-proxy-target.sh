#!/usr/bin/env bash
# Guard: the vite dev proxy must target localhost, never a deployed host.
#
# Pointing /api, /uploads or /ws at thinkai.cc / breatic.ai routes every
# developer's `pnpm dev` traffic to shared infrastructure and makes local code
# changes untestable — the BUG-2 regression this guard exists to prevent.
#
# Two things the previous incarnations got wrong, both fixed 2026-07-27 (#1831):
#
#   1. CI grepped `packages/web/vite.config.ts` while the file is `.mts`. The
#      path did not exist, `|| true` swallowed grep's failure, and the job went
#      green without reading a byte. Note it DID work when added (2026-04-23);
#      it went silently blind on 2026-05-20 when the Tailwind v4 migration
#      renamed the file to `.mts` — nobody checked who referenced it BY NAME.
#      `.husky/pre-commit` filtered staged paths by the same wrong name.
#   2. Fixing only the extension is not enough: a bare whole-file search for the
#      hostnames matches the COMMENT that explains this very rule, so the guard
#      flips from never-firing to always-firing.
#
# Hence: match a hostname only inside a STRING LITERAL (single, double or
# backtick quoted). A real violation is always a string — `target: 'https://
# thinkai.cc'` or a template literal — while prose mentioning the hosts is not.
#
# It also scans BOTH files that can decide a proxy target. The targets moved out
# of vite.config.mts into proxy-targets.mts, so a guard that reads only the
# former now watches a file which structurally cannot contain a hostname.
#
# Usage:
#   scripts/lint-dev-proxy-target.sh              scan the repo
#   scripts/lint-dev-proxy-target.sh --self-test  verify the matcher still works
set -euo pipefail

cd "$(dirname "$0")/.."

FILES=(
  "packages/web/vite.config.mts"
  "packages/web/proxy-targets.mts"
  "packages/web/dev-ports.mts"
)

# Hostname inside a quoted string. The leading quote class is what keeps prose
# out; see the header for why that distinction is load-bearing.
MATCHER='["'"'"'`][^"'"'"'`]*(thinkai\.cc|breatic\.ai)'

# A guard whose matcher silently stopped matching reports "clean" forever, so
# prove it still fires on a known-positive sample before trusting a clean run.
self_test() {
  local tmp positive negative
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  positive="$tmp/positive.mts"
  negative="$tmp/negative.mts"
  printf "%s\n" "  const apiTarget = 'https://www.thinkai.cc';" > "$positive"
  printf "%s\n" "  // Pointing these at thinkai.cc / breatic.ai routes traffic to shared infra" > "$negative"
  printf "%s\n" "  const apiTarget = \`http://localhost:\${port}\`;" >> "$negative"

  if ! grep -qE "$MATCHER" "$positive"; then
    echo "❌ dev-proxy-target SELF-TEST: matcher no longer detects a real violation." >&2
    echo "   The guard would report 'clean' regardless of the code. Fix the matcher." >&2
    return 1
  fi
  if grep -qE "$MATCHER" "$negative"; then
    echo "❌ dev-proxy-target SELF-TEST: matcher fires on prose / a localhost target." >&2
    echo "   The guard would fail every PR. Fix the matcher." >&2
    return 1
  fi
  echo "dev-proxy-target: self-test passed ✅ (matcher catches strings, ignores prose)"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

# Run the self-test inline too: a scan that can no longer detect anything is
# worse than no scan, because it looks like a passing check.
self_test

missing=""
offenders=""
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    missing="$missing  $f"$'\n'
    continue
  fi
  hits="$(grep -nE "$MATCHER" "$f" || true)"
  [ -n "$hits" ] && offenders="$offenders$(echo "$hits" | sed "s#^#$f:#")"$'\n'
done

if [ -n "$missing" ]; then
  echo "❌ dev-proxy-target: these files are configured to be scanned but do not exist:" >&2
  printf "%s" "$missing" >&2
  echo "   If a config was renamed or moved, update FILES in this script — otherwise" >&2
  echo "   the guard silently watches nothing (exactly how it stayed green for months)." >&2
  exit 1
fi

if [ -n "$offenders" ]; then
  echo "❌ dev-proxy-target: dev proxy must point at localhost, not a deployed host." >&2
  printf "%s" "$offenders" >&2
  echo >&2
  echo "   Targets are derived from PORT / COLLAB_PORT in .env:" >&2
  echo "     /api/     -> http://localhost:\${PORT}" >&2
  echo "     /uploads/ -> http://localhost:\${PORT}" >&2
  echo "     /ws       -> ws://localhost:\${COLLAB_PORT}" >&2
  exit 1
fi

echo "dev-proxy-target: clean ✅ (${#FILES[@]} config files target localhost only)"
exit 0
