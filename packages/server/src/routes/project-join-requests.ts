// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project join request routes — a studio member who is not on a project asks
 * its owner to let them in (#96).
 *
 * Mounted at `/api/v1/projects/:pid/join-requests`:
 *   POST          — file a request
 *   GET  `/mine`  — the project's name, its studio, and the caller's pending request
 *   DELETE `/mine` — withdraw the caller's pending request
 *
 * The owner's approve / reject is answered at `/decisions`, like every other
 * waiting request. These routes carry no role gate: the caller is by
 * definition not a member, and the service decides studio membership.
 */

import { Hono } from "hono";
import { z } from "zod";
import { validate } from "@server/middleware/validate.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { frontendOrigin } from "@server/utils/frontend-origin.js";
import { projectJoinRequestService } from "@server/modules";

const paramSchema = z.object({ pid: z.string().uuid() });
const requestBodySchema = z.object({
  message: z.string().trim().max(500).optional(),
});

const route = new Hono<{ Variables: AuthVariables }>();
route.use(requireAuth);

/** `POST /api/v1/projects/:pid/join-requests` — ask the owner to let you in. */
route.post(
  "/",
  rateLimitFor("project-join-request", "user"),
  validate("param", paramSchema),
  validate("json", requestBodySchema),
  async (c) => {
    const user = c.get("user");
    const { pid } = c.req.valid("param");
    const body = c.req.valid("json");
    await projectJoinRequestService.request({
      projectId: pid,
      requesterUserId: user.id,
      message: body.message ?? null,
      origin: frontendOrigin(c.req.header("Origin")),
    });
    return c.json({ data: null }, 201);
  },
);

/** `GET /api/v1/projects/:pid/join-requests/mine` — what the join dialog shows. */
route.get("/mine", validate("param", paramSchema), async (c) => {
  const user = c.get("user");
  const { pid } = c.req.valid("param");
  const view = await projectJoinRequestService.getMine(pid, user.id);
  return c.json({ data: view });
});

/** `DELETE /api/v1/projects/:pid/join-requests/mine` — withdraw your request. */
route.delete("/mine", validate("param", paramSchema), async (c) => {
  const user = c.get("user");
  const { pid } = c.req.valid("param");
  await projectJoinRequestService.cancelMine(pid, user.id);
  return c.json({ data: null });
});

export { route as projectJoinRequestsRoute };
