// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project routes — CRUD, duplicate, and membership-aware reads.
 *
 * v10 schema: ownership lives in `project_members`. Reads / mutations
 * are gated by the `requireRole` middleware (defined in
 * `middleware/role.ts`), which translates "this caller cannot do this"
 * into a 403 — never a 404, to avoid leaking project existence.
 *
 * The legacy `PUT /:id/canvas` snapshot endpoint is gone (v10 spec
 * §13.2): live canvas state lives in Yjs `project-{id}/canvas-{sid}`
 * docs, persisted by the collab service.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { projectCreateSchema } from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { requireRoleOnParam } from "@server/middleware/role.js";
import type { AuthRoleVariables } from "@server/middleware/role.js";
import { projectService } from "@server/modules";
import { projectAuthService } from "@breatic/core";
import { NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import type { ProjectDetail } from "@breatic/shared";

const projects = new Hono<{ Variables: AuthVariables }>();

projects.use(requireAuth);

/**
 * `POST /projects` — create a new project owned by the caller.
 *
 * Resolves the caller's personal studio (creating it if missing) and
 * inserts the owner row in `project_members` inside the same
 * transaction as the projects insert.
 * @returns `201` with `{ data: ProjectEntity }`
 */
projects.post("/", zValidator("json", projectCreateSchema), async (c) => {
  const user = c.get("user");
  const { name, slug, visibility, description } = c.req.valid("json");
  const project = await projectService.create(user.id, name, slug, visibility, description);
  return c.json({ data: project }, 201);
});

/**
 * `GET /projects/:id` — read a project plus the caller's role (the
 * project-open path).
 *
 * NOT behind `requireRoleOnParam`: this is the open-baseline entry point
 * (slice 2). `projectService.loadForViewer` resolves access including the
 * open-baseline grant (a studio member opening a studio-visible project is
 * admitted as a viewer and a `project_members` row is materialized on this
 * server path, before the client opens collab) and returns the effective
 * `myRole`. No access (private with no row / not a studio member / missing)
 * collapses to a `404`, never leaking project existence. v10 §7.2.6.
 * @returns `200` with `{ data: ProjectDetail }`
 */
projects.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { project, myRole } = await projectService.loadForViewer(id, user.id);
  const detail: ProjectDetail = {
    id: project.id,
    studioId: project.studioId,
    createdByUserId: project.createdByUserId,
    name: project.name,
    description: project.description,
    thumbnailUrl: project.thumbnailUrl,
    myRole,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    deletedAt: project.deletedAt,
  };
  return c.json({ data: detail });
});

// ── Membership-gated writes ────────────────────────────────────────
//
// Every route below this point sits behind `requireRoleOnParam('id',
// minRole)`. The middleware resolves the caller's role on `:id`, rejects
// non-members / insufficient roles with 403, and stamps the role on
// `c.var.role`. (The read path `GET /:id` above is intentionally NOT here —
// it grants open-baseline access + materializes, which the role middleware
// would block before the handler runs.)

const membershipScoped = new Hono<{ Variables: AuthRoleVariables }>();

/** Body schema for `PATCH /projects/:id` — any subset of the mutable fields. */
const projectUpdateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    thumbnail_url: z.string().url().nullable().optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    { message: "At least one field must be provided" },
  );

/**
 * `PATCH /projects/:id` — partial update of name / description / thumbnail.
 *
 * PATCH semantic = client sends only fields to change (DD orime-org/
 * breatic-inner-design#152 D1; aligns with `members.patch` precedent).
 * Requires `editor` (renaming etc. is content editing, not an admin-only
 * operation). v10 §7.2.1.
 * @returns `200` with `{ data: ProjectEntity }`
 */
membershipScoped.patch(
  "/:id",
  requireRoleOnParam("id", "editor"),
  zValidator("json", projectUpdateSchema),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const updated = await projectService.update(id, user.id, {
      name: body.name,
      description: body.description,
      thumbnailUrl: body.thumbnail_url,
    });
    return c.json({ data: updated });
  },
);

/**
 * `POST /projects/:id/duplicate` — fork a project into a new one.
 *
 * Requires `viewer`: anyone who can read the source can fork it. The
 * duplicate is owned by the caller (new owner row in
 * `project_members`).
 * @returns `201` with `{ data: ProjectEntity }` — the NEW project
 */
membershipScoped.post(
  "/:id/duplicate",
  requireRoleOnParam("id", "viewer"),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const copy = await projectService.duplicate(id, user.id);
    return c.json({ data: copy }, 201);
  },
);

/**
 * `DELETE /projects/:id` — soft-delete a project.
 *
 * Requires `owner` (cascades to all the project's children).
 * @returns `200` with `{ data: { success: true } }`
 */
membershipScoped.delete(
  "/:id",
  requireRoleOnParam("id", "owner"),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    await projectService.deleteProject(id, user.id);
    return c.json({ data: { success: true } });
  },
);

projects.route("/", membershipScoped);

// `projectAuthService` and `NotFoundError` / `t` are imported above
// because future route additions on this surface will use them; if
// nothing references them after a refactor, remove during cleanup.
void projectAuthService;
void NotFoundError;
void t;

export { projects as projectsRoute };
