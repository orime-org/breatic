/**
 * Project routes — CRUD, duplicate, and canvas snapshot.
 *
 * All endpoints require authentication and return responses wrapped
 * in the shared `{ data: ... }` envelope so the frontend API layer
 * can rely on a single unwrap shape across every route.
 *
 * Canvas data on the project row is a legacy JSONB snapshot used by
 * `PUT /:id/canvas`. The live collaborative canvas lives in the Yjs
 * documents (`project-<id>/canvas` and `project-<id>/node/<nodeId>`),
 * which are the objects actually copied by the duplicate endpoint.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  projectCreateSchema,
  canvasSaveSchema,
  paginationSchema,
} from "./schemas.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import * as projectService from "../modules/project.service.js";

const projects = new Hono<{ Variables: AuthVariables }>();

projects.use(requireAuth);

/**
 * `POST /projects` — create a new project.
 *
 * @returns `201` with `{ data: ProjectEntity }`
 */
projects.post("/", zValidator("json", projectCreateSchema), async (c) => {
  const user = c.get("user");
  const { name, description } = c.req.valid("json");
  const project = await projectService.create(user.id, name, description);
  return c.json({ data: project }, 201);
});

/**
 * `GET /projects` — list the authenticated user's projects, ordered
 * by most recently updated.
 *
 * @returns `200` with `{ data: ProjectEntity[] }`
 */
projects.get("/", zValidator("query", paginationSchema), async (c) => {
  const user = c.get("user");
  const { limit, offset } = c.req.valid("query");
  const list = await projectService.list(user.id, limit, offset);
  return c.json({ data: list });
});

/** Body schema for `PUT /projects/:id` — any subset of the mutable fields. */
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
 * `PUT /projects/:id` — update name / description / thumbnail.
 *
 * Accepts any subset of the mutable fields; `null` is legal for
 * `description` and `thumbnail_url` (clears the value), `undefined`
 * leaves the field unchanged.
 *
 * @returns `200` with `{ data: ProjectEntity }`
 * @throws `404` if the project does not exist
 * @throws `403` if the caller does not own the project
 */
projects.put("/:id", zValidator("json", projectUpdateSchema), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = c.req.valid("json");
  const updated = await projectService.update(id, user.id, {
    name: body.name,
    description: body.description,
    thumbnailUrl: body.thumbnail_url,
  });
  return c.json({ data: updated });
});

/**
 * `POST /projects/:id/duplicate` — fork a project into a new one.
 *
 * Copies the project row and every Yjs document (canvas + per-node
 * editors) inside a single database transaction. Conversations,
 * tasks, memory rows, and node history are NOT copied — the
 * duplicate starts with a fresh timeline. See project.service.ts
 * for the full list of what is and is not carried over.
 *
 * @returns `201` with `{ data: ProjectEntity }` — the NEW project
 * @throws `404` if the source project does not exist
 * @throws `403` if the caller does not own the source project
 */
projects.post("/:id/duplicate", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const copy = await projectService.duplicate(id, user.id);
  return c.json({ data: copy }, 201);
});

/**
 * `PUT /projects/:id/canvas` — save a canvas data JSON snapshot.
 *
 * Legacy path used by the non-Yjs snapshot flow. Live collab goes
 * through the Hocuspocus / Yjs document directly.
 */
projects.put(
  "/:id/canvas",
  zValidator("json", canvasSaveSchema),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const { canvas_data } = c.req.valid("json");
    await projectService.saveCanvas(id, user.id, canvas_data);
    return c.json({ data: { success: true } });
  },
);

/**
 * `DELETE /projects/:id` — soft-delete a project.
 *
 * @returns `200` with `{ data: { success: true } }`
 * @throws `404` if the project does not exist
 * @throws `403` if the caller does not own the project
 */
projects.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await projectService.deleteProject(id, user.id);
  return c.json({ data: { success: true } });
});

export { projects as projectsRoute };
