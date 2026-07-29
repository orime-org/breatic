#!/bin/sh
# Guard: the NoAccount dev-bypass auth mode must stay deleted.
#
# NoAccount let a developer skip authentication entirely. It was removed in
# #147, and every environment now requires a real login — there is no mode
# switch left to flip. A file that still names the switch is not a harmless
# leftover: it tells whoever reads it that auth is optional here.
#
# FORBIDDEN TOKENS (case-sensitive)
#   LOGIN_MODE · VITE_LOGIN_MODE   the mode switch itself, backend + frontend
#   NoAccount                      the mode's name
#   DEV_USER_ID · dev-fixed-token  the fixed identity it handed out
#   inject-dev-user · injectDevUser  the frontend module that injected it
#
# WHY THIS SCANS EVERYTHING RATHER THAN A PATH LIST
#   It used to scan a whitelist: `packages/*/src docs scripts turbo.json`.
#   Every location outside that list was invisible, and on 2026-07-29 four
#   of them turned out to be holding residue — two months after the removal,
#   with CI green the whole time:
#
#     README.md         a config table advertising `LOGIN_MODE` and its
#                       `NoAccount` value, in the PUBLIC entry document
#     Dockerfile.web    ARG + ENV for VITE_LOGIN_MODE, which no web source
#                       file reads — a build-time variable set for nobody
#     .env.dev          `LOGIN_MODE=WithAccount` under a `[REQUIRED]`
#     .env.docker       heading, with a comment explaining NoAccount
#     packages/web/scripts/   a spike whose header assumed the mode existed
#
#   A whitelist has to predict where a token can appear; it was wrong four
#   times, and finishing the list would not stop a fifth (.env.staging, a
#   new compose file, CONTRIBUTING.md). These tokens are specific enough
#   that a full scan cannot plausibly hit an innocent line, so the safe
#   default is to read every tracked file and name the exceptions instead.
#
# EXCLUSIONS — each one is a place that DESCRIBES the ban
#   this script                   it must contain the tokens to search for them
#   .github/workflows/ci.yml      the job comment lists what is forbidden
#   CLAUDE.md                     records that the mode was removed in #147
#   db/migrations/                0016 deletes the mock user this mode created;
#                                 migrations are immutable history
#
#   Adding a file here means "this file talks ABOUT the ban". If you are
#   tempted to add one because it USES the tokens, that is the residue this
#   guard exists to catch — delete it instead.
#
# Runs in CI (.github/workflows/ci.yml) and as `pnpm lint:no-noaccount`.
# A non-zero exit blocks merge. Pass --self-test to verify the checker
# itself: a clean tree must pass, and planted residue must fail.
#
# WHY THE SELF-TEST IS A SEPARATE INVOCATION
#   lint-dev-proxy-target.sh runs its self-test inline on every scan, which
#   is free there because its matcher works on strings in memory. This one
#   cannot: proving the matcher fires requires a file the scan can actually
#   see, and the scan reads tracked content, so the probe has to enter the
#   git index. Doing that on every scan would touch the index of anyone
#   running the guard locally, and would strand a probe file if the run were
#   interrupted. So the self-test stays behind the flag, and both entry
#   points call it explicitly — the pnpm alias with `&&`, the CI job as a
#   second step. Keep the two in step.

set -eu

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

TOKENS='LOGIN_MODE|NoAccount|dev-fixed-token|DEV_USER_ID|VITE_LOGIN_MODE|inject-dev-user|injectDevUser'

# Print every offending line, or nothing when the tree is clean.
# `git grep` reads tracked files only, so build output and node_modules are
# out of scope by construction; -I skips binaries.
find_residue() {
  git grep -nIE "$TOKENS" -- \
    ':!scripts/check-no-noaccount.sh' \
    ':!.github/workflows/ci.yml' \
    ':!CLAUDE.md' \
    ':!packages/core/src/db/migrations/' \
    2>/dev/null || true
}

# --self-test: a checker that can only ever pass is indistinguishable from a
# checker that is broken. This one silences grep's stderr and swallows its
# exit code, so "found nothing" and "the matcher died" look identical from
# the outside — exactly the failure that let CJK reach main through
# lint:no-cjk on 2026-07-14. Prove both directions still work.
if [ "${1:-}" = "--self-test" ]; then
  PROBE="scripts/__noaccount_probe__.sh"

  # The probe has to enter the index to be visible to git grep, so removing
  # it cannot be left to the happy path — an interrupted run would strand a
  # file containing a forbidden token, and the next scan would report it as
  # real residue.
  cleanup_probe() {
    git rm -q --cached "$PROBE" >/dev/null 2>&1 || true
    rm -f "$PROBE"
  }
  trap cleanup_probe EXIT INT TERM

  echo "self-test 1/2: clean tree must PASS"
  if [ -n "$(find_residue)" ]; then
    echo "SELF-TEST FAILED: the tree already has residue:"
    find_residue | sed 's/^/  /'
    exit 1
  fi
  echo "  ok"

  echo "self-test 2/2: planted residue must FAIL"
  {
    echo '#!/bin/sh'
    # Written in halves so this script does not carry a literal token.
    echo "# LOGIN""_MODE=NoAcc""ount"
  } > "$PROBE"
  git add -N "$PROBE" >/dev/null 2>&1
  if [ -z "$(find_residue)" ]; then
    echo "SELF-TEST FAILED: planted residue did not trip the checker."
    exit 1
  fi
  echo "  ok"

  echo "self-test passed"
  exit 0
fi

FOUND=$(find_residue)

if [ -n "$FOUND" ]; then
  echo "❌ NoAccount mode residue detected:"
  echo "$FOUND" | sed 's/^/   /'
  echo ""
  echo "Every environment requires a real login — there is no mode switch to"
  echo "configure. Delete the line rather than documenting a dead option."
  echo ""
  echo "If the file genuinely DESCRIBES the ban (a changelog entry, this"
  echo "guard's own CI comment), add it to the exclusion list in"
  echo "scripts/check-no-noaccount.sh with a one-line reason."
  exit 1
fi

echo "✅ check-no-noaccount: clean — no NoAccount mode residue."
