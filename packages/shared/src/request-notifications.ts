// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Notification types that stand for a request somebody still has to answer —
 * the two invites, the two transfers, the role upgrade, the join request.
 *
 * The bell lists unread rows only, so marking one of these read would take the
 * request out of the bell with nobody having answered it. The bell therefore
 * gives them an answer button instead of mark-read, and "mark all read" leaves
 * them alone; both read this one list.
 */
export const REQUEST_NOTIFICATION_TYPES = [
  "access.role_upgrade_request",
  "project.join_request",
  "studio.transfer_request",
  "project.transfer_request",
  "studio.invite_request",
  "project.invite_request",
] as const;

const REQUEST_TYPES: ReadonlySet<string> = new Set(REQUEST_NOTIFICATION_TYPES);

/**
 * Whether a notification type stands for a request still waiting on an answer.
 * @param type - The notification's type.
 * @returns True for one of {@link REQUEST_NOTIFICATION_TYPES}.
 */
export function isRequestNotification(type: string): boolean {
  return REQUEST_TYPES.has(type);
}
