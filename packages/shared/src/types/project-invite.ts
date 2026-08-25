// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project invitation types (invite-confirm handshake, 2026-06-18, #1337).
 *
 * The direct mirror of the studio invitation types for the project membership
 * layer. A project invite no longer takes effect immediately: the owner creates
 * a `pending` row, the invitee confirms via the bell notification or an email
 * link, and only then becomes a `project_members` row. The granted role is
 * `editor` | `viewer` only — `owner` is never invited.
 */

/** The role an invite may grant — never `owner`. */
export type InvitableProjectRole = "editor" | "viewer";

/**
 * Project invitation lifecycle status (mirror of the studio invite lifecycle).
 */
export type ProjectInvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "revoked";

/**
 * Pending project-invitation summary — one in-flight invite as returned by the
 * project's pending-invitations list for the Members / Share surface. Surfaced
 * to the owner so they can see who is "invited (pending)" and revoke it. Mirrors
 * `PendingInvitationSummary` in the studio types, which is prose rather than
 * a link because that type is not imported here and the jump would not work;
 * `expiresAt` drives the countdown.
 */
export interface PendingProjectInvitationSummary {
  invitationId: string;
  invitedUserId: string;
  /** The invitee's display name (their personal-studio name; email fallback). */
  name: string;
  email: string;
  avatarUrl: string | null;
  role: InvitableProjectRole;
  /** The inviting owner's display name. */
  invitedByName: string;
  /** ISO-8601 expiry timestamp (`project_invitations.expiresAt`). */
  expiresAt: string;
}

