// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What came due between two instants, told to the pages that show it (#1580). Notifications and credit holds that
 * expire, Project transfers that time out, 3D rows past their budget and focus crops whose upload never ended change
 * nothing in the database on their own; one round finds each and says so on the same channel as the table triggers,
 * or through the Space's document for a 3D row and a focus crop. Telling twice is harmless: a page only reads again,
 * and a crop already ended is not in its node's uploading list.
 */

import {
  announceSpaceTasksVersion,
  getNodeTaskConfig,
  publishNotificationsChanged,
  publishStudioCreditsChanged,
} from "@breatic/core";
import { announceFocusImageFailed, focusImageTargetOf } from "@domain/asset/focus-image-events.js";
import * as uploadGrantRepo from "@domain/asset/upload-grant.repo.js";
import { threeDSpaceDocName } from "@breatic/shared";
import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import * as nodeTaskRepo from "@domain/node-task/node-task.repo.js";
import * as notificationRepo from "@domain/notification/notification.repo.js";
import { expireDueTransfers } from "@domain/project/transfer-expiry.service.js";

/**
 * Run one round over `(from, now]`.
 * @param window - The round's window.
 * @param window.from - Where the last round that finished stopped (open lower end).
 * @param window.now - This round's instant (closed upper end).
 * @returns Nothing once everything due was told.
 * @throws {Error} When a read, a write or a notify fails; the next round covers the same window again.
 */
export async function sweepDue(window: { from: Date; now: Date }): Promise<void> {
  const { from, now } = window;
  for (const userId of await notificationRepo.listRecipientsDueBetween(from, now)) {
    await publishNotificationsChanged(userId);
  }
  for (const studioId of await creditHoldRepo.listStudiosWithHoldsDueBetween(from, now)) {
    await publishStudioCreditsChanged(studioId);
  }
  // Judged by state, not by the window: a pending offer past its deadline ends whenever a round sees it.
  await expireDueTransfers({ now });
  for (const place of await nodeTaskRepo.listScenesDueBetween(from, now)) {
    await announceSpaceTasksVersion(threeDSpaceDocName(place.projectId, place.spaceId));
  }
  // A crop whose bytes never finished ends at its two hours, as a node's upload row does.
  for (const grant of await uploadGrantRepo.listOpenFocusGrantsDueBetween(from, now, getNodeTaskConfig().default_budget_ms)) {
    const target = focusImageTargetOf(grant);
    if (target !== null) await announceFocusImageFailed(target);
  }
}
