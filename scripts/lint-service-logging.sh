#!/usr/bin/env bash
# lint-service-logging — require each long-running service entry
# (server / worker / collab) to wire up a logger AND a health server.
#
# Rationale (CLAUDE.md "server-side industrial-grade standards" mandate):
# A service whose logger is deleted or never wired fails silently —
# collab ran 2026-06-01 → 06-16 with dead file logging and nobody
# noticed, turning a recoverable connection fault into an undiagnosable
# stuck "session invalid" banner. This guard statically asserts the two
# load-bearing observability wires exist in each service entry:
#
#   1. a logger is obtained  (createLogger | initLogger | logger.<level>)
#   2. startHealthServer is called  (so /healthz exists)
#
# Honest limit (decision 2026-06-16, option A "structural guard"): a
# static grep proves the WIRING exists in source, not that the service
# actually emits logs at runtime — that's what smoke / E2E cover. This
# guard's job is to stop a logger / health wire from being silently
# removed, which is a real and cheap-to-catch regression class.
#
# Runs in CI (see `.github/workflows/ci.yml`) and as
# `pnpm lint:service-logging` for local use. A non-zero exit blocks the
# PR merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The long-running service entry points that MUST be observable.
SERVICE_ENTRIES=(
  packages/server/src/index.ts
  packages/worker/src/index.ts
  packages/collab/src/index.ts
)

# A logger is obtained one of three idiomatic ways across the services:
#   - collab: createLogger("main")
#   - worker: initLogger("worker")
#   - server: logger.info(...) on the core default logger
LOGGER_REGEX='\bcreateLogger\b|\binitLogger\b|\blogger\.(info|warn|error|debug|fatal|trace)\b'
HEALTH_REGEX='\bstartHealthServer\b'

# Portable comment stripper (BSD + GNU): drop // line comments and
# /* ... */ block comments (single- and multi-line) so a commented-out
# logger call can't falsely satisfy the requirement.
strip_comments() {
  sed -e 's@//.*$@@' -e 's@/\*[^*]*\*/@@g' "$1" \
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
      '
}

PROBLEMS=""
for entry in "${SERVICE_ENTRIES[@]}"; do
  if [[ ! -f "$entry" ]]; then
    PROBLEMS+="${entry}: service entry not found"$'\n'
    continue
  fi
  cleaned=$(strip_comments "$entry")
  if ! printf '%s\n' "$cleaned" | grep -qE "$LOGGER_REGEX"; then
    PROBLEMS+="${entry}: no logger wired (expected createLogger / initLogger / logger.<level>)"$'\n'
  fi
  if ! printf '%s\n' "$cleaned" | grep -qE "$HEALTH_REGEX"; then
    PROBLEMS+="${entry}: no startHealthServer() call (no /healthz)"$'\n'
  fi
done

if [[ -n "$PROBLEMS" ]]; then
  echo "lint:service-logging — a service entry is missing required observability wiring:" >&2
  echo "" >&2
  printf '%s' "$PROBLEMS" >&2
  echo "" >&2
  echo "Per CLAUDE.md 'industrial-grade server standards', every" >&2
  echo "long-running service (server / worker / collab) must wire a" >&2
  echo "logger AND a /healthz health server in its entry point. A" >&2
  echo "missing logger fails silently (collab lost 15 days of logs this" >&2
  echo "way); a missing healthz lets a drifted connection look healthy." >&2
  exit 1
fi

echo "lint:service-logging — clean (server / worker / collab entries each wire a logger + startHealthServer)"
