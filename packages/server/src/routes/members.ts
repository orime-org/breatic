/**
 * Project members routes — list / invite / change role / remove.
 *
 * Mounted under `/api/v1/projects/:pid/members`. All endpoints sit
 * behind `requireRole`, which translates "no membership" or "below
 * minimum" into 403 (never 404 — see middleware/role.ts).
 *
 * `transfer-owner` is intentionally not implemented in V1 (v10 spec
 * §7.2.5). For project ownership transfer, see the team-Studio
 * phase.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@server/middleware/auth.js";
import { requireRole } from "@server/middleware/role.js";
import type { AuthRoleVariables } from "@server/middleware/role.js";
import { projectMembersService } from "@server/modules";

const members = new Hono<{ Variables: AuthRoleVariables }>();

members.use(requireAuth);

/**
 * `GET /api/v1/projects/:pid/members` — list active members.
 *
 * Any current member (including view) can list. Returns the role
 * relation rows; the frontend joins with `useUsers` for display
 * fields (avatar / username / email).
 *
 * @returns `200` with `{ data: ProjectMember[] }`
 */
members.get("/", requireRole("view"), async (c) => {
  const projectId = c.get("projectId");
  const list = await projectMembersService.list(projectId);
  return c.json({ data: list });
});

const inviteBodySchema = z.object({
  user_id: z.string().uuid(),
  // Owner cannot be invited directly — owner promotion is the
  // transfer-owner endpoint, deferred to V2.
  role: z.enum(["view", "edit"]),
});

/**
 * `POST /api/v1/projects/:pid/members` — invite a user.
 *
 * Owner only. If the target was previously removed, the existing
 * row is revived with the new role.
 *
 * @returns `201` with `{ data: { ok: true } }`
 */
members.post(
  "/",
  requireRole("owner"),
  zValidator("json", inviteBodySchema),
  async (c) => {
    const inviter = c.get("user");
    const projectId = c.get("projectId");
    const body = c.req.valid("json");
    await projectMembersService.invite(
      projectId,
      body.user_id,
      body.role,
      inviter.id,
    );
    return c.json({ data: { ok: true } }, 201);
  },
);

const patchBodySchema = z.object({
  role: z.enum(["view", "edit"]),
});

/**
 * `PATCH /api/v1/projects/:pid/members/:userId` — change role.
 *
 * Owner only. Owner role itself is immutable (transfer-owner deferred).
 *
 * @returns `200` with `{ data: { ok: true } }`
 */
members.patch(
  "/:userId",
  requireRole("owner"),
  zValidator("json", patchBodySchema),
  async (c) => {
    const projectId = c.get("projectId");
    const targetUserId = c.req.param("userId");
    const body = c.req.valid("json");
    await projectMembersService.changeRole(projectId, targetUserId, body.role);
    return c.json({ data: { ok: true } });
  },
);

/**
 * `DELETE /api/v1/projects/:pid/members/:userId` — soft-remove a member.
 *
 * Owner only. Owner cannot be removed (transfer-owner is V2).
 *
 * @returns `200` with `{ data: { ok: true } }`
 */
members.delete(
  "/:userId",
  requireRole("owner"),
  async (c) => {
    const projectId = c.get("projectId");
    const targetUserId = c.req.param("userId");
    await projectMembersService.remove(projectId, targetUserId);
    return c.json({ data: { ok: true } });
  },
);

export { members as membersRoute };
