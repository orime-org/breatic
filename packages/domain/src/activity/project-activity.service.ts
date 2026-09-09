// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Appending to a project's activity feed (ADR 2026-07-04
 * project-activity-feed).
 *
 * It lives here because asset registration writes a feed row of its own, and
 * registration runs in both our server and our worker (#206, design §3.4.2).
 * The row has to be written before the grant is consumed — that is the commit
 * point of the whole registration, and anything after it is not repeated when
 * a delivery arrives twice — so this cannot be something the caller does with
 * what the registration handed back.
 *
 * Best-effort by design: the mutation this describes has already committed, so
 * a failed feed row is reported rather than propagated. Reporting it as a
 * value is what lets the caller write the log line, since a library here holds
 * no logger of its own.
 */

import {
  projectActivitiesRepo,
  publishActivityNew,
  type NewProjectActivity,
} from "@breatic/core";

/** Whether a feed row was written, and what stopped it. */
export type ActivityAppend = { ok: true } | { ok: false; err: unknown };

/**
 * Append one activity row and announce it to the collab control plane.
 *
 * Never throws.
 * @param activity - The activity row to append.
 * @returns Whether it landed, carrying the failure when it did not.
 */
export async function appendProjectActivity(
  activity: NewProjectActivity,
): Promise<ActivityAppend> {
  try {
    await projectActivitiesRepo.insert(activity);
    await publishActivityNew(activity.projectId);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}
