// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The reads a region serves the global region for one user's cross-region
 * lists (inner#1955), beside domain's `REGION_FUNCTIONS`.
 */

import type { NotificationListView, RecentItem, SignupInvitationPreview } from "@breatic/shared";
import { profilesService, studioRepo } from "@breatic/domain";
import { getRedis, NotFoundError, publishSessionsRevoked, recordRevokedIdentities } from "@breatic/core";
import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import { projectNamesHere } from "@server/modules/region/project-names.js";
import { getInvitationPreview } from "@server/modules/invitation/invitation.service.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { withResolvedRefs } from "@server/modules/notification/notification-refs.js";
import * as recentService from "@server/modules/recent/recent.service.js";

/** The server's region functions. */
export const SERVER_REGION_FUNCTIONS = {
  /**
   * The Projects in this region the user opened, newest first.
   * @param userId - The user.
   * @returns Them.
   */
  listRecent: (userId: string): Promise<RecentItem[]> => recentService.listRecent(userId),
  /**
   * The user's notifications in this region, with the names they show.
   * @param userId - The user.
   * @param unreadOnly - Only the unread ones.
   * @returns The list and its resolved names.
   */
  listNotifications: async (userId: string, unreadOnly: boolean): Promise<NotificationListView> =>
    withResolvedRefs(unreadOnly ? await notificationService.listUnread(userId) : await notificationService.listAll(userId)),
  /**
   * How many of the user's notifications in this region are unread.
   * @param userId - The user.
   * @returns The count.
   */
  countUnread: (userId: string): Promise<number> => notificationService.countUnread(userId),
  /**
   * The preview of an invitation this region issued.
   * @param token - The invitation token.
   * @returns The preview.
   */
  previewInvitation: (token: string): Promise<SignupInvitationPreview> => getInvitationPreview(token),
  /**
   * The slug a Studio in this region holds, for settling a slug reservation.
   * @param studioId - The Studio.
   * @returns Its slug, or null when it is gone.
   */
  studioSlug: async (studioId: string): Promise<string | null> => (await studioRepo.getById(studioId))?.slug ?? null,
  /**
   * Mark one of the user's notifications in this region read.
   * @param id - The notification.
   * @param userId - Its owner.
   * @returns Whether it was marked.
   */
  markNotificationRead: async (id: string, userId: string): Promise<boolean> => {
    try {
      await notificationService.markRead(id, userId);
      return true;
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  },
  /**
   * Mark the user's unread news in this region read.
   * @param userId - The user.
   * @returns How many were marked.
   */
  markAllNotificationsRead: (userId: string): Promise<number> => notificationService.markAllRead(userId),
  /**
   * The names of this region's Projects, for the global region's pages.
   * @param projectIds - The Projects.
   * @returns Name by id, for the ones found.
   */
  projectNames: (projectIds: string[]): Promise<Record<string, string>> => projectNamesHere(projectIds),
  /**
   * End sessions the global region revoked: mark them revoked for this
   * region's identity checks and tell this region's collab to close them.
   * @param userId - Whose sessions ended.
   * @param sids - The ended session ids.
   * @returns Once marked and announced.
   */
  revokeSessions: async (userId: string, sids: string[]): Promise<void> => {
    await recordRevokedIdentities(getRedis(), sids);
    await publishSessionsRevoked(userId, sids);
  },
  /**
   * Claim this region's email invitations for an account that signed in.
   * @param userId - The account.
   * @returns Once claimed.
   */
  claimEmailInvitations: async (userId: string): Promise<void> => {
    const account = (await profilesService.accountsOf([userId])).get(userId);
    if (account !== undefined) await claimEmailInvitations(account);
  },
};
