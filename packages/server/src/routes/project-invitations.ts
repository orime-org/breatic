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
import { decisionLink } from "@server/utils/decision-link.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { requireRole, getProjectId } from "@server/middleware/role.js";
import type { AuthRoleVariables } from "@server/middleware/role.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";

/** Respond body — confirm (accept) or decline the invite, by its link token. */
/** Create-invite body — a registered email + the granted role (never owner). */
const inviteCreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(["editor", "viewer"]),
});

const route = new Hono<{ Variables: AuthVariables }>();

route.use(requireAuth);



// ── Per-project endpoints (owner CRUD) ──────────────────────────────
//
// Mounted at `/api/v1/projects/:pid/invitations`. Owner-only, via the
// `requireRole('owner')` middleware on `:pid`.

const projectInvites = new Hono<{ Variables: AuthRoleVariables }>();

projectInvites.use(requireAuth);

/**
 * `POST /api/v1/projects/:pid/invitations` — invite a registered user (by
 * email) to the project. Owner-only; creates a PENDING invite + an actionable
 * bell notification, and (best-effort) sends an email link. The invitee becomes
 * a member only on confirm (invite-confirm handshake).
 *
 * Returns the `/project-invite?token=` URL so the owner can copy it directly:
 * the project invite funnels all three channels (this copyable URL, the bell,
 * the email) through the same landing page (the divergence from studio's inline
 * bell confirm). `createInvite` mints the shared token; the route reuses it for
 * both the email link and the returned URL.
 * @returns `201` with `{ data: { inviteLink } }`; `404` unregistered email,
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
    const origin = c.req.header("Origin") ?? "http://localhost:8000";
    // The optional best-effort invite email is sent inside the service (the bell
    // notification is the always-delivered path); the route passes the Origin and
    // reuses the returned token to build the copyable invite URL.
    const invite = await projectInviteService.createInvite(
      projectId,
      user.id,
      body.email,
      body.role,
      origin,
    );
    const inviteLink = decisionLink(origin, invite.shareToken);
    return c.json({ data: { inviteLink } }, 201);
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
