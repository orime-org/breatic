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
# EXCLUSIONS — there are exactly two, both unavoidable
#   this script                   it must hold the tokens to search for them
#   0016_delete-dev-mock-user.sql the migration that deleted this mode's mock
#                                 user; migrations are immutable history
#
#   Excluded by FILE, never by directory: excluding all of migrations/ would
#   also blind the guard to every migration written from now on.
#
#   Everywhere else that needs to DISCUSS the ban is reworded instead of
#   exempted, because an exemption is permanent and unconditional. CLAUDE.md
#   and the CI job both describe this rule without naming the tokens, so both
#   stay in scope — which matters most for ci.yml, where a workflow `env:`
#   block injects real environment variables and could re-introduce the mode
#   for real rather than merely mention it.
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

# The forbidden tokens have exactly one definition; the regex is derived from
# it. Keeping a hand-written pattern alongside a list would let the two drift,
# and a drifted pattern is invisible: a guard whose alternative reads NoAcount
# still has the right number of branches and still matches its own sample.
FORBIDDEN_TOKENS=(
  LOGIN_MODE
  VITE_LOGIN_MODE
  NoAccount
  WithAccount
  DEV_USER_ID
  dev-fixed-token
  inject-dev-user
  injectDevUser
)
TOKENS="$(IFS='|'; printf '%s' "${FORBIDDEN_TOKENS[*]}")"

# Check that the pattern derived from FORBIDDEN_TOKENS behaves the way the
# list says it should. A guard that has silently stopped matching reports
# success forever — that is how CJK reached main through lint:no-cjk on
# 2026-07-14.
#
# WHAT THIS CANNOT DO, so nobody trusts it further than it goes: it cannot
# tell whether the LIST ITSELF is right. Edit an entry to NoAcount and the
# pattern, the samples here and the self-test probe all shift together — every
# check stays self-consistent while the guard has gone blind to NoAccount.
# There is no second source of truth to compare against, and inventing one
# (a hardcoded copy, a checksum) just moves the same question one file over.
# Changing this list is a code review's job; these assertions cover the
# mechanical failures instead — an empty list, an empty entry, a token whose
# derived branch does not match it, a pattern that matches everything.
assert_matcher_alive() {
  local token

  if [ "${#FORBIDDEN_TOKENS[@]}" -eq 0 ]; then
    echo "❌ lint-no-noaccount: the token list is empty; the guard would match nothing." >&2
    exit 2
  fi

  # Each token must be matched BY ITS OWN branch, which `grep -q` cannot tell
  # you: VITE_LOGIN_MODE contains LOGIN_MODE, so a broken VITE_LOGIN_MODE
  # branch still yields a match from the surviving one and the check passes
  # while the guard is half blind. `grep -o` reports what actually matched —
  # scanning left to right, an intact branch matches at offset 0 and returns
  # the whole token, a broken one returns the shorter substring.
  local matched
  for token in "${FORBIDDEN_TOKENS[@]}"; do
    if [ -z "$token" ]; then
      echo "❌ lint-no-noaccount: the token list contains an empty entry, which would match everything." >&2
      exit 2
    fi
    matched="$(printf '%s\n' "$token" | grep -oE "$TOKENS" | head -1 || true)"
    if [ "$matched" != "$token" ]; then
      echo "❌ lint-no-noaccount: the pattern does not match '$token' as a whole." >&2
      if [ -n "$matched" ]; then
        echo "   It matched '$matched' instead, so that token's own branch is broken." >&2
      else
        echo "   It did not match at all, so that token's branch is missing." >&2
      fi
      exit 2
    fi
  done

  if printf '%s\n' 'a line naming none of the tokens' | grep -qE "$TOKENS"; then
    echo "❌ lint-no-noaccount: the pattern matches a line containing no token at all." >&2
    echo "   Every result it produces would be noise." >&2
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
  local out err status errfile
  errfile="$(mktemp)" || { echo "lint-no-noaccount: mktemp failed." >&2; exit 2; }

  # stderr goes to its own file, never merged into the results. Merging them
  # printed git's diagnostics as if they were offending source lines, telling
  # the reader to "delete" a line that exists in no file.
  out=$(git grep -nIE "$TOKENS" -- \
    ':!scripts/lint-no-noaccount.sh' \
    ':!packages/core/src/db/migrations/0016_delete-dev-mock-user.sql' \
    2>"$errfile") && status=0 || status=$?
  err="$(cat "$errfile")"
  rm -f "$errfile"

  if [ "$status" -gt 1 ]; then
    echo "❌ lint-no-noaccount: the scan could not run (git grep exit $status)." >&2
    printf '%s\n' "$err" | sed 's/^/   /' >&2
    echo "   Refusing to report clean from a scan that never happened." >&2
    exit 2
  fi

  # git grep exits 1 for "no match" even when it SKIPPED files it could not
  # read — an unreadable tracked file, or a malformed .gitattributes, makes it
  # write to stderr and still exit 1. Residue in a skipped file would then be
  # reported as a clean tree, so any diagnostic at all is treated as a broken
  # scan rather than a quiet success.
  if [ -n "$err" ]; then
    echo "❌ lint-no-noaccount: the scan reported problems while reading the tree." >&2
    printf '%s\n' "$err" | sed 's/^/   /' >&2
    echo "   Files it could not read may hold residue, so this is not a clean result." >&2
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
    # Clear the traps AFTER the work, not before: a signal arriving inside
    # this window would otherwise kill a half-done cleanup. Both actions are
    # idempotent, so a second firing is harmless.
    git rm -q --cached "$probe" >/dev/null 2>&1 || true
    rm -f "$probe"
    trap - EXIT INT TERM
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
  # One planted line per token, so the end-to-end path is exercised for every
  # one of them rather than for whichever happens to appear in a single sample.
  {
    echo '#!/bin/sh'
    for token in "${FORBIDDEN_TOKENS[@]}"; do
      printf '# %s\n' "$token"
    done
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
