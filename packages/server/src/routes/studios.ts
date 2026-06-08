// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio routes — the container shell (slice 1).
 *
 * Two endpoints, both authenticated:
 *   - `GET /api/v1/studios`            — the current user's studios (switcher).
 *   - `GET /api/v1/studio/:slug`       — one studio's public-facing shell.
 *   - `GET /api/v1/studio/:slug/projects` — the studio's projects, filtered
 *     to what the viewer may see (open-baseline visibility, slice 2).
 *
 * The shell is visible to any authenticated user (decision A — a studio's
 * `/studio/{slug}` page is its front door): a non-member gets a `200` with
 * `myStudioRole: null` (a guest), NOT a `403`. A slug with no active studio
 * surfaces as `NotFoundError` → `404` via the global error handler.
 *
 * Translation layer only (prohibition #1): map the request to a
 * `studioService` call and wrap the result in the `{ data }` envelope.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "@server/middleware/auth.js";
import { requireStudioRole } from "@server/middleware/studio-role.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { studioService, projectService } from "@server/modules";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";

/** Invite body — a registered email + the granted role (never admin). */
const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["creator", "member"]),
});

/** Change-role body — creator ↔ member only. */
const changeRoleSchema = z.object({
  role: z.enum(["creator", "member"]),
});

const studios = new Hono<{ Variables: AuthVariables }>();

studios.use(requireAuth);

/**
 * `GET /api/v1/studios` — every studio the current user is an active
 * member of, personal-first (the switcher list).
 * @returns `200` with `{ data: StudioSummary[] }`
 */
studios.get("/", async (c) => {
  const user = c.get("user");
  const data = await studioService.listUserStudios(user.id);
  return c.json({ data });
});

const studio = new Hono<{ Variables: AuthVariables }>();

studio.use(requireAuth);

/**
 * `GET /api/v1/studio/:slug` — one studio's public-facing shell, with the
 * viewing user's role (`admin` / `member` / `null` = guest).
 * @returns `200` with `{ data: StudioDetail }`; `404` when no active studio
 *   has that slug (service throws `NotFoundError`)
 */
studio.get("/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const data = await studioService.getStudioDetail(slug, user.id);
  return c.json({ data });
});

/**
 * `GET /api/v1/studio/:slug/projects` — the studio's projects visible to the
 * viewer (open-baseline visibility, slice 2).
 *
 * Server-side filtered (`projectService.listByStudioSlug`): a studio member
 * sees studio-visible projects + their own private ones; an admin sees all;
 * a non-member gets `[]` (the guest shell shows no projects). A slug with no
 * active studio surfaces as `404`.
 * @returns `200` with `{ data: ProjectSummary[] }`
 */
studio.get("/:slug/projects", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const data = await projectService.listByStudioSlug(slug, user.id);
  return c.json({ data });
});

/**
 * `GET /api/v1/studio/:slug/members` — the studio's active members for the
 * Members tab (display name / email / role / join date). Visible to any
 * authenticated user (decision A); a non-member's tab never calls it. A
 * personal studio returns exactly its owner.
 * @returns `200` with `{ data: StudioMemberSummary[] }`; `404` when no active
 *   studio has that slug (service throws `NotFoundError`)
 */
studio.get("/:slug/members", async (c) => {
  const slug = c.req.param("slug");
  const data = await studioService.getStudioMembers(slug);
  return c.json({ data });
});

/**
 * `POST /api/v1/studio/:slug/members` — invite a registered user (by email)
 * into the studio. Admin-only; the invite takes effect immediately and drops
 * an informational notification in the invitee's inbox (slice 3).
 * @returns `201` with `{ data: { ok: true } }`; `404` unregistered email,
 *   `403` personal studio / caller not admin, `409` already a member
 */
studio.post("/:slug/members", requireStudioRole("admin"), async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const body = inviteMemberSchema.parse(await c.req.json());
  await studioMemberService.inviteMember(slug, user.id, body.email, body.role);
  return c.json({ data: { ok: true } }, 201);
});

/**
 * `DELETE /api/v1/studio/:slug/members/:userId` — remove (kick) a member.
 * Admin-only; clears the member's access across all the studio's projects and
 * transfers their owned projects to the acting admin, in one transaction.
 * @returns `200` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` not a member, `409` the sole admin (transfer first)
 */
studio.delete("/:slug/members/:userId", requireStudioRole("admin"), async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const targetUserId = c.req.param("userId");
  await studioMemberService.removeMember(slug, targetUserId, user.id);
  return c.json({ data: { ok: true } });
});

/**
 * `PATCH /api/v1/studio/:slug/members/:userId` — change a member's role
 * (creator ↔ member). Admin-only; admin grant/demote goes through
 * transfer-admin, not here.
 * @returns `200` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` not a member, `409` target is the admin (demote via transfer)
 */
studio.patch("/:slug/members/:userId", requireStudioRole("admin"), async (c) => {
  const slug = c.req.param("slug");
  const targetUserId = c.req.param("userId");
  const body = changeRoleSchema.parse(await c.req.json());
  await studioMemberService.updateMemberRole(slug, targetUserId, body.role);
  return c.json({ data: { ok: true } });
});

export { studios as studiosRoute, studio as studioRoute };
