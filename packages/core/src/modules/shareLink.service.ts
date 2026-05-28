/**
 * Share link service — create / list / consume / revoke.
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 3.
 *
 * Authorization model (route layer enforces gates):
 *   - createLink / listByProject / revokeLink: owner gate
 *   - consumeLink: any authenticated caller (token presence = intent;
 *     boundEmail mismatch raises Forbidden)
 *
 * Two link variants discriminated by `boundEmail`:
 *   - Email-invite (boundEmail NOT NULL): single-use, bound to that
 *     specific email address, expires in 7 days. Only the user whose
 *     email matches can consume. `markConsumed` flips consumed_at.
 *   - Generate (boundEmail NULL): multi-use, no expiry, anyone with
 *     the URL can join until owner revokes. `markConsumed` is NOT
 *     called.
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
import * as shareLinkRepo from "./shareLink.repo.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { t } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";
import type { ShareLink } from "./shareLink.repo.js";

/** Roles a share link can grant — `owner` is never grantable. */
export type GrantableRole = Exclude<ProjectRole, "owner">;

function isGrantableRole(role: string): role is GrantableRole {
  return role === "edit" || role === "view";
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

/**
 * Generate a base64url-encoded 32-byte token (~43 chars).
 * URL-safe — no padding, no '+' or '/'.
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
 * Pass `boundEmail` to create an email-invite (single-use, expires
 * in 7 days). Omit it to create a Generate link (multi-use, no expiry).
 *
 * @throws {@link ValidationError} if `role` is not 'edit' or 'view'
 * @throws {@link ConflictError} if the token randomly collides
 *   (astronomically rare; caller should retry once)
 */
export async function createLink(input: {
  projectId: string;
  createdByUserId: string;
  role: string;
  boundEmail?: string | null;
}): Promise<ShareLink> {
  if (!isGrantableRole(input.role)) {
    throw new ValidationError(t("server.error.validation"));
  }
  const boundEmail = input.boundEmail ?? null;
  const expiresAt =
    boundEmail !== null ? new Date(Date.now() + EMAIL_INVITE_TTL_MS) : null;
  const token = generateToken();
  try {
    return await shareLinkRepo.create({
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      token,
      role: input.role,
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

/** List active links for a project. Route enforces owner/admin gate. */
export async function listByProject(projectId: string): Promise<ShareLink[]> {
  return shareLinkRepo.listByProject(projectId);
}

/**
 * Revoke a share link (soft-delete).
 *
 * @throws {@link NotFoundError} if the link doesn't exist or is
 *   already revoked
 */
export async function revokeLink(linkId: string): Promise<void> {
  const ok = await shareLinkRepo.softDelete(linkId);
  if (!ok) {
    throw new NotFoundError(t("server.error.notFound"));
  }
}

/**
 * Consume a share link.
 *
 * Returns the resolved link so the caller (route) decides what to
 * do next:
 *   - if caller is already a member: no-op, return the link
 *   - if caller is not a member: route enrolls them at `link.role`
 *     and (for email-invite links) the link is now spent
 *
 * Email-invite (boundEmail NOT NULL): single-use; consume sets
 * consumed_at; bound email mismatch raises Forbidden; expired raises
 * Forbidden.
 * Generate (boundEmail NULL): multi-use; consume returns the link
 * without mutation.
 *
 * @param token — the link token from the URL
 * @param callerEmail — the authenticated user's email; used only
 *   for boundEmail check on email-invite links
 *
 * @throws {@link NotFoundError} if the token doesn't exist or the
 *   link has been revoked
 * @throws {@link ForbiddenError} if the link is expired, the email
 *   doesn't match the bound recipient, or the single-use link was
 *   already consumed
 */
export async function consumeLink(
  token: string,
  callerEmail: string,
): Promise<ShareLink> {
  const link = await shareLinkRepo.findActiveByToken(token);
  if (!link) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  if (link.expiresAt !== null && link.expiresAt.getTime() <= Date.now()) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (link.boundEmail !== null) {
    // Email-invite: must match the bound recipient.
    if (link.boundEmail !== callerEmail) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    if (link.consumedAt !== null) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    const claimed = await shareLinkRepo.markConsumed(link.id);
    if (!claimed) {
      // Concurrent consume raced — another caller spent the token.
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    return { ...link, consumedAt: new Date() };
  }
  // Generate link — multi-use, no consumed_at mutation.
  return link;
}
