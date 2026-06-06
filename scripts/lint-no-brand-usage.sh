#!/usr/bin/env bash
# Brand-guard (code-side) — fail CI / pre-commit if a raw brand token is used
# in packages/web/src OUTSIDE the whitelist.
#
# Why: chrome-baseline §F10 "Monochrome Chrome Rule" — chrome defaults neutral
# (black / grays / white); brand color is reserved for logo identity + status
# indicators ONLY. The Studio chrome was a brand exemption, but the 2026-06-06
# studio-visual-direction-neutral ADR reversed it — the studio is now neutral
# (semantic neutral tokens), with only its logo (--brand-logo-primary) keeping
# brand identity.
# Authorizing ADR (breatic-inner-design):
#   design/decisions/2026-06-06-studio-visual-direction-neutral.md
#   (supersedes 2026-06-05-studio-brand-exemption.md)
#
# Banned (outside whitelist): bg/text/border/ring-brand-<N>, --color-brand-<a>,
# and any var(--brand-...) reference (catches --brand-500, --brand-accent, etc.).
#
# Whitelist (filtered out — allowed to use brand):
#   - packages/web/src/theme/tokens.css   token definitions
#   - --brand-logo-primary                logo identity alias (§F10 logo)
#   - per-line escape: a line containing "brand-guard: allow"
#
# Exit code:
#   0 — no violations
#   1 — at least one violation; prints file:line:matched
#   2 — misconfiguration (web src not found)
#
# Usage:
#   ./scripts/lint-no-brand-usage.sh            scans packages/web/src (default)
#   ./scripts/lint-no-brand-usage.sh <dir>      scans <dir> (for tests / isolation)
#   pnpm lint:no-brand-usage     (wired in package.json + CI)
set -euo pipefail
export LC_ALL=C

# Scan root is overridable (first arg) so the guard is testable against an
# isolated fixture tree without touching the real source tree. Whitelist paths
# (theme/tokens.css, pages/studio/) are resolved relative to this root.
WEB_SRC="${1:-packages/web/src}"
PATTERN='bg-brand-[0-9]|text-brand-[0-9]|border-brand-[0-9]|ring-brand-[0-9]|--color-brand-[a-z]|var\(--brand-'

if [ ! -d "$WEB_SRC" ]; then
  echo "lint-no-brand-usage: $WEB_SRC not found (run from repo root)" >&2
  exit 2
fi

# grep all matches, then post-filter the whitelist. We do NOT rely on grep's
# --exclude after --include (BSD grep ignores --exclude in that order — see
# memory reference_bsd_grep_exclude_order_trap); filter paths explicitly.
RAW=$(grep -Ern --include='*.ts' --include='*.tsx' --include='*.css' "$PATTERN" "$WEB_SRC" || true)

MATCHES=$(printf '%s\n' "$RAW" \
  | grep -v '^[[:space:]]*$' \
  | grep -v "$WEB_SRC/theme/tokens.css:" \
  | grep -v 'brand-logo-primary' \
  | grep -v 'brand-guard: allow' \
  || true)

if [ -z "$MATCHES" ]; then
  echo "lint-no-brand-usage: clean ✅ (no raw brand outside whitelist in $WEB_SRC)"
  exit 0
fi

echo "lint-no-brand-usage: ❌ FAIL — raw brand token used outside whitelist:" >&2
echo "" >&2
echo "$MATCHES" >&2
echo "" >&2
echo "Rule: chrome-baseline §F10 Monochrome Chrome Rule — chrome / canvas / studio stay neutral." >&2
echo "Only the logo (--brand-logo-primary) + status colors keep brand identity." >&2
echo "ADR (breatic-inner-design): design/decisions/2026-06-06-studio-visual-direction-neutral.md" >&2
echo "Escape one line intentionally: append a 'brand-guard: allow' comment." >&2
exit 1
