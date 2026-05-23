/**
 * Cross-process control-plane events (Redis pub/sub on DB2).
 *
 * Fire-and-forget notifications between API ↔ Collab:
 *
 *   - `members:changed`  — API publishes after a write to
 *                          `project_members`; Collab kicks the
 *                          affected user's ws and broadcasts a
 *                          stateless invalidate signal.
 *   - `space:created`    — API publishes after generating a Space
 *                          id; Collab applies `meta.spaces[id] =
 *                          {...}` so connected frontends see the
 *                          new tab via Yjs sync.
 *   - `space:deleted`    — API publishes after soft-deleting the
 *                          Space's content doc row; Collab removes
 *                          `meta.spaces[id]`.
 *
 * Why pub/sub (not Streams):
 *
 *   - Notification-only: a consumer that's offline can safely miss
 *     a message — its next reconnect re-queries PG / reads Yjs.
 *   - No replay / consumer-group semantics needed. Streams' xadd
 *     overhead would be wasted.
 *
 * Why DB2 (REDIS_STREAM_URL):
 *
 *   - Same Redis connection Hocuspocus uses for cross-instance
 *     sync; reuse the connection instead of spinning a fourth.
 *   - Pub/sub channels are global (not DB-scoped) on the same Redis
 *     instance — DB choice only affects which connection publishes /
 *     listens, not who can hear it. Keeping pubs on DB2 colocates
 *     "doc collaboration" plumbing in one place; auth (DB0) stays
 *     untouched.
 */

import { logger } from "../logger.js";
import { getStreamRedis } from "./redis.js";
import {
  membersChangedChannel,
  spaceCreatedChannel,
  spaceDeletedChannel,
  spaceLockedChannel,
  type MembersChangedEvent,
  type SpaceCreatedEvent,
  type SpaceDeletedEvent,
  type SpaceLockedEvent,
} from "@breatic/shared";

/**
 * Publish a `members:changed` event for a project.
 *
 * Caller (typically `projectMembers.service`) supplies the diff
 * (`affectedUserId`, `action`, optional `newRole` / transfer details).
 * The event timestamp is stamped here.
 *
 * @param projectId - Project UUID
 * @param detail - Per-action detail (without the auto-stamped fields)
 */
export async function publishMembersChanged(
  projectId: string,
  detail: Omit<MembersChangedEvent, "type" | "projectId" | "ts">,
): Promise<void> {
  const event: MembersChangedEvent = {
    type: "project-members:changed",
    projectId,
    ts: Date.now(),
    ...detail,
  };
  const redis = getStreamRedis();
  await redis.publish(membersChangedChannel(projectId), JSON.stringify(event));
  logger.debug(
    { projectId, action: detail.action, affectedUserId: detail.affectedUserId },
    "members_changed_published",
  );
}

/**
 * Publish a `space:created` event for a project.
 *
 * The API caller already validated permission and generated the
 * spaceId. Collab's subscriber turns this into the actual
 * `meta.spaces.set(spaceId, {...})` Y.Map mutation.
 *
 * @deprecated Since 2026-05-23 (ADR breatic-inner-design
 *   engineering/decisions/2026-05-23-yjs-collab-only-write-authz.md).
 *   Space create / delete / lock now run as collab stateless RPC
 *   (see `packages/collab/src/space-rpc.ts`); this Redis pub/sub
 *   path remains for backwards compatibility during the PR-a/PR-b
 *   transition and is scheduled for removal in PR-b.
 *
 * @param projectId - Project UUID
 * @param detail - Spec of the created Space (without auto-stamped fields)
 */
export async function publishSpaceCreated(
  projectId: string,
  detail: Omit<SpaceCreatedEvent, "type" | "projectId" | "ts">,
): Promise<void> {
  const event: SpaceCreatedEvent = {
    type: "project-space:created",
    projectId,
    ts: Date.now(),
    ...detail,
  };
  const redis = getStreamRedis();
  await redis.publish(spaceCreatedChannel(projectId), JSON.stringify(event));
  logger.debug(
    { projectId, spaceId: detail.spaceId, spaceType: detail.spaceType },
    "space_created_published",
  );
}

/**
 * Publish a `space:deleted` event for a project.
 *
 * The API caller has already soft-deleted the corresponding
 * `yjs_documents` row — this event tells Collab to remove the
 * `meta.spaces[spaceId]` Y.Map entry so other clients' tab bars
 * update.
 *
 * @deprecated Since 2026-05-23. See {@link publishSpaceCreated}.
 *
 * @param projectId - Project UUID
 * @param detail - Identifier of the deleted Space + audit
 */
export async function publishSpaceDeleted(
  projectId: string,
  detail: Omit<SpaceDeletedEvent, "type" | "projectId" | "ts">,
): Promise<void> {
  const event: SpaceDeletedEvent = {
    type: "project-space:deleted",
    projectId,
    ts: Date.now(),
    ...detail,
  };
  const redis = getStreamRedis();
  await redis.publish(spaceDeletedChannel(projectId), JSON.stringify(event));
  logger.debug(
    { projectId, spaceId: detail.spaceId },
    "space_deleted_published",
  );
}

/**
 * Publish a `space:locked` event for a project (toggle on / off).
 *
 * The lock is a UX guard against accidental deletion — `meta.spaces[id].locked = true`
 * makes the SpaceDrawer disable the delete action. Anyone with edit
 * role can still mutate the doc itself; this is not a security
 * boundary.
 *
 * @deprecated Since 2026-05-23. See {@link publishSpaceCreated}.
 *
 * @param projectId - Project UUID
 * @param detail - Space id, new lock state, actor (without auto-stamped fields)
 */
export async function publishSpaceLocked(
  projectId: string,
  detail: Omit<SpaceLockedEvent, "type" | "projectId" | "ts">,
): Promise<void> {
  const event: SpaceLockedEvent = {
    type: "project-space:locked",
    projectId,
    ts: Date.now(),
    ...detail,
  };
  const redis = getStreamRedis();
  await redis.publish(spaceLockedChannel(projectId), JSON.stringify(event));
  logger.debug(
    { projectId, spaceId: detail.spaceId, locked: detail.locked },
    "space_locked_published",
  );
}
