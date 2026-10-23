// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The two membership targets that share email invitation semantics. */
export type InvitationKind = "project" | "studio";

/** Membership roles that an invitation may grant. */
export type InvitationRole = "editor" | "viewer" | "maintainer" | "guest";

/** Invitation facts read by the shared recipient arbitration flow. */
export interface RecipientInvitation {
  id: string;
  targetId: string;
  invitedUserId: string | null;
  invitedEmail: string | null;
  invitedBy: string;
  role: string;
  status: string;
  notificationId: string | null;
  shareToken: string;
  expiresAt: Date;
  deletedAt: Date | null;
}

/** Identifies an email invitation that a verified account may claim. */
export interface EmailInvitationCandidate {
  id: string;
  targetId: string;
}
