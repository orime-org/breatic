#!/bin/sh
# PR-a guard: ensure NoAccount mode + DEV_USER residue stays deleted.
#
# Scope: scan source / docs / env templates for forbidden tokens that
# would resurrect dev-bypass auth. Excludes build artifacts (dist/),
# vendored deps (node_modules/), generated migrations meta (which embed
# old snapshots), and this guard script itself.
#
# Forbidden tokens (case-sensitive):
#   - LOGIN_MODE        — env removed in PR-a (Auth section, env.ts)
#   - NoAccount         — dev-bypass mode removed in PR-a
#   - dev-fixed-token   — frontend bypass token (PR-b will clean
#                         packages/web/src/app/dev/inject-dev-user.ts)
#   - DEV_USER_ID       — shared constant removed in PR-a
#
# Exit 0 on clean; exit 1 on any hit (CI fail).

set -eu

# PR-a scope: scan **backend** source + turbo.json only. PR-b will
# extend this to packages/web/ + docs/ + .env.* templates once the
# frontend bypass code (inject-dev-user.ts / App.tsx / vite-env.d.ts
# / vite.config.mts / docs/frontend.md / .env templates) is cleaned.
SEARCH_PATHS="packages/shared/src packages/core/src packages/collab/src packages/server/src scripts turbo.json"

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

FOUND=$(grep -rnE 'LOGIN_MODE|NoAccount|dev-fixed-token|DEV_USER_ID' $EXISTING_PATHS \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' \
  --include='*.sh' --include='*.yml' \
  2>/dev/null \
  | grep -v 'check-no-noaccount.sh' \
  | grep -v 'migrations/meta/' \
  || true)

if [ -n "$FOUND" ]; then
  echo "❌ NoAccount mode residue detected (PR-a should have removed these):"
  echo "$FOUND" | sed 's/^/   /'
  echo ""
  echo "If you genuinely need to reference these tokens (e.g. in a"
  echo "historical changelog entry), update scripts/check-no-noaccount.sh"
  echo "with a narrow exclusion. Do NOT re-introduce dev-bypass auth."
  exit 1
fi

echo "✅ check-no-noaccount: clean — no NoAccount mode residue."
