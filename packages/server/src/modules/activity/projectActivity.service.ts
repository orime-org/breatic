// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Server-side helpers for the project activity feed (ADR 2026-07-04
 * project-activity-feed).
 *
 * Writing goes through {@link recordProjectActivity}: append the PG row
 * via the core repo, then announce it on the control plane so collab
 * relays the live `activity:new` signal to connected members.
 * Best-effort by design - the business mutation the activity describes
 * has already committed, so a failed audit row logs instead of
 * propagating.
 *
 * Reading goes through {@link listProjectActivities}: keyset pagination
 * over (created_at DESC, id DESC) with an opaque cursor.
 */

import {
  createLogger,
  projectActivitiesRepo,
  publishActivityNew,
  encodeActivityCursor,
  decodeActivityCursor,
  type NewProjectActivity,
} from "@breatic/core";
import type { ProjectActivityPage } from "@breatic/shared";
import { getActivityFeedPageLimits } from "@server/config/limits.js";

const logger = createLogger("project-activity");

/**
 * Append one activity row + announce it to the collab control plane.
 * Never throws: the described mutation is already committed, so an
 * audit failure is logged for repair instead of failing the caller.
 * @param activity - The activity row to append.
 * @returns Nothing.
 */
export async function recordProjectActivity(
  activity: NewProjectActivity,
): Promise<void> {
  try {
    await projectActivitiesRepo.insert(activity);
    await publishActivityNew(activity.projectId);
  } catch (err) {
    logger.error(
      { err, projectId: activity.projectId, activityType: activity.type },
      "activity_record_failed",
    );
  }
}

/**
 * One keyset page of a project's activity feed, newest first.
 * @param projectId - Project whose feed to read.
 * @param rawCursor - Opaque cursor from the previous page, if any.
 * @param rawLimit - Requested page size; clamped to [1, 100], default 50.
 * @returns The page items + the next opaque cursor (null at the end).
 */
export async function listProjectActivities(
  projectId: string,
  rawCursor: string | undefined,
  rawLimit: number | undefined,
): Promise<ProjectActivityPage> {
  const pageLimits = getActivityFeedPageLimits();
  const limit = Math.min(
    Math.max(rawLimit ?? pageLimits.default, 1),
    pageLimits.max,
  );
  // Malformed cursors decode to null = first page (they arrive from
  // the network; a garbage cursor must not 500 the feed).
  const cursor = rawCursor ? decodeActivityCursor(rawCursor) : null;
  const items = await projectActivitiesRepo.listByProject(
    projectId,
    cursor,
    limit,
  );
  const last = items[items.length - 1];
  // A short page means the feed is exhausted; a full page may have more.
  const nextCursor =
    items.length === limit && last
      ? encodeActivityCursor(new Date(last.createdAt), last.id)
      : null;
  return { items, nextCursor };
}
