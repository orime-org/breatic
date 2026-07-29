#!/usr/bin/env bash
# Guard: notification payloads carry ids, never names or slugs.
#
# Why a script and not the type checker: the consumers read these payloads by
# STRING KEY out of an opaque record (`str(payload, 'fromHandle')`), so
# re-introducing one compiles cleanly and fails only at runtime, silently, as
# a missing name or a dead link.
#
# What goes wrong if a name-shaped key comes back: a stored slug is a snapshot.
# Renaming a studio releases the old slug for anyone to claim, and a personal
# studio's slug IS its owner's @handle — so an old notification ends up naming
# and linking to a stranger, with nothing in the stored string to reveal it.
# The fix, already in place, is to store the id and resolve display identity at
# read time.
#
# Self-test: `--self-test` proves the matcher still catches a planted
# violation, so the guard cannot rot into an always-pass.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BANNED='requesterHandle|deciderHandle|inviterHandle|inviteeHandle|fromHandle|accepterHandle|projectSlug|studioSlug'

# Where notification payloads are produced and consumed. Deliberately narrow:
# `projectSlug` is a perfectly good name elsewhere (project routes, canvas),
# and this guard is about NOTIFICATION payloads only.
# Scoped to where payloads are DEFINED and CONSUMED, not to every file that
# happens to build one. The producers pass a typed payload, so re-adding a key
# there is a compile error and needs no grep. The consumers read by string key
# out of an opaque record — that is the hole this guard covers.
#
# Kept out on purpose: the invite landing services legitimately return
# `{ studioSlug }` / `{ projectSlug }` for a post-confirm redirect. That is a
# live lookup answering "where do I send this person now", not a name frozen
# into a stored record — the opposite of what this guard is about.
SCAN_PATHS=(
  "packages/server/src/modules/notification"
  "packages/web/src/features/notifications"
)

scan() {
  local root="$1"
  local hits=""
  for rel in "${SCAN_PATHS[@]}"; do
    local target="$root/$rel"
    [ -e "$target" ] || continue
    local found
    found="$(grep -rnE "$BANNED" "$target" \
      --include='*.ts' --include='*.tsx' 2>/dev/null \
      | grep -vE '^\s*[0-9]+:\s*(//|\*|/\*)' \
      | grep -vE ':\s*[0-9]+:.*(not\.toHaveProperty|// allow-notification-name-key)' || true)"
    [ -n "$found" ] && hits+="$found"$'\n'
  done
  printf '%s' "$hits"
}

if [ "${1:-}" = "--self-test" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/packages/web/src/features/notifications"
  printf 'const x = str(p, "fromHandle");\n' \
    > "$TMP/packages/web/src/features/notifications/planted.ts"
  if [ -z "$(scan "$TMP")" ]; then
    echo "FAIL self-test: the matcher did not catch a planted violation"
    exit 1
  fi
  echo "lint:no-notification-name-keys self-test OK"
  exit 0
fi

HITS="$(scan "$ROOT")"
if [ -n "$HITS" ]; then
  echo "Notification payloads must carry ids, not names or slugs."
  echo
  echo "$HITS"
  echo
  echo "A stored slug is a snapshot: renaming releases the old one for anyone"
  echo "to claim, and a personal studio's slug is its owner's @handle — so an"
  echo "old notification ends up naming a stranger. Store the id (fromUserId,"
  echo "studioId, projectId, ...) and let the list endpoint resolve the current"
  echo "name and link (see notification-refs.ts)."
  echo
  echo "Asserting a key is ABSENT in a test is fine (not.toHaveProperty)."
  exit 1
fi

echo "lint:no-notification-name-keys OK"
