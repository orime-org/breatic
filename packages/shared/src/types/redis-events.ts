/**
 * Cross-process control-plane events (v10).
 *
 * Server publishes via Redis pub/sub on DB2 (REDIS_STREAM_URL). The
 * Collab process subscribes and reacts:
 *
 *   - `members:changed`  — kick affected user's ws + broadcast
 *                          stateless invalidate signal to the
 *                          project's connected clients
 *   - `space:created`    — apply `meta.spaces[id] = {...}`
 *   - `space:deleted`    — apply `meta.spaces.delete(id)`; the API
 *                          handler also soft-deletes the canvas-{sid}
 *                          row in `yjs_documents`
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
import type { SpaceType } from "./space.js";

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

// ── Spaces ──────────────────────────────────────────────────────────

/**
 * A Space was created. Collab must apply the `meta.spaces[spaceId]`
 * Y.Map entry. Frontend observers see the change and render the new
 * tab once the Yjs sync arrives.
 */
export interface SpaceCreatedEvent {
  type: "project-space:created";
  projectId: string;
  spaceId: string;
  spaceType: SpaceType;
  name: string;
  /** User who created the Space. */
  createdBy: string;
  /** Epoch ms. */
  ts: number;
}

/**
 * A Space was soft-deleted. Collab removes `meta.spaces[spaceId]`.
 * The API handler also marks the corresponding `yjs_documents` row
 * (`project-{pid}/canvas-{sid}` etc.) as soft-deleted directly via
 * SQL — no need to round-trip that part through collab.
 */
export interface SpaceDeletedEvent {
  type: "project-space:deleted";
  projectId: string;
  spaceId: string;
  /** User who deleted the Space (audit). */
  deletedBy: string;
  /** Epoch ms. */
  ts: number;
}

// ── Channel names (single source of truth) ──────────────────────────

/** Channel pattern for `members:changed`. */
export function membersChangedChannel(projectId: string): string {
  return `project:${projectId}:members:changed`;
}

/** Channel pattern for `space:created`. */
export function spaceCreatedChannel(projectId: string): string {
  return `project:${projectId}:space:created`;
}

/** Channel pattern for `space:deleted`. */
export function spaceDeletedChannel(projectId: string): string {
  return `project:${projectId}:space:deleted`;
}

/**
 * Glob pattern that matches every project-scoped pub/sub channel
 * the Collab process needs to subscribe to. Using a single
 * `psubscribe` keeps the connection count down vs subscribing each
 * channel separately.
 */
export const ALL_PROJECT_CHANNELS_PATTERN = "project:*";
