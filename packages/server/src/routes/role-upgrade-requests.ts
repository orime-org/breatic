// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Role-upgrade request routes — a viewer asks the owner for editor rights.
 *
 * Two mount points:
 *   - `/api/v1/projects/:pid/role-upgrade-requests`
 *       POST  — the viewer files a request
 *       GET   `/mine` — their own live request, for the button that turns into
 *               "requested · cancel"
 *   - `/api/v1/role-upgrade-requests/:requestId`
 *       DELETE — the requester withdraws
 *
 * The owner's approve/reject is deliberately NOT here: a request is answered
 * at `/decisions`, whichever of the five kinds it is.
 *
 * The handle is the REQUEST id. It used to be the notification id, because the
 * request had no row of its own — it only existed as an entry in somebody's
 * bell. That is what this work undid: the request is now a row with a status,
 * a deadline and a uniqueness rule, and the bell entry merely announces it.
 *
 * Authorisation is not decided here. The withdraw route is project-agnostic on
 * purpose: the request id alone does not say which project it belongs to, so
 * checking anything at this layer would mean reading the row twice and acting
 * on the first read. The service reads it once, under a row lock, and every
 * gate is applied against that one read.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { requireRole, getProjectId } from "@server/middleware/role.js";
import type { AuthRoleVariables } from "@server/middleware/role.js";
import {
  roleUpgradeRequestService,
  projectService,
  projectMembersService,
} from "@server/modules";
import { ForbiddenError, NotFoundError } from "@breatic/core";

// ── Per-project endpoints (the requester's side) ───────────────────

const projectRoleUpgradeRequests = new Hono<{
  Variables: AuthRoleVariables;
}>();
projectRoleUpgradeRequests.use(requireAuth);

const requestBodySchema = z.object({
  message: z.string().trim().max(500).optional(),
});

/**
 * `POST /api/v1/projects/:pid/role-upgrade-requests` — a viewer asks the owner
 * for editor access.
 *
 * Gate: the caller must currently be `viewer` on the project. `editor` and
 * `owner` callers get 403 — they have nothing to upgrade to.
 */
projectRoleUpgradeRequests.post(
  "/",
  requireRole("viewer"),
  zValidator("json", requestBodySchema),
  async (c) => {
    const user = c.get("user");
    const role = c.get("role");
    if (role !== "viewer") {
      throw new ForbiddenError("only viewers can request a role upgrade");
    }
    const projectId = getProjectId(c);
    const body = c.req.valid("json");

    const [project, ownerUserId] = await Promise.all([
      projectService.get(projectId, user.id),
      projectMembersService.getOwner(projectId),
    ]);
    if (!ownerUserId) {
      throw new NotFoundError("project has no active owner");
    }

    // The service sends the best-effort email itself (it needs the owner + the
    // request's token); the route only forwards the Origin for the link.
    const filed = await roleUpgradeRequestService.request({
      ownerUserId,
      requesterUserId: user.id,
      projectId,
      projectName: project.name,
      message: body.message ?? null,
      origin: c.req.header("Origin") ?? "",
    });

    return c.json(
      { data: { requestId: filed.requestId, notification: filed.notification } },
      201,
    );
  },
);

/**
 * `GET /api/v1/projects/:pid/role-upgrade-requests/mine` — the caller's own
 * live request on this project, or null.
 *
 * Open to any project member rather than to viewers only: a request that was
 * just approved leaves its filer an editor, and an editor asking "do I still
 * have one outstanding" deserves the honest answer (none) rather than a 403.
 */
projectRoleUpgradeRequests.get("/mine", requireRole("viewer"), async (c) => {
  const user = c.get("user");
  const live = await roleUpgradeRequestService.findLive(
    getProjectId(c),
    user.id,
  );
  return c.json({
    data: live
      ? { id: live.id, expiresAt: live.expiresAt.toISOString() }
      : null,
  });
});

// ── Per-request endpoints (withdraw) ───────────────────────────────
//
// Deciding is NOT here. The owner used to approve/reject through a PATCH on
// this router; a request is answered at `/decisions`, whichever of the five
// kinds it is, and this router keeps only what belongs to the REQUESTER —
// taking their own request back.

const withdrawRoute = new Hono<{ Variables: AuthVariables }>();
withdrawRoute.use(requireAuth);

/**
 * The request id, validated as a uuid before it reaches a uuid comparison.
 *
 * Without this the param goes straight into `WHERE id = $1` against a uuid
 * column, and Postgres rejects the whole statement for anything that is not a
 * uuid (SQLSTATE 22P02) — a user-supplied string turning into an unclassified
 * 500. The same guard already exists on the studio slug-check route for the
 * same reason.
 */
const requestParamSchema = z.object({ requestId: z.string().uuid() });

/**
 * `DELETE /api/v1/role-upgrade-requests/:requestId` — the requester withdraws
 * their own request.
 *
 * Only the person who filed it may withdraw it, which the service enforces by
 * matching the caller against the row's `requester_user_id`; a request that is
 * not theirs, or not live, answers 404 either way.
 */
withdrawRoute.delete(
  "/:requestId",
  zValidator("param", requestParamSchema),
  async (c) => {
    const user = c.get("user");
    await roleUpgradeRequestService.cancel(c.req.param("requestId"), user.id);
    return c.json({ data: { ok: true } });
  },
);

export { projectRoleUpgradeRequests as projectRoleUpgradeRequestsRoute };
export { withdrawRoute as roleUpgradeRequestWithdrawRoute };
