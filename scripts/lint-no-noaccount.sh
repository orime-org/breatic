#!/usr/bin/env bash
# Guard: the NoAccount dev-bypass auth mode must stay deleted.
#
# NoAccount let a developer skip authentication entirely. It was removed in
# #147, and every environment now requires a real login — there is no mode
# switch left to flip. A file that still names the switch is not a harmless
# leftover: it tells whoever reads it that auth is optional here.
#
# FORBIDDEN TOKENS (case-sensitive)
#   LOGIN_MODE · VITE_LOGIN_MODE   the mode switch, backend and frontend
#   NoAccount                      the mode's name
#   DEV_USER_ID · dev-fixed-token  the fixed identity it handed out
#   inject-dev-user                the frontend bypass module path
#   injectDevUser                  the frontend bypass symbol
#
# WHY IT READS EVERY TRACKED FILE
#   The previous version filtered twice, and each filter had its own blind
#   spot. It listed paths (six `packages/*/src` directories — domain was
#   never added — plus docs, scripts and turbo.json), AND it listed
#   extensions (.ts .tsx .js .mts .json .sh .yml .md). On 2026-07-29 five
#   residues turned up that had survived two months of green CI, and the two
#   filters split them: README.md and a spike under packages/web/scripts/
#   were inside a scanned extension but outside every scanned path, while
#   Dockerfile.web (no extension at all) and both .env templates (.dev,
#   .docker) could not have been seen at any path.
#
#   Completing either list would have left the other half blind, and neither
#   list can predict the next location — .env.staging, a new compose file,
#   CONTRIBUTING.md. These tokens are specific enough that reading every
#   tracked file cannot plausibly hit an innocent line, so the guard scans
#   everything and names the exceptions instead.
#
# EXCLUSIONS — each is a place that DESCRIBES the ban rather than uses it
#   this script                   it must hold the tokens to search for them
#   CLAUDE.md                     records that the mode was removed in #147
#   0016_delete-dev-mock-user.sql the migration that deleted this mode's mock
#                                 user; migrations are immutable history
#
#   Excluded by FILE, never by directory: excluding all of migrations/ would
#   also blind the guard to every migration written from now on. Note what is
#   NOT excluded — .github/workflows/ci.yml is scanned, because a workflow
#   `env:` block injects real environment variables and is therefore a place
#   the mode could genuinely be re-introduced, not merely described. The CI
#   job is worded to avoid the literal tokens for that reason.
#
#   Adding a file here means "this file talks ABOUT the ban". If you are
#   tempted to add one because it USES the tokens, that is the residue this
#   guard exists to catch — delete it instead.
#
# TWO LEVELS OF SELF-CHECK, AND WHY THEY DIFFER
#   Every scan asserts the PATTERN still fires on a known violation. That is
#   a string through grep: no files, no index, no cost, so it runs inline and
#   a dead pattern can never report clean.
#
#   Proving the END-TO-END SCAN still finds a real file needs a file the
#   scanner can see, and this scanner is `git grep`, which reads tracked
#   content — so the probe has to enter the git index. (lint-dev-proxy-
#   target.sh runs its end-to-end test inline because its matcher greps an
#   arbitrary path, so a temp dir suffices; git grep cannot look there.)
#   Touching the index on every scan would disturb anyone running the guard
#   locally, so that half stays behind --self-test, which both entry points
#   call: the `pnpm lint:no-noaccount` alias with `&&`, and the CI job as a
#   second step. Keep the two in step.
#
# Runs in CI (.github/workflows/ci.yml) and as `pnpm lint:no-noaccount`.
# Exit 0 clean · 1 residue found · 2 the guard itself is broken.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TOKENS='LOGIN_MODE|NoAccount|dev-fixed-token|DEV_USER_ID|VITE_LOGIN_MODE|inject-dev-user|injectDevUser'

# Refuse to report clean from a pattern that has stopped matching. A guard
# that silently stops matching reports success forever — that is how CJK
# reached main through lint:no-cjk on 2026-07-14.
assert_matcher_alive() {
  if ! printf '%s\n' 'LOGIN_MODE=NoAccount' | grep -qE "$TOKENS"; then
    echo "❌ lint-no-noaccount: the matcher no longer fires on a known violation." >&2
    echo "   Refusing to report clean from a dead pattern." >&2
    exit 2
  fi
}

# Print every offending line, or nothing when the tree is clean. `git grep`
# reads tracked content, so build output and node_modules are out of scope by
# construction; -I skips binaries.
#
# The flip side: a brand-new file is invisible until it is `git add`ed. That
# is exactly right for CI, where everything under review is committed, but it
# means a local run cannot vouch for a file you have not staged yet.
find_offenders() {
  git grep -nIE "$TOKENS" -- \
    ':!scripts/lint-no-noaccount.sh' \
    ':!CLAUDE.md' \
    ':!packages/core/src/db/migrations/0016_delete-dev-mock-user.sql' \
    2>/dev/null || true
}

if [[ "${1:-}" == "--self-test" ]]; then
  probe="scripts/__noaccount_probe__.sh"

  # Refuse to run if that path is occupied: the probe is written with `>` and
  # deleted afterwards, which would destroy a real file of the same name.
  if [ -e "$probe" ]; then
    echo "SELF-TEST ABORTED: $probe already exists; refusing to overwrite it." >&2
    exit 2
  fi

  # The probe must enter the index to be visible to git grep, so its removal
  # cannot be left to the happy path — an interrupted run would strand a file
  # holding a forbidden token, and the next scan would report it as residue.
  cleanup_probe() {
    trap - EXIT INT TERM
    git rm -q --cached "$probe" >/dev/null 2>&1 || true
    rm -f "$probe"
  }
  trap cleanup_probe EXIT INT TERM

  echo "self-test 1/3: the matcher must fire on a known violation"
  assert_matcher_alive
  echo "  ok"

  echo "self-test 2/3: clean tree must PASS"
  if [ -n "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: the tree already has residue:"
    find_offenders | sed 's/^/  /'
    exit 1
  fi
  echo "  ok"

  echo "self-test 3/3: planted residue must FAIL"
  {
    echo '#!/bin/sh'
    # Written in halves so the probe's own token needs no exclusion of its own.
    echo "# LOGIN""_MODE=NoAcc""ount"
  } > "$probe"
  git add -N "$probe" >/dev/null 2>&1
  if [ -z "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: planted residue did not trip the checker."
    exit 1
  fi
  echo "  ok"

  echo "self-test passed"
  exit 0
fi

assert_matcher_alive

offenders="$(find_offenders)"

if [ -n "$offenders" ]; then
  echo "❌ Auth-bypass residue detected:"
  echo "$offenders" | sed 's/^/   /'
  echo ""
  echo "Every environment requires a real login — there is no mode switch to"
  echo "configure. Delete the line rather than documenting a dead option."
  echo ""
  echo "If the file genuinely DESCRIBES the ban (a changelog entry, a"
  echo "migration that removed it), add it to the exclusion list in"
  echo "scripts/lint-no-noaccount.sh with a one-line reason."
  exit 1
fi

echo "✅ lint-no-noaccount: clean — no auth-bypass residue."
