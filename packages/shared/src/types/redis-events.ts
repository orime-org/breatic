// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-process control-plane events.
 *
 * Two pub/sub channels:
 *
 *   - `activity:new`       — relay a new activity row to the project's
 *                            connected clients
 *   - `connections:close`  — close every connection to a project after a
 *                            duplicate / archive / restore
 *
 * Membership changes do not travel here: collab hears them from the trigger
 * on `project_members` (core `listenProjectMemberChanges`).
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

// ── Project lifecycle (transactional outbox → durable stream) ───────
//
// Yjs document store lives in a SEPARATE Postgres database from the
// business tables, so a project duplicate can no longer copy
// `yjs_documents` inside the business transaction. Instead
// the server writes one of these commands to a transactional outbox in
// the same business tx; a relay forwards it to a durable Redis Stream;
// collab consumes it and performs the yjs-DB side idempotently. Archive
// and restore ride the same stream for their connection kick, committed
// with the state change they announce. (Create is NOT on this stream —
// collab lazy-seeds the meta doc on first load.)

/** Copy a source project's Yjs documents into a freshly duplicated one. */
export interface ProjectDuplicatedLifecycleEvent {
  type: "project:duplicated";
  sourceId: string;
  newId: string;
  /** Epoch ms — when the business duplicate committed. */
  ts: number;
}

/** Drop a just-archived project's live connections so they come back read-only. */
export interface ProjectArchivedLifecycleEvent {
  type: "project:archived";
  projectId: string;
  /** Epoch ms — when the business archive committed. */
  ts: number;
}

/** Drop a just-restored project's live connections so they come back writable. */
export interface ProjectRestoredLifecycleEvent {
  type: "project:restored";
  projectId: string;
  /** Epoch ms — when the business restore committed. */
  ts: number;
}

/** Discriminated union of every project-lifecycle command on the stream. */
export type ProjectLifecycleEvent =
  | ProjectDuplicatedLifecycleEvent
  | ProjectArchivedLifecycleEvent
  | ProjectRestoredLifecycleEvent;

// ── Channel names (single source of truth) ──────────────────────────

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
 * {@link allProjectChannelsPattern}, so the collab control-plane
 * subscriber receives it without a second subscription.
 * @param prefix - Deployment namespace (`REDIS_KEY_PREFIX`, defaults to `ENV`).
 * @param projectId - Project scope of the channel.
 * @returns The channel name `{prefix}:project:{projectId}:activity:new`.
 */
export function activityNewChannel(prefix: string, projectId: string): string {
  return `${prefix}:project:${projectId}:activity:new`;
}

/**
 * Control event announcing that a charge made in a project committed
 * (inner#1611); collab relays it as the `credits:changed` stateless signal on
 * the project meta doc, and the top bar reads its credits again. Fire-and-forget
 * like {@link ActivityNewControlEvent}: a page that misses it reads the figure
 * on its next load.
 */
export interface CreditsChangedControlEvent {
  type: "project-credits:changed";
  projectId: string;
  ts: number;
}

/**
 * Pub/sub channel for {@link CreditsChangedControlEvent}. Matched by
 * {@link allProjectChannelsPattern}.
 * @param prefix - Deployment namespace (`REDIS_KEY_PREFIX`, defaults to `ENV`).
 * @param projectId - Project whose studio was charged.
 * @returns The channel name `{prefix}:project:{projectId}:credits:changed`.
 */
export function creditsChangedChannel(prefix: string, projectId: string): string {
  return `${prefix}:project:${projectId}:credits:changed`;
}

/** Why every collab instance closes a project's connections. */
export type ProjectConnectionsCloseReason = "content-updated" | "archived" | "restored";

/**
 * Control event asking every collab instance to close its connections to one
 * project (inner#1497 §6.2). The lifecycle consumer that handled the command runs
 * on one instance; the connections are spread across all of them.
 */
export interface ProjectConnectionsCloseEvent {
  type: "project-connections:close";
  projectId: string;
  reason: ProjectConnectionsCloseReason;
  ts: number;
}

/**
 * Pub/sub channel for {@link ProjectConnectionsCloseEvent}. Matched by
 * {@link allProjectChannelsPattern}.
 * @param prefix - Deployment namespace (`REDIS_KEY_PREFIX`, defaults to `ENV`).
 * @param projectId - Project whose connections are closed.
 * @returns The channel name `{prefix}:project:{projectId}:connections:close`.
 */
export function projectConnectionsCloseChannel(prefix: string, projectId: string): string {
  return `${prefix}:project:${projectId}:connections:close`;
}

/**
 * Control event announcing that sessions ended (inner#1548): signed out,
 * signed out of other devices, or ended by a password reset. Every collab
 * instance closes the connections opened with them. Carries session ids (a
 * hash of the token, see core `sessionId`), never the tokens.
 */
export interface SessionsRevokedEvent {
  type: "sessions:revoked";
  userId: string;
  sessionIds: string[];
  ts: number;
}

/**
 * Pub/sub channel for {@link SessionsRevokedEvent}. Outside the project
 * pattern: a session is not scoped to a project.
 * @param prefix - Deployment namespace (`REDIS_KEY_PREFIX`, defaults to `ENV`).
 * @returns The channel name `{prefix}:sessions:revoked`.
 */
export function sessionsRevokedChannel(prefix: string): string {
  return `${prefix}:sessions:revoked`;
}

/**
 * Glob pattern matching every project-scoped control channel the collab process
 * subscribes to. One `psubscribe` instead of one subscription per channel keeps
 * the connection count down.
 *
 * The `prefix` is what keeps two deployments sharing a Redis instance from
 * hearing each other: pub/sub ignores the DB number (`SUBSCRIBE` is
 * instance-wide), so the `REDIS_*_URL` split isolates every ordinary key but
 * NOT these channels — and what travels on them changes what connected clients
 * may do (#1831).
 *
 * What actually keeps `dev` from hearing `dev-agent` is that a LITERAL `:`
 * follows the prefix, not the fact that the prefix comes first. Verified
 * against a real Redis: `PSUBSCRIBE dev:*` does NOT receive a publish to
 * `dev-agent:project:x:activity:new`, while `PSUBSCRIBE dev*` DOES — the
 * separator is the whole defence. So the rule for any future channel family is:
 * never let a wildcard sit directly against the prefix. (Leading vs trailing is
 * a separate, weaker question — `project:*:dev` is also safe. The prefix leads
 * here for consistency with the Hocuspocus channels, whose `prefix` option
 * always emits `{prefix}:hocuspocus:{doc}`.)
 * @param prefix - Deployment namespace (`REDIS_KEY_PREFIX`, defaults to `ENV`).
 * @returns The pattern `{prefix}:project:*`.
 */
export function allProjectChannelsPattern(prefix: string): string {
  return `${prefix}:project:*`;
}
