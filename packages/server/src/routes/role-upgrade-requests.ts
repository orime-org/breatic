// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Role-upgrade request routes — viewer asks owner for editor rights.
 *
 * Two mount points:
 *   - `/api/v1/projects/:pid/role-upgrade-requests`
 *       POST    — viewer submits a request (caller must be 'viewer' on
 *                 the project; service inserts a notification in
 *                 the owner's inbox).
 *   - `/api/v1/role-upgrade-requests/:notificationId/decision`
 *       PATCH   — owner decides (approve/reject); service atomically
 *                 bumps the requester's role (approve only), creates
 *                 the decision notification, and marks the request
 *                 read on the owner's side.
 *
 * The notification id (not a separate request id) is the handle for
 * decisions because the request itself lives in the notifications
 * table (see spec § 7) — there's no separate "role_upgrade_requests"
 * relation.
 *
 * Spec: access-permission design (2026-05-28) § 6.3.
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
  notificationService,
} from "@server/modules";
import {
  ForbiddenError,
  NotFoundError,
} from "@breatic/core";

// ── Per-project endpoint (viewer-only POST) ────────────────────────

const projectRoleUpgradeRequests = new Hono<{
  Variables: AuthRoleVariables;
}>();
projectRoleUpgradeRequests.use(requireAuth);

const requestBodySchema = z.object({
  message: z.string().trim().max(500).optional(),
});

/**
 * `POST /api/v1/projects/:pid/role-upgrade-requests` — viewer asks
 * owner for editor access.
 *
 * Gate: caller must currently be `viewer` on the project. `editor` and
 * `owner` callers get 403 (they don't need to upgrade — editors are
 * already at the highest non-owner role).
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

    const notification = await roleUpgradeRequestService.request({
      ownerUserId,
      requesterUserId: user.id,
      projectId,
      projectName: project.name,
      projectSlug: project.slug,
      message: body.message ?? null,
    });

    return c.json({ data: notification }, 201);
  },
);

// ── Decision endpoint (owner-only) ─────────────────────────────────

const decisionRoute = new Hono<{ Variables: AuthVariables }>();
decisionRoute.use(requireAuth);

const decisionBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
});

/**
 * `PATCH /api/v1/role-upgrade-requests/:notificationId/decision`
 *
 * Owner approves or rejects a pending request. Authorization happens
 * inside the service via `loadAndGate` (the notification's `userId`
 * must equal the caller — the route stays project-agnostic because
 * the notification id is globally unique).
 *
 * Body: { decision: "approved" | "rejected"; reason?: string }
 */
decisionRoute.patch(
  "/:notificationId/decision",
  zValidator("json", decisionBodySchema),
  async (c) => {
    const user = c.get("user");
    const notificationId = c.req.param("notificationId");
    const body = c.req.valid("json");

    // Look up the project name + slug for the decision notification's
    // payload so the requester's BellMenu can render the headline + the
    // `/project/{slug}-{id}` link without a join.
    const project = await loadProjectForNotification(notificationId, user.id);

    if (body.decision === "approved") {
      await roleUpgradeRequestService.approve({
        notificationId,
        ownerUserId: user.id,
        projectName: project.name,
        projectSlug: project.slug,
      });
    } else {
      await roleUpgradeRequestService.reject({
        notificationId,
        ownerUserId: user.id,
        projectName: project.name,
        projectSlug: project.slug,
        reason: body.reason ?? null,
      });
    }
    return c.json({ data: { ok: true } });
  },
);

/**
 * Fetch the project name + URL slug from the notification's `projectId` so the
 * decision notification's payload can carry them (the requester's bell renders
 * the headline + the `/project/{slug}-{id}` link without a join). The
 * service-layer gate guarantees the caller owns the source notification, so this
 * helper trusts the projectId at face value (any drift surfaces as a NotFound on
 * the projectService side).
 * @param notificationId - The source role-upgrade notification whose `projectId` is resolved.
 * @param ownerUserId - The project owner making the decision, used to authorize the project lookup.
 * @returns The project's display name + URL slug.
 * @throws {NotFoundError} when the notification is missing or has no associated project.
 */
async function loadProjectForNotification(
  notificationId: string,
  ownerUserId: string,
): Promise<{ name: string; slug: string }> {
  const row = await notificationService.getById(notificationId);
  if (!row) {
    throw new NotFoundError("notification not found");
  }
  if (row.projectId === null) {
    throw new NotFoundError("notification has no project");
  }
  const project = await projectService.get(row.projectId, ownerUserId);
  return { name: project.name, slug: project.slug };
}

export { projectRoleUpgradeRequests as projectRoleUpgradeRequestsRoute };
export { decisionRoute as roleUpgradeRequestDecisionRoute };
