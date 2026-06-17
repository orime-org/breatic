#!/usr/bin/env bash
# lint-no-translated-product-noun — enforce the product-term "do-not-translate"
# glossary: 8 product entity / type nouns (Studio / Project / Collection /
# Space / Work / Canvas / Document / Timeline) are brand vocabulary kept in
# English in every locale, even inside translated sentences (the Figma "Frame"
# / GitHub "Repository" / Notion "Database" convention).
#
# Rationale (user decision 2026-06-17): a non-English UI must show the SAME
# product name everywhere; a translator (or a new string) reintroducing the
# localized word silently fragments the brand vocabulary. This blanket guard
# covers the collision-free translated forms (Project / Collection / Work /
# Studio + Space's distinctive forms), which must NEVER appear in any locale
# value — future-proofing every new key, not just today's set.
#
# Collision forms that legitimately stay localized as a common word (Canvas's
# form also means the drawing surface, Timeline's form also means the
# video-editor track, Document's form also means "a file", and Space's
# katakana/hangul form is a substring of "Workspace") are NOT in this denylist;
# they are enforced per-key by
# packages/web/src/i18n/__tests__/frozen-product-terms.test.ts.
#
# Implementation: detection is scripts/check-translated-product-noun.mjs (Node,
# parses JSON string values only — never key names or ICU placeholders — and
# avoids the BSD-grep multibyte character-class locale trap). This wrapper just
# runs it.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:no-translated-product-noun`. Non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

node scripts/check-translated-product-noun.mjs
