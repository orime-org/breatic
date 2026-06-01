#!/usr/bin/env bash
# lint-no-hardcoded-secrets — block hardcoded secrets in source.
#
# Rationale (CLAUDE.md prohibition list #4 "硬编码密钥" + security mandate +
# CI maximal-strictness guard suite, inner ADR 2026-06-01): API keys,
# tokens, passwords and credentialed connection strings must come from the
# environment (env Proxy / getConfig), never be committed in source. The
# .husky/pre-commit hook already blocks committing secret FILES
# (.env / .pem / .key / id_rsa); this guard covers the complementary case —
# a secret pasted INLINE into a tracked source / config / doc file.
#
# Detection is secretlint with @secretlint/secretlint-rule-preset-recommend
# (27 battle-tested rules: AWS / GCP / Stripe / GitHub / Slack / OpenAI /
# Anthropic / private keys / database connection strings / …). Provider
# token formats are low false-positive (they do not occur by accident), so
# this is a low-noise guard despite scanning the whole tree.
#
# ALLOWLIST (.secretlintrc.json, each entry justified, NOT a back door):
#   - postgres://breatic:breatic@…  the project's documented local-dev /
#                                   docker default DSN (non-secret
#                                   placeholder creds, shown on purpose in
#                                   docs/DEPLOY.md and used as the
#                                   drizzle.config.ts fallback). A real
#                                   prod DSN — any other credentials —
#                                   still fails.
# False positives are handled by adding a justified `allows` entry to that
# config, never by weakening the rule set.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:no-hardcoded-secrets`. Non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Tracked text files (node_modules / dist are gitignored, so excluded).
# Skip the generated lockfile and never touch any .env* template.
FILES=$(git ls-files \
  | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|css|scss|html|sh|sql)$' \
  | grep -vE '(^|/)pnpm-lock\.yaml$' \
  | grep -vE '(^|/)\.env' \
  || true)

if [[ -z "$FILES" ]]; then
  echo "lint:no-hardcoded-secrets — no files to scan"
  exit 0
fi

# --no-glob: treat each argument as a literal path (we already resolved the
# list via git ls-files, which respects .gitignore). Repo paths have no
# spaces, so word-splitting $FILES into args is safe.
# shellcheck disable=SC2086
if ! node_modules/.bin/secretlint --no-color --no-glob $FILES; then
  echo "" >&2
  echo "lint:no-hardcoded-secrets — secretlint found hardcoded secret(s) above." >&2
  echo "Per CLAUDE.md prohibition #4, secrets (API keys / tokens / passwords /" >&2
  echo "connection strings) must come from env, never source. If a hit is a" >&2
  echo "genuine false positive, add a justified allows entry to" >&2
  echo ".secretlintrc.json (see the header of this script)." >&2
  exit 1
fi

echo "lint:no-hardcoded-secrets — clean (secretlint preset-recommend, no hardcoded secrets)"
