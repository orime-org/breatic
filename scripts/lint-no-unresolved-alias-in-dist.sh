#!/usr/bin/env bash
# lint-no-unresolved-alias-in-dist — fail if any built `dist/` output
# still contains an UNRESOLVED internal path-alias import
# (@shared / @core / @domain / @collab / @worker / @server / @web).
#
# Why this guard exists (2026-05-29, regression from PR #163):
# the alias-only-import refactor switched every package's internal
# imports to globally-unique aliases (@shared/*, @core/*, ...). Those
# aliases resolve fine for typecheck (tsconfig `paths` → src) and for a
# SINGLE-entry tsup build (everything gets bundled+inlined into one
# file, so the alias disappears). But a MULTI-entry tsup build (shared
# has 3 subpath exports: ., ./yjs-doc-names, ./i18n) code-splits, and
# esbuild left the cross-chunk `@shared/*` specifiers UNRESOLVED in the
# emitted dist — it treats `@shared/...` as an external scoped package.
# The dist was therefore not self-contained: the web app loads
# `shared/dist/index.js` at runtime, hits `from "@shared/constants/..."`
# which its bundler can't resolve, and the whole page crashes with
# `[plugin:vite:import-analysis] Failed to resolve import`.
#
# `pnpm build` exits 0 even with this leak (esbuild silently externalizes
# the unknown specifier), so `turbo build` going green is NOT proof the
# dist is loadable. This guard closes that "build green ≠ runtime works"
# gap by asserting the invariant directly: a shipped dist must carry no
# internal aliases. Run it AFTER build.
#
# Fix for a leaking package: make its tsup build resolve its own alias,
# e.g. a `tsup.config.ts` with
#   esbuildOptions(o) { o.alias = { "@shared": resolve(__dirname, "src") } }
#
# Runs in CI (after the build step) and as
# `pnpm lint:no-unresolved-alias-in-dist` locally. Non-zero exit blocks
# merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Matches an import/export/dynamic-import whose specifier starts with one
# of the internal alias prefixes — i.e. an alias that escaped into dist:
#   from "@shared/x"     from '@core/x'
#   import("@collab/x")  import "@worker/x"
ALIAS_REGEX="(from|import)[[:space:]]*\(?[[:space:]]*['\"]@(shared|core|domain|collab|worker|server|web)/"

DIST_FILES=$(find packages/*/dist \
  -type f \
  \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.d.ts' \) \
  2>/dev/null || true)

if [[ -z "$DIST_FILES" ]]; then
  echo "lint:no-unresolved-alias-in-dist — no dist/ output found (run a build first); skipping"
  exit 0
fi

MATCHES=""
for file in $DIST_FILES; do
  hits=$(grep -nE "$ALIAS_REGEX" "$file" 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-unresolved-alias-in-dist — built dist/ contains UNRESOLVED internal aliases:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "A shipped dist must be self-contained: its internal aliases" >&2
  echo "(@shared/@core/@domain/@collab/@worker/@server/@web) must be resolved" >&2
  echo "at build time, not left as bare specifiers that downstream bundlers" >&2
  echo "(web vite, node) can't find." >&2
  echo "Fix the leaking package's tsup build to resolve its own alias" >&2
  echo "(esbuildOptions alias → src). See this script's header comment." >&2
  exit 1
fi

echo "lint:no-unresolved-alias-in-dist — clean (no internal aliases leaked into dist)"
