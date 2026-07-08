// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project members routes — list / invite / change role / remove.
 *
 * Mounted under `/api/v1/projects/:pid/members`. All endpoints sit
 * behind `requireRole`, which translates "no membership" or "below
 * minimum" into 403 (never 404 — see middleware/role.ts).
 *
 * Project ownership transfer (#1611) runs via `POST /projects/:id/transfer-owner`
 * (a two-step handshake, see projectTransfer.service); this router exposes its
 * recipient picker via `GET .../members/transfer-candidates` (owner-only).
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
 * Any current member (including viewer) can list. Returns the role
 * relation rows; the frontend joins with `useUsers` for display
 * fields (avatar / display name / email).
 * @returns `200` with `{ data: ProjectMember[] }`
 */
members.get("/", requireRole("viewer"), async (c) => {
  const projectId = c.get("projectId");
  const list = await projectMembersService.list(projectId);
  return c.json({ data: list });
});

/**
 * `GET /api/v1/projects/:pid/members/transfer-candidates` — the eligible
 * owner-transfer recipients (owner-only): active project members (editor /
 * viewer) who are ALSO active non-guest members of the project's studio
 * (ADR D3). Backs the transfer recipient picker so it never offers a recipient
 * the transfer would reject. The transfer itself runs via
 * `POST /projects/:id/transfer-owner`.
 * @returns `200` with `{ data: Array<{ userId, role }> }`
 */
members.get("/transfer-candidates", requireRole("owner"), async (c) => {
  const projectId = c.get("projectId");
  const candidates =
    await projectMembersService.listTransferCandidates(projectId);
  return c.json({ data: candidates });
});

const patchBodySchema = z.object({
  role: z.enum(["viewer", "editor"]),
});

/**
 * `PATCH /api/v1/projects/:pid/members/:userId` — change role.
 *
 * Owner only. Owner role itself is immutable (transfer-owner deferred).
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
    await projectMembersService.changeRole(projectId, targetUserId, body.role, c.get("user").id);
    return c.json({ data: { ok: true } });
  },
);

/**
 * `DELETE /api/v1/projects/:pid/members/:userId` — soft-remove a member.
 *
 * Owner only. Owner cannot be removed (transfer-owner is V2).
 * @returns `200` with `{ data: { ok: true } }`
 */
members.delete(
  "/:userId",
  requireRole("owner"),
  async (c) => {
    const projectId = c.get("projectId");
    const targetUserId = c.req.param("userId");
    await projectMembersService.remove(projectId, targetUserId, c.get("user").id);
    return c.json({ data: { ok: true } });
  },
);

export { members as membersRoute };
