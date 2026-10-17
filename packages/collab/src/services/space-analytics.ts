// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Space events from collab (inner#1442 design §4.8). Collab sees no cookie
 * per message: a Space RPC carries the sender's consent in its envelope, and
 * the automatic first Space follows the handshake of whoever opened the
 * project, both put in scope with `runWithConsent` by the caller.
 */

import {
  logger,
  projectsRepo,
  reportCollaboratorFirstAction,
  serverAnalyticsWanted,
  trackServerEvent,
} from "@breatic/core";
import type { ProjectActivityType } from "@breatic/shared";

/**
 * Send `space_created`.
 * @param space - The new Space.
 * @param space.projectId - Its project.
 * @param space.spaceId - Its id, the dedupe key.
 * @param space.spaceType - What kind of Space it is.
 * @param space.userId - Who created it, or who opened the project for an automatic one.
 * @param space.via - `manual` from the Space menu, `seed` for the project's first Space.
 */
export async function reportSpaceCreated(space: {
  projectId: string;
  spaceId: string;
  spaceType: string;
  userId: string;
  via: "manual" | "seed";
}): Promise<void> {
  if (!serverAnalyticsWanted()) return;
  try {
    const studioId = await projectsRepo.findOwnerStudioId(space.projectId);
    trackServerEvent("space_created", {
      userId: space.userId,
      insertId: `space:${space.spaceId}`,
      properties: {
        studio_id: studioId,
        project_id: space.projectId,
        space_type: space.spaceType,
        via: space.via,
      },
    });
  } catch (err) {
    logger.warn({ err, projectId: space.projectId, spaceId: space.spaceId }, "space_created_report_failed");
  }
}

/**
 * Report a Space change as a collaboration action, when a person made it.
 * @param projectId - The project.
 * @param actorUserId - Who made it; null for a change the system made.
 * @param type - The activity written.
 */
export async function reportSpaceAction(
  projectId: string,
  actorUserId: string | null | undefined,
  type: ProjectActivityType,
): Promise<void> {
  if (!actorUserId || !type.startsWith("space:")) return;
  await reportCollaboratorFirstAction({ projectId, userId: actorUserId, action: "space" });
}
