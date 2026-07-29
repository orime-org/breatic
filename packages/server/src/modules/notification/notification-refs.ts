// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Resolve the ids inside a page of notifications to current display identities.
 *
 * Notifications store ids, never names. A name is a snapshot of something that
 * changes: renaming a studio releases its old slug immediately, and for a
 * personal studio the slug IS the user's `@handle` — so a stored copy can end up
 * naming whoever claimed the handle next, with nothing about the stored string
 * to reveal that it went stale.
 *
 * Resolution happens here, at read time, and is batched by kind: one page costs
 * three queries regardless of how many notifications it holds.
 *
 * A soft-deleted target still resolves, flagged `deleted`. Soft delete is
 * deactivation, not erasure — the same distinction GitHub draws with its ghost
 * user and Slack draws between deactivating an account and deleting its
 * profile. A notification is a record of something that happened, and "someone
 * invited you to something" is not a usable record, so the name stays and only
 * the link is dropped. Real erasure anonymises the ROW; this layer then
 * returns the anonymised value with no special case of its own.
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import type {
  NotificationEntity,
  NotificationListView,
  NotificationRef,
} from "@breatic/shared";

/**
 * Payload keys that hold a user id, a studio id, and a project id.
 *
 * Listed explicitly rather than inferred from a suffix: a rule like "anything
 * ending in UserId" silently adopts every future field, including ones that
 * must NOT be resolved (an actor kept purely for audit, say). Adding a key here
 * is a deliberate act, and the guard script keeps the reverse direction honest
 * by refusing any re-introduction of the old name-shaped keys.
 */
const USER_ID_KEYS = [
  "fromUserId",
  "requesterUserId",
  "deciderUserId",
  "accepterUserId",
  "inviterUserId",
  "inviteeUserId",
] as const;
const STUDIO_ID_KEYS = ["studioId"] as const;
const PROJECT_ID_KEYS = ["projectId"] as const;

/**
 * Collect the string values of the given keys across every payload.
 * @param items - The notifications whose payloads to scan
 * @param keys - Payload keys to read
 * @returns Deduped, non-empty ids
 */
function collectIds(
  items: NotificationEntity[],
  keys: readonly string[],
): string[] {
  const found = new Set<string>();
  for (const item of items) {
    const payload = item.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) found.add(value);
    }
  }
  return [...found];
}

/**
 * Turn a lookup map into the plain object the wire type carries.
 * @param map - Resolved identities keyed by id
 * @returns The same data as a plain record
 */
function toRecord(
  map: Map<string, NotificationRef>,
): Record<string, NotificationRef> {
  return Object.fromEntries(map);
}

/**
 * Build the list view: the notifications plus what their ids resolve to now.
 *
 * The three lookups run concurrently and are each a single query, so the cost
 * is constant per page rather than per notification.
 *
 * A notification also carries `projectId` as a COLUMN (used for filtering), not
 * only inside its payload; both are collected, since either may be the one the
 * frontend links from.
 * @param items - One page of notifications
 * @returns The page plus its resolved identities
 */
export async function withResolvedRefs(
  items: NotificationEntity[],
): Promise<NotificationListView> {
  const userIds = collectIds(items, USER_ID_KEYS);
  const studioIds = collectIds(items, STUDIO_ID_KEYS);
  const projectIds = new Set(collectIds(items, PROJECT_ID_KEYS));
  for (const item of items) {
    if (item.projectId !== null) projectIds.add(item.projectId);
  }

  const [users, studios, projects] = await Promise.all([
    studioRepo.getPersonalProfilesByCreators(userIds),
    studioRepo.getIdentitiesByStudioIds(studioIds),
    projectRepo.getIdentitiesByProjectIds([...projectIds]),
  ]);

  return {
    items,
    resolved: {
      users: toRecord(users),
      studios: toRecord(studios),
      projects: toRecord(projects),
    },
  };
}
