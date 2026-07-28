#!/usr/bin/env bash
# lint-eof-newline — every tracked text file must end with a newline.
#
# Rationale (2026-07-28, #1840): a file without a trailing newline makes the
# NEXT person's edit show up as a two-line diff — the last existing line appears
# modified even though only the new line was added. Reviewers then read a change
# that never happened. This surfaced concretely on #1839: a one-line addition to
# `_journal.json` produced a diff hunk touching a line the author never edited,
# and the adversarial review filed it as an unexplained change.
#
# It is also the cheapest possible check: the question "is the last byte a
# newline" has exactly one answer, so this guard cannot produce a false positive.
#
# SCOPE
#   All git-tracked files with a text extension (see EXTENSIONS below), with no
#   exemptions. The migrations directory is INCLUDED even though drizzle-kit
#   originally emitted those files without trailing newlines: this repo has
#   hand-written every migration since 0018 (see the DB section of the project
#   docs), so no tool re-generates them and there is nothing to fight with.
#   Binary files, lockfiles and node_modules are outside `git ls-files` here by
#   virtue of the extension list.
#
# Runs in CI (.github/workflows/ci.yml) and as `pnpm lint:eof-newline`.
# A non-zero exit blocks merge. Pass --self-test to verify the checker itself.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

EXTENSIONS=('*.ts' '*.tsx' '*.sql' '*.json' '*.md' '*.sh' '*.yml' '*.yaml' '*.mjs' '*.mts' '*.cjs' '*.css')

# Print every tracked text file whose last byte is not a newline.
find_offenders() {
  git ls-files -- "${EXTENSIONS[@]}" | while IFS= read -r f; do
    [ -s "$f" ] || continue                       # empty file: nothing to end
    if [ "$(tail -c1 "$f" | wc -l)" -eq 0 ]; then
      printf '%s\n' "$f"
    fi
  done
}

if [[ "${1:-}" == "--self-test" ]]; then
  echo "self-test 1/2: clean tree must PASS"
  if [ -n "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: the tree already has offenders. Fix them first:"
    find_offenders | sed 's/^/  /'
    exit 1
  fi
  echo "  ok"

  echo "self-test 2/2: a file without a trailing newline must FAIL"
  probe="scripts/__eof_probe__.json"
  printf '{"probe":true}' > "$probe"   # deliberately no trailing newline
  git add -N "$probe" >/dev/null 2>&1  # make it visible to git ls-files
  if [ -z "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: a file with no trailing newline did not trip the checker."
    git rm -q --cached "$probe" >/dev/null 2>&1
    rm -f "$probe"
    exit 1
  fi
  echo "  ok"
  git rm -q --cached "$probe" >/dev/null 2>&1
  rm -f "$probe"
  echo "self-test passed"
  exit 0
fi

offenders="$(find_offenders)"
if [ -z "$offenders" ]; then
  echo "OK: every tracked text file ends with a newline."
  exit 0
fi

count=$(printf '%s\n' "$offenders" | wc -l | tr -d ' ')
echo "FAIL: ${count} file(s) do not end with a newline:"
printf '%s\n' "$offenders" | sed 's/^/  /'
cat <<'MSG'

Fix them with:
  printf '\n' >> <file>

Without it, the next edit to any of these files shows the final existing line
as modified, and reviewers read a change that was never made.
MSG
exit 1
