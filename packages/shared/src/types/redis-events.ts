// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import type { ProjectRole } from "@shared/types/role.js";

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

// ── Project lifecycle (transactional outbox → durable stream) ───────
//
// Yjs document store lives in a SEPARATE Postgres database from the
// business tables, so a project delete / duplicate can no longer
// cascade to `yjs_documents` inside the business transaction. Instead
// the server writes one of these commands to a transactional outbox in
// the same business tx; a relay forwards it to a durable Redis Stream;
// collab consumes it and performs the yjs-DB side idempotently. (Create
// is NOT on this stream — collab lazy-seeds the meta doc on first load.)

/** Cascade-soft-delete a deleted project's Yjs documents. */
export interface ProjectDeletedLifecycleEvent {
  type: "project:deleted";
  projectId: string;
  /** Epoch ms — when the business delete committed. */
  ts: number;
}

/** Copy a source project's Yjs documents into a freshly duplicated one. */
export interface ProjectDuplicatedLifecycleEvent {
  type: "project:duplicated";
  sourceId: string;
  newId: string;
  /** Epoch ms — when the business duplicate committed. */
  ts: number;
}

/** Discriminated union of every project-lifecycle command on the stream. */
export type ProjectLifecycleEvent =
  | ProjectDeletedLifecycleEvent
  | ProjectDuplicatedLifecycleEvent;

// ── Channel names (single source of truth) ──────────────────────────

/**
 * Channel pattern for `members:changed`.
 * @param projectId - the project whose membership-change channel is built
 * @returns the pub/sub channel name `project:{projectId}:members:changed`
 */
export function membersChangedChannel(projectId: string): string {
  return `project:${projectId}:members:changed`;
}

/**
 * Glob pattern that matches every project-scoped pub/sub channel
 * the Collab process needs to subscribe to. Using a single
 * `psubscribe` keeps the connection count down vs subscribing each
 * channel separately.
 */
/**
 * Control event announcing a new project_activities row written by
 * server or worker - collab relays it as the `activity:new` stateless
 * signal on the project meta doc (ADR 2026-07-04 project-activity-feed).
 * Fire-and-forget pub/sub by design: an offline collab instance safely
 * misses it (clients refetch via REST when the panel opens).
 */
export interface ActivityNewControlEvent {
  type: "project-activity:new";
  projectId: string;
  ts: number;
}

/**
 * Pub/sub channel for {@link ActivityNewControlEvent}. Matched by
 * {@link ALL_PROJECT_CHANNELS_PATTERN}, so the collab control-plane
 * subscriber receives it without a second subscription.
 * @param projectId - Project scope of the channel.
 * @returns The channel name.
 */
export function activityNewChannel(projectId: string): string {
  return `project:${projectId}:activity:new`;
}

export const ALL_PROJECT_CHANNELS_PATTERN = "project:*";
