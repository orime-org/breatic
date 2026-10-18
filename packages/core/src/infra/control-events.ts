// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-process control-plane events (Redis pub/sub on DB2).
 *
 * Two fire-and-forget notification paths, both per project:
 *
 *   - `activity:new`      — server or worker publishes after writing an
 *                           activity row; every collab instance relays
 *                           it on the meta doc.
 *   - `connections:close` — collab's lifecycle consumer publishes after
 *                           a duplicate / archive / restore; every collab
 *                           instance closes its connections to the
 *                           project so the clients re-authenticate.
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
 *   - Notification-only. A missed `activity:new` is made up by the next
 *     reconnect, which re-queries PG; a missed
 *     `connections:close` leaves that instance's connections on the role
 *     they had until they next reconnect.
 *   - No replay / consumer-group semantics needed.
 *
 * Why DB2 (REDIS_STREAM_URL):
 *
 *   - These are CROSS-SERVICE notifications (server, worker or collab
 *     publish; every collab instance consumes), so they belong with the
 *     cross-service Streams on DB2 — NOT with the collab instances' own
 *     coordination on REDIS_COLLAB_URL (DB3).
 *   - Pub/sub channels are global (not DB-scoped) on the same Redis
 *     instance — DB choice only affects which connection publishes /
 *     listens, not who can hear it. Auth (DB0) stays untouched.
 */

import { getStreamRedis } from "@core/infra/redis.js";
import { env } from "@core/config/runtime.js";
import {
  activityNewChannel,
  creditsChangedChannel,
  projectConnectionsCloseChannel,
  allProjectChannelsPattern,
  type ActivityNewControlEvent,
  type CreditsChangedControlEvent,
  type ProjectConnectionsCloseEvent,
  type ProjectConnectionsCloseReason,
} from "@breatic/shared";

/**
 * The subscribe pattern collab must use to receive everything published below.
 *
 * Exists so the deployment namespace is injected in exactly ONE module: the
 * `@breatic/shared` builders take `prefix` as a parameter (that package must
 * stay browser-safe and cannot read env), and this file is the only place that
 * supplies it. A subscriber reaching for the shared builder directly would have
 * to re-derive the prefix and could silently disagree with the publishers —
 * which reads as "collab stopped closing archived projects", with no error
 * anywhere.
 * @returns The `PSUBSCRIBE` pattern for this deployment's control channels.
 */
export function projectControlChannelPattern(): string {
  return allProjectChannelsPattern(env.REDIS_KEY_PREFIX);
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

/**
 * Announce that a charge on a project's studio committed (inner#1611); collab
 * relays it to connected members as the `credits:changed` stateless signal.
 * Fire-and-forget like {@link publishActivityNew}.
 * @param projectId - Project whose studio was charged.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function publishCreditsChanged(projectId: string): Promise<void> {
  const event: CreditsChangedControlEvent = {
    type: "project-credits:changed",
    projectId,
    ts: Date.now(),
  };
  await getStreamRedis().publish(creditsChangedChannel(env.REDIS_KEY_PREFIX, projectId), JSON.stringify(event));
}

/**
 * Ask every collab instance to close its connections to a project (inner#1497
 * §6.2). Each instance holds some of the project's connections, so the
 * instance that handled the lifecycle command cannot close them all itself.
 * @param projectId - Project whose connections are closed.
 * @param reason - Why; picks the close frame the client re-authenticates on.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function publishProjectConnectionsClose(
  projectId: string,
  reason: ProjectConnectionsCloseReason,
): Promise<void> {
  const event: ProjectConnectionsCloseEvent = {
    type: "project-connections:close",
    projectId,
    reason,
    ts: Date.now(),
  };
  const redis = getStreamRedis();
  await redis.publish(projectConnectionsCloseChannel(env.REDIS_KEY_PREFIX, projectId), JSON.stringify(event));
}
