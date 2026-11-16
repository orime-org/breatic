// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pending-invitation lists of the Studio Members tab and the Project
 * share panel. The rows are this region's; who the invitee and the inviter
 * are comes from the global profiles (inner#1955).
 */

import { profilesService } from "@breatic/domain";

/** A live pending invitation as its repository reads it. */
export interface PendingInvitationRow<R extends string> {
  invitationId: string;
  /** Null while the invitation waits for its address to sign up. */
  invitedUserId: string | null;
  invitedEmail: string | null;
  invitedBy: string;
  role: R;
  expiresAt: Date;
}

/** A pending invitation as the lists show it. */
export interface PendingInvitationDisplay<R extends string> {
  invitationId: string;
  invitedUserId: string | null;
  awaitingSignup: boolean;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: R;
  invitedByName: string;
  expiresAt: string;
}

/**
 * Give pending invitations their invitee's and inviter's display fields: the
 * invitee's personal Studio name and avatar (the address while they have
 * none), their account's address or the invited address, and the inviter's
 * name.
 * @param rows - The invitations, in the order to show them.
 * @returns The same invitations with display fields.
 * @throws {GlobalApiError} When the global region does not answer.
 */
export async function withPendingDisplay<R extends string>(
  rows: readonly PendingInvitationRow<R>[],
): Promise<PendingInvitationDisplay<R>[]> {
  const profiles = await profilesService.profilesOf(
    rows.flatMap((row) => (row.invitedUserId === null ? [row.invitedBy] : [row.invitedUserId, row.invitedBy])),
  );
  return rows.map((row) => {
    const invitee = row.invitedUserId === null ? undefined : profiles.get(row.invitedUserId);
    const inviter = profiles.get(row.invitedBy);
    const shown = invitee !== undefined && invitee.name !== null && !invitee.deleted;
    const email = invitee?.email ?? row.invitedEmail ?? "";
    return {
      invitationId: row.invitationId,
      invitedUserId: row.invitedUserId,
      awaitingSignup: row.invitedUserId === null,
      name: shown ? invitee.name! : email,
      email,
      avatarUrl: shown ? invitee.avatarUrl : null,
      role: row.role,
      invitedByName: inviter !== undefined && inviter.name !== null && !inviter.deleted ? inviter.name : "",
      expiresAt: row.expiresAt.toISOString(),
    };
  });
}
