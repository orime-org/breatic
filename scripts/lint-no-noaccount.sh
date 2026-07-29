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
#   NoAccount · WithAccount        BOTH of the switch's values. Naming the one
#                                  we kept still tells the reader a choice
#                                  exists — .env.docker described "prod forces
#                                  WithAccount login" for two months after the
#                                  switch was deleted, and a guard watching
#                                  only NoAccount could not see it.
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

TOKENS='LOGIN_MODE|NoAccount|WithAccount|dev-fixed-token|DEV_USER_ID|VITE_LOGIN_MODE|inject-dev-user|injectDevUser'
EXPECTED_TOKEN_COUNT=8

# Refuse to report clean from a pattern that has stopped matching. A guard
# that silently stops matching reports success forever — that is how CJK
# reached main through lint:no-cjk on 2026-07-14.
#
# Firing on one sample only proves SOME branch survived, which is too weak:
# drop six of the seven alternatives and a `LOGIN_MODE=NoAccount` sample still
# matches. Nor can that be fixed by testing one sample per token, because
# VITE_LOGIN_MODE contains LOGIN_MODE as a substring — a sample for the
# deleted branch gets matched by the surviving one. So check the pattern's
# shape (branch count, none empty) as well as that it fires.
assert_matcher_alive() {
  local count branch
  count=$(printf '%s' "$TOKENS" | awk -F'|' '{ print NF }')
  if [ "$count" -ne "$EXPECTED_TOKEN_COUNT" ]; then
    echo "❌ lint-no-noaccount: expected $EXPECTED_TOKEN_COUNT forbidden tokens, the pattern has $count." >&2
    echo "   Adding or removing one is fine — update EXPECTED_TOKEN_COUNT to match." >&2
    exit 2
  fi

  local IFS='|'
  for branch in $TOKENS; do
    if [ -z "$branch" ]; then
      echo "❌ lint-no-noaccount: the pattern contains an empty alternative, which matches everything." >&2
      exit 2
    fi
  done
  unset IFS

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
#
# `git grep` exits 1 for "no match" and >1 for "I could not run" — a malformed
# pathspec in the exclusion list below is 128, and so is running outside a git
# repository (an extracted source tarball). Collapsing those into "clean" with
# `|| true` is the failure this guard was rewritten to eliminate, so the two
# cases are separated: 0 and 1 are answers, anything else is a broken guard.
find_offenders() {
  local out status
  out=$(git grep -nIE "$TOKENS" -- \
    ':!scripts/lint-no-noaccount.sh' \
    ':!packages/core/src/db/migrations/0016_delete-dev-mock-user.sql' \
    2>&1) && status=0 || status=$?

  if [ "$status" -gt 1 ]; then
    echo "❌ lint-no-noaccount: the scan could not run (git grep exit $status)." >&2
    printf '%s\n' "$out" | sed 's/^/   /' >&2
    echo "   Refusing to report clean from a scan that never happened." >&2
    exit 2
  fi

  [ "$status" -eq 0 ] && printf '%s\n' "$out"
  return 0
}

# Reject anything that is not a recognised argument. Falling through on a
# typo would run a plain scan while the caller believes the self-test ran —
# a CI step spelled `--selftest` would look green with the end-to-end half
# never executed.
if [ "$#" -gt 0 ] && [ "${1:-}" != "--self-test" ]; then
  echo "lint-no-noaccount: unknown argument '$1' (expected --self-test or none)." >&2
  exit 2
fi

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

  # A signal handler is just a function: it returns, and the script carries on.
  # Clearing the traps inside cleanup (to stop INT and EXIT firing it twice)
  # therefore has to be paired with actually terminating, or the run continues
  # with no handler left — planting the probe afterwards with nothing to
  # remove it, then exiting 0 and printing "passed". Signals get their own
  # handler that exits; EXIT keeps the plain one.
  on_signal() {
    cleanup_probe
    exit 130
  }
  trap cleanup_probe EXIT
  trap on_signal INT TERM

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
  # Report a failure to stage as a broken guard (2), not as git's raw exit
  # code. An index.lock left by another process makes this fail, and without
  # the check `set -e` kills the run with an undiagnosable 128.
  if ! git add -N "$probe" >/dev/null 2>&1; then
    echo "SELF-TEST ABORTED: could not stage the probe, so the scan cannot see it." >&2
    echo "   Another git process may hold .git/index.lock." >&2
    exit 2
  fi
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
