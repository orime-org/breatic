/**
 * Cross-process control-plane events.
 *
 * One pub/sub channel remains:
 *
 *   - `members:changed`  — kick affected user's ws + broadcast
 *                          stateless invalidate signal to the
 *                          project's connected clients
 *
 * Space lifecycle (`space:created` / `:deleted` / `:locked`) used
 * to live here but moved to collab stateless RPC 2026-05-23 (ADR
 * yjs-collab-only-write-authz). The `SpaceRpc*` schemas in
 * `./space-rpc.ts` replace those event types.
 *
 * Channel naming convention: `project:{projectId}:{topic}`.
 *
 * Pub/sub channels are NOT scoped to Redis logical DBs (they are
 * global to the Redis instance), but we keep the publishers and
 * subscribers on DB2 to colocate with Hocuspocus's existing
 * cross-instance pub/sub usage and avoid mixing semantics with the
 * auth-related DB0 (session / lock / rate-limit).
 */

import type { ProjectRole } from "./role.js";

// ── Members ─────────────────────────────────────────────────────────

/**
 * Permission state changed for a project.
 *
 * `affectedUserId === 'all'` is the owner-transfer broadcast (V2;
 * not used in V1 because transfer-owner is deferred — but the type
 * leaves room so PR-D's frontend invalidate handler is forward
 * compatible).
 */
export interface MembersChangedEvent {
  type: "project-members:changed";
  projectId: string;
  affectedUserId: string | "all";
  action: "invite" | "update" | "remove" | "owner-transfer";
  newRole?: ProjectRole;
  fromUserId?: string;
  toUserId?: string;
  /** Epoch ms — for staleness checks on the consumer side. */
  ts: number;
}

// ── Channel names (single source of truth) ──────────────────────────

/** Channel pattern for `members:changed`. */
export function membersChangedChannel(projectId: string): string {
  return `project:${projectId}:members:changed`;
}

/**
 * Glob pattern that matches every project-scoped pub/sub channel
 * the Collab process needs to subscribe to. Using a single
 * `psubscribe` keeps the connection count down vs subscribing each
 * channel separately.
 */
export const ALL_PROJECT_CHANNELS_PATTERN = "project:*";
