// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The owner's side of a project invitation — create one, list what is pending,
 * revoke it.
 *
 * Answering an invitation is not here. It used to be: this file also served a
 * `/project-invite` landing page with its own read and respond endpoints, the
 * mirror of a second pair on the studio side. Both pairs are gone — a request
 * is answered at `/decisions`, whichever of the five kinds it is.
 *
 * Mounted at `/api/v1/projects/:pid/invitations`, owner-only. Translation layer
 * only (prohibition #1): map the request to a `projectInviteService` call.
 */

import { Hono } from "hono";
import { frontendOrigin } from "@server/utils/frontend-origin.js";
import { z } from "zod";
import { emailSchema } from "@breatic/shared";
import { validate } from "@server/middleware/validate.js";
import { requireAuth } from "@server/middleware/auth.js";
import { requireRole, getProjectId } from "@server/middleware/role.js";
import type { AuthRoleVariables } from "@server/middleware/role.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";

/** Create-invite body — a registered email + the granted role (never owner). */
const inviteCreateSchema = z.object({
  email: emailSchema,
  role: z.enum(["editor", "viewer"]),
});

const projectInvites = new Hono<{ Variables: AuthRoleVariables }>();

projectInvites.use(requireAuth);

/**
 * `POST /api/v1/projects/:pid/invitations` — invite a registered user (by
 * email) to the project. Owner-only; creates a PENDING invite + an actionable
 * bell notification, and (best-effort) sends an email link. The invitee becomes
 * a member only on confirm (invite-confirm handshake). The invitee reaches it
 * through the bell row and the email, which carry the same `/decision?token=`
 * link; the owner's response carries neither the link nor the token.
 * @returns `201` with `{ data: { ok: true } }`; `404` unregistered email,
 *   `403` caller not owner, `409` already has access or already invited
 */
projectInvites.post(
  "/",
  requireRole("owner"),
  validate("json", inviteCreateSchema),
  async (c) => {
    const user = c.get("user");
    const projectId = getProjectId(c);
    const body = c.req.valid("json");
    // The optional best-effort invite email is sent inside the service (the bell
    // notification is the always-delivered path); the route only passes the Origin.
    await projectInviteService.createInvite(
      projectId,
      user.id,
      body.email,
      body.role,
      frontendOrigin(c.req.header("Origin")),
    );
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

export { projectInvites as projectInvitesRoute };
