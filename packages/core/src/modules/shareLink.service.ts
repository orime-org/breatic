/**
 * Share link service — create / list / consume / revoke.
 *
 * Spec: engineering/specs/2026-05-26-deprecate-noaccount-email-auth-spec.md
 * (PR-d scope — share dialog wiring + 3 invite paths).
 *
 * Authorization model (route layer enforces gates):
 *   - createLink / listByProject / revokeLink: owner/admin gate
 *   - consumeLink: any authenticated caller (token presence = intent)
 *
 * Two link modes:
 *   - `isPermanent = false` (single-use): consume sets consumed_at;
 *     subsequent consumes are rejected as Gone.
 *   - `isPermanent = true` (permanent): consumed_at stays NULL; any
 *     authenticated caller can consume as many times as they want
 *     until the owner revokes (soft-delete).
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

/**
 * Create a new share link. The token is generated server-side so
 * the caller never decides their own.
 *
 * @throws {@link ValidationError} if `role` is not 'edit' or 'view'
 * @throws {@link ConflictError} if the token randomly collides
 *   (astronomically rare; caller should retry once)
 */
export async function createLink(input: {
  projectId: string;
  createdByUserId: string;
  role: string;
  isPermanent: boolean;
  expiresAt?: Date | null;
}): Promise<ShareLink> {
  if (!isGrantableRole(input.role)) {
    throw new ValidationError(t("server.error.validation"));
  }
  const token = generateToken();
  try {
    return await shareLinkRepo.create({
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      token,
      role: input.role,
      isPermanent: input.isPermanent,
      expiresAt: input.expiresAt ?? null,
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
 *     and (for `isPermanent=false`) the link is now spent
 *
 * @throws {@link NotFoundError} if the token doesn't exist or the
 *   link has been revoked
 * @throws {@link ForbiddenError} if the link is expired, or it's a
 *   single-use link that was already consumed
 */
export async function consumeLink(token: string): Promise<ShareLink> {
  const link = await shareLinkRepo.findActiveByToken(token);
  if (!link) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  if (link.expiresAt !== null && link.expiresAt.getTime() <= Date.now()) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (!link.isPermanent) {
    if (link.consumedAt !== null) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    const claimed = await shareLinkRepo.markConsumed(link.id);
    if (!claimed) {
      // Concurrent consume raced — another caller spent the token.
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    // Return the link with consumed_at populated for caller logging.
    return { ...link, consumedAt: new Date() };
  }
  // Permanent link — no consumed_at mutation.
  return link;
}
