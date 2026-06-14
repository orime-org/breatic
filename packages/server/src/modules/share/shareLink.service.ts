// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Share link service — create / list / consume / revoke.
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 3.
 *
 * Authorization model (route layer enforces gates):
 *   - createLink / listByProject / revokeLink: owner gate
 *   - consumeLink: any authenticated caller (token presence = intent;
 *     kind='email' + boundEmail mismatch raises Forbidden)
 *
 * Two link variants discriminated by an explicit `kind` column:
 *   - kind = 'email': single-use, bound to that specific email
 *     address, expires in 7 days. Only the user whose email matches
 *     can consume. `markConsumed` flips consumed_at.
 *   - kind = 'link':  multi-use, no expiry, anyone with the URL can
 *     join until owner revokes. `markConsumed` is NOT called.
 *
 * The DB CHECK constraint keeps `kind` and `boundEmail` in sync
 * (kind='email' ⇔ boundEmail IS NOT NULL); application code branches
 * on `kind`, not on `boundEmail` nullness — one column shouldn't
 * carry both data and type.
 *
 * Email notifications are dispatched by the route layer (mailer
 * lives in application boundary per CLAUDE.md mandate).
 *
 * Token generation: 32-byte random base64url (~43 chars after
 * encoding) — collision probability under 2^-128 even with millions
 * of links. Caller supplies the token via `generateToken()` so the
 * service can stay pure; collision retry is the caller's job (rare).
 */

import { randomBytes } from "node:crypto";
import * as shareLinkRepo from "@server/modules/share/shareLink.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  db,
  projectMembersRepo,
} from "@breatic/core";
import { t } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";
import type { ShareLink, ShareLinkKind } from "@server/modules/share/shareLink.repo.js";

export type { ShareLinkKind };

/** Roles a share link can grant — `owner` is never grantable. */
export type GrantableRole = Exclude<ProjectRole, "owner">;

/**
 * Type guard: narrow an arbitrary role string to a grantable role
 * (`owner` is never grantable via a share link).
 * @param role - Role string to check
 * @returns True if `role` is 'editor' or 'viewer'
 */
function isGrantableRole(role: string): role is GrantableRole {
  return role === "editor" || role === "viewer";
}

/**
 * Generate a base64url-encoded 32-byte token (~43 chars).
 * URL-safe — no padding, no '+' or '/'.
 * @returns A cryptographically random, URL-safe share link token
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Default email-invite link lifetime (7 days from creation). */
const EMAIL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Create a new share link. The token is generated server-side so
 * the caller never decides their own.
 *
 * `kind` is the single source of truth for the mode:
 *   - kind='email' MUST be paired with a non-empty `boundEmail`
 *     (recipient address). The link expires in 7 days.
 *   - kind='link' MUST be passed with no `boundEmail` (or null).
 *     The link is multi-use with no expiry.
 * @param input - Share link creation parameters
 * @param input.projectId - Project the link grants access to
 * @param input.createdByUserId - User creating the link
 * @param input.role - Role granted on consume ('editor' or 'viewer')
 * @param input.kind - Link mode ('email' single-use, or 'link' multi-use)
 * @param input.boundEmail - Recipient email; required for 'email', must be absent for 'link'
 * @returns The created share link (with the server-generated token)
 * @throws {ValidationError} if `role` is not 'editor' / 'viewer',
 *   or if `kind` and `boundEmail` are mismatched
 * @throws {ConflictError} if the token randomly collides
 *   (astronomically rare; caller should retry once)
 */
export async function createLink(input: {
  projectId: string;
  createdByUserId: string;
  role: string;
  kind: ShareLinkKind;
  boundEmail?: string | null;
}): Promise<ShareLink> {
  if (!isGrantableRole(input.role)) {
    throw new ValidationError(t("server.error.validation"));
  }
  if (input.kind !== "email" && input.kind !== "link") {
    throw new ValidationError(t("server.error.validation"));
  }
  const boundEmail = input.boundEmail ?? null;
  if (input.kind === "email" && boundEmail === null) {
    throw new ValidationError(t("server.error.validation"));
  }
  if (input.kind === "link" && boundEmail !== null) {
    throw new ValidationError(t("server.error.validation"));
  }
  const expiresAt =
    input.kind === "email" ? new Date(Date.now() + EMAIL_INVITE_TTL_MS) : null;
  const token = generateToken();
  try {
    return await shareLinkRepo.create({
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      token,
      role: input.role,
      kind: input.kind,
      boundEmail,
      expiresAt,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.error.conflict"));
    }
    throw err;
  }
}

/**
 * List active links for a project. Route enforces owner/admin gate.
 * @param projectId - Project UUID
 * @returns The project's active share links, newest first
 */
export async function listByProject(projectId: string): Promise<ShareLink[]> {
  return shareLinkRepo.listByProject(projectId);
}

/**
 * Revoke a share link (soft-delete).
 * @param linkId - Share link UUID to revoke
 * @throws {NotFoundError} if the link doesn't exist or is
 *   already revoked
 */
export async function revokeLink(linkId: string): Promise<void> {
  const ok = await shareLinkRepo.softDelete(linkId);
  if (!ok) {
    throw new NotFoundError(t("server.error.notFound"));
  }
}

/**
 * Consume a share link — enroll the caller as a project member.
 *
 * This is the auth critical path where a non-member becomes a member.
 * The membership write, the single-use CAS (email kind), and the
 * owner's `member_joined` notification all run in ONE transaction so a
 * consumed link always corresponds to an active `project_members` row
 * (no "link spent but no membership" split-brain). Returns the resolved
 * link so the caller (route) knows the project + role to navigate to.
 *
 * Idempotence & no-downgrade: if the caller already holds ANY active
 * role on the project (owner / editor / viewer), the membership is left
 * untouched and no `member_joined` notification fires — re-consuming a
 * multi-use link, or the owner clicking their own link, never resets a
 * role nor re-notifies. For an email-invite link the token is STILL
 * spent (single-use semantics) even when the caller is already a member.
 *
 * kind='email': single-use; consume sets consumed_at; bound email
 * mismatch raises Forbidden; expired raises Forbidden; already-spent
 * raises Forbidden (no membership write in that case).
 * kind='link':  multi-use; consume never mutates consumed_at.
 * @param token — the link token from the URL
 * @param consumerUserId — the authenticated caller's user id; becomes a
 *   project member at `link.role` unless they already have a role
 * @param callerEmail — the authenticated user's email; used only
 *   for the boundEmail check on kind='email' links
 * @returns The resolved share link (with `consumedAt` set for a freshly
 *   consumed email-invite link; unchanged for a multi-use 'link')
 * @throws {NotFoundError} if the token doesn't exist or the
 *   link has been revoked
 * @throws {ForbiddenError} if the link is expired, the email
 *   doesn't match the bound recipient, or the single-use link was
 *   already consumed (including a concurrent-consume race)
 * @throws {ValidationError} if the link carries a non-grantable role
 *   ('owner') — a corrupt row that should never exist (createLink
 *   rejects it), guarded defensively before any membership write
 */
export async function consumeLink(
  token: string,
  consumerUserId: string,
  callerEmail: string,
): Promise<ShareLink> {
  const link = await shareLinkRepo.findActiveByToken(token);
  if (!link) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  if (link.expiresAt !== null && link.expiresAt.getTime() <= Date.now()) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (!isGrantableRole(link.role)) {
    // Defensive: createLink rejects 'owner', so an active link should
    // never carry it. Refuse rather than feed it to upsertMember.
    throw new ValidationError(t("server.error.validation"));
  }
  const role = link.role;

  if (link.kind === "email") {
    // Email-invite: must match the bound recipient and not be spent.
    if (link.boundEmail !== callerEmail) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    if (link.consumedAt !== null) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }
  }

  // Already a member? Leave the membership untouched (no downgrade, no
  // re-notify). For an email link the token is still spent below.
  const existingRole = await projectMembersRepo.getRole(
    link.projectId,
    consumerUserId,
  );

  return db.transaction(async (tx) => {
    if (link.kind === "email") {
      const claimed = await shareLinkRepo.markConsumed(link.id, tx);
      if (!claimed) {
        // Concurrent consume raced — another caller spent the token.
        throw new ForbiddenError(t("server.error.forbidden"));
      }
    }

    if (existingRole === null) {
      // Not a member yet → enroll at the link's role and notify the
      // project owner. `addedBy` is the link creator (the inviter).
      await projectMembersRepo.upsertMember(
        link.projectId,
        consumerUserId,
        role,
        link.createdByUserId,
        tx,
      );
      const ownerUserId = await projectMembersRepo.getOwner(link.projectId);
      if (ownerUserId !== null && ownerUserId !== consumerUserId) {
        const project = await projectRepo.getProjectById(link.projectId);
        await notificationService.createMemberJoined({
          ownerUserId,
          projectId: link.projectId,
          payload: {
            newMemberUserId: consumerUserId,
            projectName: project?.name ?? "",
            role,
          },
          tx,
        });
      }
    }

    return link.kind === "email" ? { ...link, consumedAt: new Date() } : link;
  });
}
