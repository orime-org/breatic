// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project activity feed read route (ADR 2026-07-04
 * project-activity-feed).
 *
 * `GET /projects/:projectId/activities?cursor=&limit=` - one keyset
 * page, newest first, actor display names joined in server-side.
 * Every project member may read (viewer included) - the feed is the
 * project's shared audit trail, not a privileged view.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { projectService } from "@server/modules";
import { listProjectActivities } from "@server/modules/activity/projectActivity.service.js";

const activities = new Hono<{ Variables: AuthVariables }>();

const listQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

activities.get(
  "/:projectId/activities",
  requireAuth,
  zValidator("query", listQuerySchema),
  async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");
    const { cursor, limit } = c.req.valid("query");

    // Any member may read the feed; non-members get the standard 404
    // (existence-hiding baseline).
    await projectService.assertAccess(projectId, user.id, "viewer");

    const page = await listProjectActivities(projectId, cursor, limit);
    return c.json({ data: page });
  },
);

export { activities as activitiesRoute };
