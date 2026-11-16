// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The functions a region serves the global region (inner#1955), beside
 * domain's `REGION_FUNCTIONS`: reads for one user's cross-region lists, the
 * back office's storage-reclaim calls, notification read marks, session
 * revocation, forwarded invitation claims, slug-reservation state and paste
 * key lookups.
 */

import type { NotificationListView, RecentItem, SignupInvitationPreview } from "@breatic/shared";
import { directoryWrites, lookupKeysHere, profilesService, type KeyLookupAnswer } from "@breatic/domain";
import { getRedis, NotFoundError, publishSessionsRevoked, recordRevokedIdentities } from "@breatic/core";
import { claimForwardedEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import * as maintenanceService from "@server/modules/maintenance/maintenance.service.js";
import { projectNamesHere } from "@server/modules/region/project-names.js";
import { getInvitationPreview } from "@server/modules/invitation/invitation.service.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { withResolvedRefs } from "@server/modules/notification/notification-refs.js";
import * as recentService from "@server/modules/recent/recent.service.js";

/** The server's region functions. */
export const SERVER_REGION_FUNCTIONS = {
  /**
   * This region's storage-reclaim queue, for the back office through the global region.
   * @returns The answer the maintenance route sends.
   */
  maintenanceQueue: (): Promise<maintenanceService.MaintenanceAnswer<unknown>> => maintenanceService.queue(),
  /**
   * A page of this region's reclaim candidates.
   * @param pageSize - How many.
   * @param cursor - The previous page's last id.
   * @returns The answer the maintenance route sends.
   */
  maintenanceCandidates: (pageSize: number, cursor?: string): Promise<maintenanceService.MaintenanceAnswer<unknown>> =>
    maintenanceService.candidates(pageSize, cursor ?? undefined),
  /**
   * Preview a reclaim of these rows in this region.
   * @param ids - The rows.
   * @param requestedBy - The back-office admin.
   * @returns The answer the maintenance route sends.
   */
  maintenancePreview: (ids: string[], requestedBy: string): Promise<maintenanceService.MaintenanceAnswer<unknown>> =>
    maintenanceService.preview(ids, requestedBy),
  /**
   * Submit a previewed reclaim in this region.
   * @param submission - The submission.
   * @returns The answer the maintenance route sends.
   */
  maintenanceSubmit: (submission: maintenanceService.MaintenanceSubmission): Promise<maintenanceService.MaintenanceAnswer<unknown>> =>
    maintenanceService.submit(submission),
  /**
   * One reclaim operation in this region, with a page of its runs.
   * @param key - The operation.
   * @param runsPageSize - How many runs.
   * @param runsCursor - The previous page's last run.
   * @returns The answer the maintenance route sends.
   */
  maintenanceOperation: (key: string, runsPageSize: number, runsCursor?: string): Promise<maintenanceService.MaintenanceAnswer<unknown>> =>
    maintenanceService.operation(key, runsPageSize, runsCursor ?? undefined),
  /**
   * Pause or resume a reclaim operation in this region.
   * @param request - The control request.
   * @returns The answer the maintenance route sends.
   */
  maintenanceControl: (request: maintenanceService.MaintenanceControlRequest): Promise<maintenanceService.MaintenanceAnswer<unknown>> =>
    maintenanceService.control(request),
  /**
   * The result of a control request in this region.
   * @param key - The control request.
   * @returns The answer the maintenance route sends.
   */
  maintenanceControlResult: (key: string): Promise<maintenanceService.MaintenanceAnswer<unknown>> => maintenanceService.controlResult(key),
  /**
   * What this region's ledger holds under a paste's storage keys, for a paste in the global region.
   * @param keys - The keys.
   * @returns Each key's live row and cover row.
   */
  findAssetsByKeys: (keys: string[]): Promise<Record<string, KeyLookupAnswer>> => lookupKeysHere(keys),
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
   * The slug a Studio in this region holds and whether its events are still on
   * their way, for settling a slug reservation.
   * @param studioId - The Studio.
   * @returns Its slug state.
   */
  studioSlugState: (studioId: string): Promise<directoryWrites.SlugState> => directoryWrites.slugState(studioId),
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
   * @throws {GlobalApiError} When the global region was unavailable, so the forwarding job retries.
   */
  claimEmailInvitations: async (userId: string): Promise<void> => {
    const account = (await profilesService.accountsOf([userId])).get(userId);
    if (account !== undefined) await claimForwardedEmailInvitations(account);
  },
};
