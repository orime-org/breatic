// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Studio page's one poll (#1580): what the page shows that can change without it doing anything, in one answer.
 * The page reads the bell again when its count or newest time moves, the Studio's transfer when the offer changes,
 * and hands each upload's ending to whoever waits for it; the answer also says when to ask again.
 */

import { getStudioPageConfig } from "@breatic/core";
import { studioAuthService, uploadStatusService } from "@breatic/domain";
import type { StudioRole, UploadStatus } from "@breatic/shared";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import * as studioTransfersRepo from "@server/modules/studio/studioTransfers.repo.js";

/** One answer of the poll. */
export interface StudioPagePoll {
  /** The caller's bell: unread count and when the newest notification still there was made. */
  notifications: { unread: number; latestAt: string | null };
  /** The Studio's live transfer, for its admin; null for anyone else or when there is none. */
  transfer: { id: string; status: "pending"; updatedAt: string } | null;
  /** How each asked upload stands, in the order asked. */
  uploads: UploadStatus[];
  /** How long to wait before asking again, in ms. */
  nextPollMs: number;
}

/**
 * Answer one poll of a Studio page.
 * @param userId - The caller.
 * Any signed-in user may open a Studio's page, so only its transfer depends on the caller's role there: a Studio that
 * does not exist, or one the caller is not in, is answered with no transfer, like the Recent page.
 * @param slug - The Studio the page shows, or undefined on the Recent page, which shows no Studio's transfer.
 * @param uploads - The keys of the uploads the page waits for.
 * @returns The answer.
 */
export async function pollStudioPage(userId: string, slug: string | undefined, uploads: readonly string[]): Promise<StudioPagePoll> {
  const studio = slug === undefined ? null : await studioService.getStudioBySlug(slug);
  const role: StudioRole | null = studio === null ? null : await studioAuthService.loadStudioRole(userId, studio.id);
  const [unread, latestAt, live, statuses] = await Promise.all([
    notificationService.countUnread(userId),
    notificationService.latestCreatedAt(userId),
    studio !== null && role === "admin" ? studioTransfersRepo.findLiveForContainer(studio.id) : Promise.resolve(null),
    uploads.length === 0 ? Promise.resolve([]) : uploadStatusService.statusOf(userId, uploads),
  ]);
  return {
    notifications: { unread, latestAt },
    transfer: live === null ? null : { id: live.id, status: "pending", updatedAt: live.updatedAt.toISOString() },
    uploads: statuses,
    nextPollMs: getStudioPageConfig().poll_interval_ms,
  };
}
