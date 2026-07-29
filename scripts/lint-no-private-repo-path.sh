#!/usr/bin/env bash
# lint-no-private-repo-path — the public repo must not name paths inside the
# private engineering/design repo.
#
# Rationale (2026-07-28, #1840): this repository is public. A comment citing
# `engineering/specs/<date>-<topic>.md` tells every outside reader that a private
# repo exists, what it is called, how its directories are organised, and what a
# given internal document is named — none of which belongs in a public artifact.
# It is also a dead reference for anyone outside the team: they can read the
# path but never the document.
#
# This is not a new rule. The project docs already require it, and PR #364 was
# opened specifically to strip such references. It came back within days, on
# #1839, because a rule with no guard is a suggestion. This is the guard half.
#
# WHAT COUNTS AS A VIOLATION
#   Any occurrence, in source or public docs or scripts, of:
#     - the private repo name
#     - a path under engineering/{specs,decisions,audit,plans}/
#     - a path under design/decisions/
#
# HOW TO REFER TO INTERNAL MATERIAL INSTEAD
#   Describe it generically: "the private engineering record", "an internal
#   design ADR". State the decision itself in the public comment when the reader
#   needs it — a pointer they cannot follow is worse than a self-contained
#   sentence.
#
# Runs in CI (.github/workflows/ci.yml) and as `pnpm lint:no-private-repo-path`.
# A non-zero exit blocks merge. Pass --self-test to verify the checker itself.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Split so this file does not match its own pattern when it scans itself.
PRIVATE_REPO="breatic""-inner"
PATTERN="${PRIVATE_REPO}|engineering/(specs|decisions|audit|plans)/|design/decisions/"

SCAN_PATHS=('packages' 'docs' 'scripts' 'config' '.github')

# Print every offending line, excluding this script (which must contain the
# pattern in order to search for it).
find_offenders() {
  git grep -nEI "$PATTERN" -- "${SCAN_PATHS[@]}" 2>/dev/null \
    | grep -v '^scripts/lint-no-private-repo-path\.sh:' || true
}

if [[ "${1:-}" == "--self-test" ]]; then
  probe="scripts/__private_path_probe__.sh"

  # The probe must enter the index to be visible to git grep, so its removal
  # cannot depend on reaching the end of the function: an interrupted run
  # would leave a file that the next scan reports as a real violation.
  cleanup_probe() {
    git rm -q --cached "$probe" >/dev/null 2>&1 || true
    rm -f "$probe"
  }
  trap cleanup_probe EXIT INT TERM

  echo "self-test 1/2: clean tree must PASS"
  if [ -n "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: the tree already has offenders:"
    find_offenders | sed 's/^/  /'
    exit 1
  fi
  echo "  ok"

  echo "self-test 2/2: an injected private path must FAIL"
  {
    printf '#!/usr/bin/env bash\n'
    printf '# see %s/2026-01-01-something.md\n' "engineering/specs"
  } > "$probe"
  git add -N "$probe" >/dev/null 2>&1
  if [ -z "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: an injected private path did not trip the checker."
    exit 1
  fi
  echo "  ok"

  echo "self-test passed"
  exit 0
fi

offenders="$(find_offenders)"
if [ -z "$offenders" ]; then
  echo "OK: no private-repo paths in public files."
  exit 0
fi

echo "FAIL: public files reference private-repo paths:"
printf '%s\n' "$offenders" | sed 's/^/  /'
cat <<'MSG'

This repo is public. Replace the path with a generic reference ("the private
engineering record", "an internal design ADR"), or better, state the decision
itself here — an outside reader cannot follow the pointer either way.
MSG
exit 1
