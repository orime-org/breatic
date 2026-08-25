// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-process control-plane events (Redis pub/sub on DB2).
 *
 * One fire-and-forget notification path remains:
 *
 *   - `members:changed` — API publishes after a write to
 *                         `project_members`; Collab kicks the
 *                         affected user's ws and broadcasts a
 *                         stateless invalidate signal.
 *
 * Space lifecycle (create / delete / lock / restore) used to live
 * here as `publishSpace*` + `space:*` channels — removed 2026-05-23
 * (ADR 2026-05-23-yjs-collab-only-write-authz). Those writes now run
 * as collab stateless RPC inside `packages/collab/src/space-rpc.ts`
 * (caller: the live Hocuspocus connection on the meta doc), so no
 * Redis round-trip is needed.
 *
 * Why pub/sub (not Streams):
 *
 *   - Notification-only: a consumer that's offline can safely miss
 *     a message — its next reconnect re-queries PG.
 *   - No replay / consumer-group semantics needed.
 *
 * Why DB2 (REDIS_STREAM_URL):
 *
 *   - `members:changed` is a CROSS-SERVICE notification (API publishes,
 *     Collab consumes), so it belongs with the cross-service Streams on
 *     DB2 — NOT with the collab-cluster coordination that moved to
 *     REDIS_COLLAB_URL (DB3: Hocuspocus cross-instance pub/sub + the
 *     space-delete serialization lock).
 *   - Pub/sub channels are global (not DB-scoped) on the same Redis
 *     instance — DB choice only affects which connection publishes /
 *     listens, not who can hear it. Auth (DB0) stays untouched.
 */

import { getStreamRedis } from "@core/infra/redis.js";
import { env } from "@core/config/runtime.js";
import {
  membersChangedChannel,
  activityNewChannel,
  allProjectChannelsPattern,
  type ActivityNewControlEvent,
  type MembersChangedEvent,
} from "@breatic/shared";

/**
 * The subscribe pattern collab must use to receive everything published below.
 *
 * Exists so the deployment namespace is injected in exactly ONE module: the
 * `@breatic/shared` builders take `prefix` as a parameter (that package must
 * stay browser-safe and cannot read env), and this file is the only place that
 * supplies it. A subscriber reaching for the shared builder directly would have
 * to re-derive the prefix and could silently disagree with the publishers —
 * which reads as "collab stopped reacting to membership changes", with no error
 * anywhere.
 * @returns The `PSUBSCRIBE` pattern for this deployment's control channels.
 */
export function projectControlChannelPattern(): string {
  return allProjectChannelsPattern(env.REDIS_KEY_PREFIX);
}

/**
 * Publish a `members:changed` event for a project.
 *
 * Caller (typically `projectMembers.service`) supplies the diff
 * (`affectedUserId`, `action`, optional `newRole` / transfer details).
 * The event timestamp is stamped here.
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
  await redis.publish(membersChangedChannel(env.REDIS_KEY_PREFIX, projectId), JSON.stringify(event));
}

/**
 * Announce a freshly written project_activities row to the collab
 * control plane, which relays it to connected members as the
 * `activity:new` stateless signal (ADR 2026-07-04). Fire-and-forget
 * pub/sub: nobody online means nobody needs the live signal - the
 * feed panel refetches via REST on open.
 * @param projectId - Project the activity row belongs to.
 * @returns Nothing.
 */
export async function publishActivityNew(projectId: string): Promise<void> {
  const event: ActivityNewControlEvent = {
    type: "project-activity:new",
    projectId,
    ts: Date.now(),
  };
  const redis = getStreamRedis();
  await redis.publish(activityNewChannel(env.REDIS_KEY_PREFIX, projectId), JSON.stringify(event));
}
