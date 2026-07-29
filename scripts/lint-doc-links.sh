#!/usr/bin/env bash
# lint-doc-links — fail the build when a TSDoc `{@link X}` points at a symbol
# that no longer exists.
#
# Rationale (2026-07-28, #1840): prose is the only thing we produce that has no
# verifier. Code is checked by tsc, tests and runtime; a comment that lies is
# checked by nobody, so it survives indefinitely and misleads whoever reads it
# next. One review of a single PR turned up 27 prose defects and zero
# correctness defects, and one of them was a comment pointing at
# `insertInitialState`, a function that had been moved out of the repo months
# earlier — the sentence stayed behind, describing something that did not exist.
#
# This guard closes exactly that hole and nothing wider. It asks a question with
# a definite answer ("does this symbol still resolve?") rather than a question
# of meaning ("is this sentence true?"). Approaches that judge meaning were
# measured at 32-48% false positives during the design of #1840 and were
# abandoned; symbol resolution has no false positives by construction, because
# the resolver either finds the target or does not.
#
# WHAT IT CHECKS
#   For each library package: run TypeDoc over the package's public entry point
#   and fail if any `{@link}` cannot be resolved. `notExported` and
#   `notDocumented` validation stay OFF — those flag documentation-coverage
#   gaps, not false statements, and enabling them produced 174 findings that
#   were all configuration noise.
#
# TWO SCAN MODES, AND WHY
#   The six library packages are scanned from their `src/index.ts` and followed
#   inward (`resolve`), so a reference from one file to another inside the same
#   package resolves fine.
#
#   `packages/web` cannot be scanned that way. It is an application: its entry
#   point renders a React tree and exports nothing, so following exports inward
#   reaches almost no files — verified by planting a dangling link deep in
#   CanvasSpace.tsx and watching the entry-point scan miss it entirely. web is
#   therefore scanned file-by-file (`expand`), which reaches every file but
#   treats each one as its own root, so a reference to a symbol in a SIBLING
#   file cannot resolve either. Those were rewritten as backticks, and the rule
#   for web is: `{@link}` for same-file symbols, backticks for everything else.
#
# WHAT IT DOES NOT CHECK
#   - CROSS-PACKAGE references. Each package is resolved against its own
#     tsconfig, so `{@link TaskEntity}` written in @domain about a type owned by
#     @shared cannot resolve and must be written as `TaskEntity` in backticks
#     instead. Running all packages in one TypeDoc pass would fix this, but it
#     requires a tsconfig that carries every package's path aliases; the repo
#     has none, and building one produced 7302 module-resolution errors.
#   - Whether a comment that resolves is actually TRUE. A `{@link}` whose target
#     still exists passes even if the surrounding sentence describes it wrongly.
#
# Runs in CI (.github/workflows/ci.yml) and as `pnpm lint:doc-links` locally.
# A non-zero exit blocks merge. Pass --self-test to verify the checker itself
# (a clean tree must pass; an injected dangling link must fail).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Every package. web is scanned differently — see "TWO SCAN MODES" above.
PACKAGES=(shared core domain server worker collab web)

# Shared TypeDoc settings live here so no package can drift on validation flags.
OPTIONS_FILE="typedoc.doclinks.json"

# Check one package. Prints TypeDoc's warnings on failure.
# $1 = package directory name under packages/
check_package() {
  local pkg="$1"
  local entry strategy out

  if [[ "$pkg" == "web" ]]; then
    entry="packages/web/src"        # application: every file is its own root
    strategy="expand"
  else
    entry="packages/${pkg}/src/index.ts"   # library: follow the export surface
    strategy="resolve"
  fi

  out=$(npx typedoc --emit none \
    --options "$OPTIONS_FILE" \
    --entryPoints "$entry" \
    --entryPointStrategy "$strategy" \
    --tsconfig "packages/${pkg}/tsconfig.json" \
    2>&1 | sed 's/\x1b\[[0-9;]*m//g')

  if printf '%s' "$out" | grep -qE '^\[(warning|error)\]'; then
    printf '%s\n' "FAIL  ${pkg}"
    printf '%s\n' "$out" | grep -E '^\[(warning|error)\]' | sed 's/^/        /'
    return 1
  fi
  printf '%s\n' "PASS  ${pkg}"
  return 0
}

run_all() {
  local failed=0
  for pkg in "${PACKAGES[@]}"; do
    check_package "$pkg" || failed=1
  done
  return "$failed"
}

# --self-test: prove the checker can both pass and fail. A checker that only
# ever passes is indistinguishable from one that is broken.
if [[ "${1:-}" == "--self-test" ]]; then
  probe="packages/shared/src/__doc_link_probe__.ts"
  barrel="packages/shared/src/index.ts"
  backup="$(mktemp)"

  # The probe is only visible to TypeDoc if the barrel re-exports it, so this
  # test has to edit a real source file and put it back afterwards.
  #
  # It must NOT put it back with `git checkout --`: that restores the HEAD
  # version and silently discards whatever uncommitted work the developer had
  # in the barrel, which git cannot recover. Keep a byte-exact copy instead,
  # and restore on every exit path including Ctrl-C — otherwise an interrupted
  # run leaves both a stray probe file and a modified barrel behind.
  cp "$barrel" "$backup"
  cleanup_probe() {
    cp "$backup" "$barrel"
    rm -f "$backup" "$probe"
  }
  trap cleanup_probe EXIT INT TERM

  echo "self-test 1/2: clean tree must PASS"
  if ! run_all >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: the clean tree does not pass. Fix the real findings first."
    run_all
    exit 1
  fi
  echo "  ok"

  echo "self-test 2/2: an injected dangling link must FAIL"
  cat > "$probe" <<'PROBE'
// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Probe used by lint-doc-links.sh --self-test. Deleted immediately after.
 * See {@link aSymbolThatDoesNotExistAnywhere} for details.
 * @returns nothing useful.
 */
export function docLinkProbe(): void {}
PROBE
  # The probe only participates if it is reachable from the entry point.
  printf '\nexport { docLinkProbe } from "./__doc_link_probe__.js";\n' >> "$barrel"

  if check_package shared >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a dangling {@link} did not trip the checker."
    exit 1
  fi
  echo "  ok"

  echo "self-test passed"
  exit 0
fi

echo "Checking TSDoc {@link} targets resolve (${#PACKAGES[@]} packages)..."
if run_all; then
  echo "OK: every {@link} resolves."
  exit 0
fi
cat <<'MSG'

A TSDoc {@link} points at a symbol that does not resolve.

  - Target was deleted or renamed  -> fix the comment; it is describing
    something that no longer exists.
  - Target lives in another package -> write it as `Symbol` in backticks.
    Cross-package links cannot resolve (see the header of this script).
  - Target exists but is not exported -> use backticks, or export it.

MSG
exit 1
