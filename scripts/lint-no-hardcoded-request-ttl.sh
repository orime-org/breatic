#!/usr/bin/env bash
# Guard: how long a deferred-decision request stays live is ONE configured
# value, never arithmetic spelled out at a call site.
#
# Five flows ask someone to answer later: studio invite, project invite, studio
# transfer, project transfer, role upgrade. Four of them used to carry their own
# `const X_TTL_DAYS = 7` and their own `Date.now() + n * 24 * 60 * 60 * 1000`;
# the fifth had no expiry at all, so a role-upgrade request could sit pending
# forever. Five copies is five chances to drift, and a user cannot answer "how
# long do I have" if it depends on which flow they are in.
#
# Why a script and not the type checker: re-introducing a local constant
# compiles perfectly. Nothing breaks until the day someone edits
# config/limits.yaml and four of the five flows ignore it.
#
# The one blessed place is packages/server/src/config/limits.ts —
# `deferredRequestExpiry()` / `deferredRequestTtlSeconds()` — which is outside
# the scanned tree, so it needs no exception.
#
# Deliberately NOT in scope: session lifetime (core/infra/session-store.ts,
# middleware/session-cookie.ts). A 30-day session is a different concept that
# happens to be measured in days; sweeping it in would make this guard about
# "day arithmetic" instead of about request TTLs.
#
# Tests are exempt: they legitimately construct arbitrary instants, including
# deliberately-expired ones, which is exactly how the expiry gate is verified.
#
# Self-test: `--self-test` proves the matcher still catches a planted
# violation, so the guard cannot rot into an always-pass.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Two shapes: a re-introduced day-count constant, and day arithmetic written
# out longhand (both the millisecond and the second form).
BANNED='TTL_DAYS|24 \* 60 \* 60'

SCAN_REL="packages/server/src/modules"

scan() {
  local root="$1"
  local target="$root/$SCAN_REL"
  [ -e "$target" ] || return 0
  # Recursive grep emits `<path>:<lineno>:<content>`, so the comment filter has
  # to skip past both fields; anchoring on the line number alone matches
  # nothing, and prose merely NAMING the pattern would fail the build.
  grep -rnE "$BANNED" "$target" --include='*.ts' 2>/dev/null \
    | grep -vE '/__tests__/' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' \
    || true
}

if [ "${1:-}" = "--self-test" ]; then
  TMP="$(mktemp -d)" || exit 1
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/$SCAN_REL/studio" || exit 1
  printf 'const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);\n' \
    > "$TMP/$SCAN_REL/studio/planted.ts" || exit 1
  if [ -z "$(scan "$TMP")" ]; then
    echo "FAIL self-test: the matcher did not catch a planted violation"
    exit 1
  fi
  # And the exemption must still hold, or every acceptance test trips the guard.
  mkdir -p "$TMP/$SCAN_REL/studio/__tests__" || exit 1
  mv "$TMP/$SCAN_REL/studio/planted.ts" \
     "$TMP/$SCAN_REL/studio/__tests__/planted.ts" || exit 1
  if [ -n "$(scan "$TMP")" ]; then
    echo "FAIL self-test: a test file tripped the guard; tests are exempt"
    exit 1
  fi
  echo "lint:no-hardcoded-request-ttl self-test OK"
  exit 0
fi

HITS="$(scan "$ROOT")"
if [ -n "$HITS" ]; then
  echo "A request's TTL is configuration, not arithmetic at the call site."
  echo
  echo "$HITS"
  echo
  echo "All five deferred decisions — studio invite, project invite, studio"
  echo "transfer, project transfer, role upgrade — share one knob:"
  echo "  config/limits.yaml -> deferred_request_ttl_days"
  echo
  echo "Stamp an expiry with deferredRequestExpiry() from"
  echo "@server/config/limits.js, or deferredRequestTtlSeconds() where a"
  echo "duration is what you need. Both read that one knob."
  exit 1
fi

echo "lint:no-hardcoded-request-ttl OK"
