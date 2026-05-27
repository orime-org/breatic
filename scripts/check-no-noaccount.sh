#!/bin/sh
# PR-a + PR-b guard: ensure NoAccount mode + DEV_USER residue stays
# deleted from EVERY source path (backend + frontend + docs + env
# templates) and stays out forever.
#
# Forbidden tokens (case-sensitive):
#   - LOGIN_MODE          — env removed in PR-a (Auth section, env.ts)
#   - NoAccount           — dev-bypass mode removed in PR-a
#   - dev-fixed-token     — frontend bypass token (PR-b)
#   - DEV_USER_ID         — shared constant removed in PR-a
#   - VITE_LOGIN_MODE     — frontend env mirror (PR-b)
#   - inject-dev-user     — frontend bypass module path (PR-b)
#   - injectDevUser       — frontend bypass symbol (PR-b)
#
# Excludes build artifacts (dist/), vendored deps (node_modules/),
# generated migrations meta (which embed old snapshots), and this
# guard script itself.
#
# Exit 0 on clean; exit 1 on any hit (CI fail).

set -eu

SEARCH_PATHS="packages/shared/src packages/core/src packages/collab/src packages/server/src packages/web/src packages/worker/src docs scripts turbo.json"

EXISTING_PATHS=""
for p in $SEARCH_PATHS; do
  if [ -e "$p" ]; then
    EXISTING_PATHS="$EXISTING_PATHS $p"
  fi
done

if [ -z "$EXISTING_PATHS" ]; then
  echo "check-no-noaccount: no scan targets present, skipping."
  exit 0
fi

FOUND=$(grep -rnE 'LOGIN_MODE|NoAccount|dev-fixed-token|DEV_USER_ID|VITE_LOGIN_MODE|inject-dev-user|injectDevUser' $EXISTING_PATHS \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mts' --include='*.json' \
  --include='*.sh' --include='*.yml' --include='*.md' \
  2>/dev/null \
  | grep -v 'check-no-noaccount.sh' \
  | grep -v 'migrations/meta/' \
  || true)

if [ -n "$FOUND" ]; then
  echo "❌ NoAccount mode residue detected (PR-a + PR-b should have removed these):"
  echo "$FOUND" | sed 's/^/   /'
  echo ""
  echo "If you genuinely need to reference these tokens (e.g. in a"
  echo "historical changelog entry), update scripts/check-no-noaccount.sh"
  echo "with a narrow exclusion. Do NOT re-introduce dev-bypass auth."
  exit 1
fi

echo "✅ check-no-noaccount: clean — no NoAccount mode residue."
