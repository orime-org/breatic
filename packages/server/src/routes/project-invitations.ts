// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project invitation email-link routes — the `/project-invite` landing page
 * uses these to show an invite and confirm/decline it (invite-confirm
 * handshake, 2026-06-18, #1337). The direct mirror of `studio-invitations.ts`.
 *
 * Both auth-only: the invitee must be logged in. The one-time token resolves
 * the invite; the CAS guard inside the service ties confirm/decline to the
 * invitee, so a forwarded link cannot be acted on by someone else.
 *
 * Mounted at `/api/v1/project-invitations`. Translation layer only
 * (prohibition #1): map the request to a `projectInviteService` call.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { NotFoundError, logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { requireRole, getProjectId } from "@server/middleware/role.js";
import type { AuthRoleVariables } from "@server/middleware/role.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";
import { buildProjectInvitationMail } from "@server/modules/project-invite/project-invite-mail.js";
import { sendMail } from "@server/infra/mailer.js";
import { logMailResult } from "@server/utils/log-mail.js";

/** Respond body — confirm (accept) or decline the invite, by its link token. */
const respondSchema = z.object({
  token: z.string().min(1),
  action: z.enum(["confirm", "decline"]),
});

/** Create-invite body — a registered email + the granted role (never owner). */
const inviteCreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(["editor", "viewer"]),
});

const route = new Hono<{ Variables: AuthVariables }>();

route.use(requireAuth);

/**
 * `GET /api/v1/project-invitations/:token` — the landing-page view for an
 * invite link (project + inviter names, role, `expired`, `isInvitee`). Does NOT
 * consume the token (the invitee reads it before acting).
 * @returns `200` with `{ data: ProjectInvitationLandingView }`; `404` when the
 *   token / invite is gone (expired link or already decided)
 */
route.get("/:token", async (c) => {
  const user = c.get("user");
  const token = c.req.param("token");
  const data = await projectInviteService.getInviteForLanding(token, user.id);
  if (!data) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return c.json({ data });
});

/**
 * `POST /api/v1/project-invitations/respond` — confirm or decline an invite
 * from the email link; consumes the one-time token. Returns the project id +
 * slug for the post-confirm redirect.
 * @returns `200` with `{ data: { projectId, projectSlug } }`; `404` token /
 *   invite gone, already decided, expired, or the caller is not the invitee
 */
route.post("/respond", zValidator("json", respondSchema), async (c) => {
  const user = c.get("user");
  const { token, action } = c.req.valid("json");
  const data = await projectInviteService.respondToInvite(
    token,
    action,
    user.id,
  );
  return c.json({ data });
});

// ── Per-project endpoints (owner CRUD) ──────────────────────────────
//
// Mounted at `/api/v1/projects/:pid/invitations`. Owner-only (mirrors the old
// invite-links owner gate), via the `requireRole('owner')` middleware on `:pid`.

const projectInvites = new Hono<{ Variables: AuthRoleVariables }>();

projectInvites.use(requireAuth);

/**
 * `POST /api/v1/projects/:pid/invitations` — invite a registered user (by
 * email) to the project. Owner-only; creates a PENDING invite + an actionable
 * bell notification, and (best-effort) sends an email link. The invitee becomes
 * a member only on confirm (invite-confirm handshake).
 * @returns `201` with `{ data: { ok: true } }`; `404` unregistered email,
 *   `403` caller not owner, `409` already has access or already invited
 */
projectInvites.post(
  "/",
  requireRole("owner"),
  zValidator("json", inviteCreateSchema),
  async (c) => {
    const user = c.get("user");
    const projectId = getProjectId(c);
    const body = c.req.valid("json");
    const invite = await projectInviteService.createInvite(
      projectId,
      user.id,
      body.email,
      body.role,
    );
    // Email is an OPTIONAL enhancement — the bell notification is the always-
    // delivered path. A send failure must NOT fail the request (the invite +
    // bell already landed); best-effort, logged at the application boundary.
    try {
      const token = await projectInviteService.issueInviteToken(
        invite.invitationId,
      );
      const origin = c.req.header("Origin") ?? "http://localhost:8000";
      const result = await sendMail(
        buildProjectInvitationMail({
          inviteeEmail: invite.inviteeEmail,
          inviterName: invite.inviterName,
          projectName: invite.projectName,
          role: invite.role,
          inviteLink: `${origin}/project-invite?token=${token}`,
        }),
      );
      logMailResult(result, { userId: user.id, subject: "project_invite" });
    } catch (err) {
      logger.error(
        { err, projectId, invitationId: invite.invitationId },
        "project_invite_email_failed",
      );
    }
    return c.json({ data: { ok: true } }, 201);
  },
);

/**
 * `GET /api/v1/projects/:pid/invitations` — list the project's LIVE pending
 * invitations (for the owner's "invited (pending)" section). Owner-only.
 * @returns `200` with `{ data: PendingProjectInvitationSummary[] }`
 */
projectInvites.get("/", requireRole("owner"), async (c) => {
  const projectId = getProjectId(c);
  const data = await projectInviteService.listPending(projectId);
  return c.json({ data });
});

/**
 * `DELETE /api/v1/projects/:pid/invitations/:invitationId` — the owner revokes
 * a pending invite. Owner-only; flips it to `revoked` and clears the invitee's
 * bell notification.
 * @returns `200` with `{ data: { ok: true } }`; `403` not owner, `404` no
 *   matching pending invite in this project
 */
projectInvites.delete(
  "/:invitationId",
  requireRole("owner"),
  async (c) => {
    const projectId = getProjectId(c);
    const invitationId = c.req.param("invitationId");
    await projectInviteService.revokeInvite(projectId, invitationId);
    return c.json({ data: { ok: true } });
  },
);

export { route as projectInvitationsRoute };
export { projectInvites as projectInvitesRoute };
