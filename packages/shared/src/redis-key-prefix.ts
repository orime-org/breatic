// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Redis key prefix rule every service applies the same way (breatic#1488):
 * core resolves its own config with it, and the MCP service resolves the same
 * prefix so the keys both sides build agree.
 */

/**
 * Characters a prefix may hold: letters, digits, `-` and `_`. The prefix goes
 * into Redis PSUBSCRIBE globs and the session cookie name, where `*`, `?`,
 * spaces, `;`, `,` or `:` would break matching or the cookie.
 */
export const REDIS_KEY_PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Resolve the deployment's Redis key prefix: a missing or blank prefix means
 * "use the environment name"; otherwise the prefix, trimmed.
 * @param prefix - The configured prefix, possibly unset or blank
 * @param env - The environment name used when no prefix is set
 * @returns The prefix every Redis key and channel starts with
 */
export function resolveRedisKeyPrefix(prefix: string | undefined, env: string): string {
  const trimmed = prefix?.trim();
  return trimmed ? trimmed : env;
}
