// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The threads newly handed to this connection (breatic#1488 §7, §15.11):
 * collab adds them to the connection's DB4 set, and every tool result takes
 * what is there, so each hand-over is told once.
 */

import type { Redis } from "@breatic/core";
import { mcpNewAssignmentsKey } from "@breatic/shared";

/** Takes the connection's new hand-overs. */
export interface NewAssignments {
  /** Take every member in the set; resolves to how many there were. */
  take: () => Promise<number>;
}

/**
 * The taker for one connection.
 * @param deps - Where the set lives.
 * @param deps.redis - The DB4 client.
 * @param deps.prefix - The deployment's Redis key prefix.
 * @param deps.connectionId - The connection.
 * @returns The taker.
 */
export function createNewAssignments(deps: { redis: Redis; prefix: string; connectionId: string }): NewAssignments {
  const key = mcpNewAssignmentsKey(deps.prefix, deps.connectionId);
  return {
    take: async (): Promise<number> => {
      const size = await deps.redis.scard(key);
      if (size === 0) return 0;
      // SPOP is atomic, so two calls taking at once never both get a member.
      return (await deps.redis.spop(key, size)).length;
    },
  };
}
