#!/usr/bin/env bash
# lint-no-sync-in-request-path — forbid synchronous, event-loop-blocking
# fs / child_process calls in backend code, EXCEPT documented boot-time
# loaders.
#
# Rationale (CLAUDE.md 禁止清单 #10 "同步阻塞事件循环" + CI maximal-
# strictness guard suite, inner ADR 2026-06-01): Node runs request
# handling on a single event loop. A synchronous fs/exec call
# (readFileSync, execSync, …) blocks that loop — every concurrent
# request stalls until the syscall returns. In request-handling code
# this is forbidden; use the async (await fs.promises.*) form.
#
# HONEST SCOPE (this is a directory/path proxy, not a literal proof):
# grep cannot prove a given call runs per-request vs once at startup.
# So this guard scans all backend src and ALLOWLISTS the boot-time /
# first-use loaders that legitimately read their files synchronously
# ONCE (cached thereafter), not per request:
#   - */config/  + a package-root config.ts  — config loaded at startup
#   - */infra/                                — logger dir init, the
#                                               local-storage dev adapter
#   - *-loader.ts                             — agent / skills / locale
#                                               static loaders (boot/
#                                               first-use, cached)
#   - */model-catalog/                        — model config catalog
#                                               (boot/first-use, cached)
#   - agent/tools/fs-sandbox.ts               — sandbox root is mkdir'd +
#                                               realpath-normalized ONCE at
#                                               module load; per-request
#                                               path checks use async
#                                               fs.promises.realpath
#   - worker providers/shared.ts              — loadConfig() memoizes each
#                                               modality's provider YAML in
#                                               _configCache (read once per
#                                               modality, not per job)
# Each allowlisted path is justified above; anything else with a sync
# call is flagged. It does NOT prove the request path is sync-free (a
# sync call hidden behind a per-request helper in a non-allowlisted file
# WOULD be caught, but a per-request call inside an allowlisted loader
# would not) — 禁#10 still needs human review for hot-path sync I/O.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:no-sync-in-request-path`. Non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Node fs sync methods + child_process sync spawners. Listed explicitly
# (rather than a broad `[A-Za-z]+Sync\(`) so unrelated user functions
# whose names happen to end in "Sync" don't false-positive.
SYNC_REGEX='\b(readFileSync|writeFileSync|appendFileSync|existsSync|readdirSync|statSync|lstatSync|mkdirSync|rmdirSync|rmSync|unlinkSync|renameSync|copyFileSync|chmodSync|realpathSync|accessSync|readlinkSync|truncateSync|openSync|execSync|execFileSync|spawnSync)\b'

# Boot-time / first-use loader paths (justified in the header). These
# read static config/asset files once, not per request.
ALLOWLIST_REGEX='(/config/|/config\.ts$|/infra/|-loader\.ts$|/model-catalog/|/agent/tools/fs-sandbox\.ts$|/providers/shared\.ts$)'

SCAN_DIRS=(
  packages/core/src
  packages/domain/src
  packages/server/src
  packages/worker/src
  packages/collab/src
)

CANDIDATES=$(find "${SCAN_DIRS[@]}" \
  -type f \
  -name '*.ts' \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
  -not -name '*.spec.ts' \
  2>/dev/null || true)

MATCHES=""
for file in $CANDIDATES; do
  # Skip documented boot-time loaders.
  if printf '%s' "$file" | grep -qE "$ALLOWLIST_REGEX"; then
    continue
  fi
  # Strip // line + /* ... */ block comments before scanning.
  cleaned=$(sed -e 's@//.*$@@' -e 's@/\*[^*]*\*/@@g' "$file" \
    | awk '
        BEGIN { in_block = 0 }
        {
          line = $0
          while (length(line) > 0) {
            if (in_block) {
              i = index(line, "*/")
              if (i == 0) { line = ""; break }
              line = substr(line, i + 2)
              in_block = 0
            } else {
              i = index(line, "/*")
              if (i == 0) { print line; break }
              print substr(line, 1, i - 1)
              line = substr(line, i + 2)
              in_block = 1
            }
          }
        }
      ')
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$SYNC_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-sync-in-request-path — synchronous fs/exec call outside a boot-time loader:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md 禁止清单 #10, synchronous fs/child_process calls" >&2
  echo "block the event loop and are forbidden in request-handling code." >&2
  echo "Use the async form (await fs.promises.*). If this is a genuine" >&2
  echo "boot-time/first-use loader, add its path to the ALLOWLIST in" >&2
  echo "scripts/lint-no-sync-in-request-path.sh with a justification." >&2
  exit 1
fi

echo "lint:no-sync-in-request-path — clean (no sync fs/exec outside boot-time loaders)"
