#!/usr/bin/env bash
# Bare-toast guard — fail CI / pre-commit if a toast is shown WITHOUT a
# semantic type.
#
# Why: sonner colors a toast by its `data-type` (see the type accent in
# packages/web/src/index.css), and that attribute is set by the CALL — only
# toast.error / .warning / .success / .info carry one. A bare `toast(...)` (or
# `toast.message(...)`, likewise untyped) renders neutral, so an error / warning
# notice silently loses its color signal — exactly the bug this rule prevents
# from recurring (2026-07-15). Every toast must declare a semantic type;
# neutral / informational notices use `toast.info(...)`.
#
# Allowed (special-purpose, not "an untyped message"):
#   toast.loading / toast.promise / toast.dismiss / toast.custom
#
# Forbidden:
#   toast(...)            bare default call — no data-type
#   toast.message(...)    titled-but-untyped — use toast.info instead
#
# Escapes:
#   - comment-only lines are ignored (JSDoc / // / /* mentioning toast())
#   - per-line: append `// bare-toast: allow` to a genuinely-exempt line
#
# Scans packages/web/src *.ts/*.tsx (skips tests). Exit: 0 clean, 1 violation,
# 2 misconfig.
#
# Usage:
#   ./scripts/lint-no-bare-toast.sh              scans packages/web/src (default)
#   ./scripts/lint-no-bare-toast.sh <dir>        scans <dir> (for isolation)
#   ./scripts/lint-no-bare-toast.sh --self-test  verifies the checker itself
#   pnpm lint:no-bare-toast      (wired in package.json + CI)
set -euo pipefail
export LC_ALL=C

# `\btoast(` matches a bare call (`toast(` / `.toast(` / ` toast(`) but NOT
# `toast.error(` etc. — there the `(` follows `.error`, not `toast`. The second
# alternative pins the one typed-but-neutral method we also forbid.
PATTERN='\btoast\(|\btoast\.message\('

# Scan a source tree and print offending `file:line:content`, dropping test
# files, comment-only lines, and the per-line escape.
scan() {
  local root="$1"
  grep -rnE "$PATTERN" \
    --include='*.ts' --include='*.tsx' \
    "$root" 2>/dev/null \
    | grep -vE '/__tests__/|\.test\.|\.spec\.' \
    | grep -vE ':[0-9]+:[[:space:]]*(\*|//|/\*)' \
    | grep -v 'bare-toast: allow' \
    || true
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # Negative fixtures (must NOT trip): typed calls, special-purpose calls,
  # a comment mentioning toast(), and an escaped line.
  cat >"$tmp/ok.ts" <<'EOF'
toast.error('boom');
toast.warning('careful');
toast.success('done');
toast.info('fyi');
toast.loading('working');
toast.promise(p, {});
toast.dismiss();
// Most code calls sonner.toast() directly — this line is a comment.
const x = toast('legacy'); // bare-toast: allow
EOF
  # Positive fixtures (MUST trip): a bare call and a toast.message call.
  cat >"$tmp/bad.ts" <<'EOF'
toast('untyped bare call');
toast.message('titled but untyped');
EOF
  ok_hits="$(scan "$tmp/ok.ts")"
  if [[ -n "$ok_hits" ]]; then
    echo "lint:no-bare-toast — SELF-TEST FAILED: false positive on typed/comment/escaped lines:" >&2
    echo "$ok_hits" >&2
    exit 1
  fi
  bad_hits="$(scan "$tmp/bad.ts" | wc -l | tr -d ' ')"
  if [[ "$bad_hits" -ne 2 ]]; then
    echo "lint:no-bare-toast — SELF-TEST FAILED: expected 2 violations in bad fixture, got $bad_hits" >&2
    exit 1
  fi
  echo "lint:no-bare-toast — self-test passed (catches bare toast() + toast.message(), allows typed + comments + escape)"
  exit 0
fi

WEB_SRC="${1:-packages/web/src}"
if [[ ! -d "$WEB_SRC" ]]; then
  echo "lint:no-bare-toast — misconfig: '$WEB_SRC' not found" >&2
  exit 2
fi

violations="$(scan "$WEB_SRC")"
if [[ -n "$violations" ]]; then
  echo "lint:no-bare-toast — FAIL: untyped toast found. Use toast.error / .warning / .success / .info (neutral → .info); see packages/web/CLAUDE.md." >&2
  echo "$violations" >&2
  exit 1
fi
echo "lint:no-bare-toast — clean ✅ (every toast declares a semantic type)"
exit 0
