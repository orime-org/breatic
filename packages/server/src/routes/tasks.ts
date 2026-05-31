/**
 * Task routes — read-only access to task history.
 *
 * Task creation is handled via the canvas/chat endpoints;
 * these routes expose listing and detail views.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { paginationSchema } from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { taskService } from "@breatic/domain";

const tasks = new Hono<{ Variables: AuthVariables }>();

tasks.use(requireAuth);

/** `GET /tasks` — list the authenticated user's tasks. */
tasks.get("/", zValidator("query", paginationSchema), async (c) => {
  const user = c.get("user");
  const { limit, offset } = c.req.valid("query");
  const list = await taskService.list(user.id, limit, offset);
  return c.json({ data: list });
});

/** `GET /tasks/:id` — get a single task by ID. */
tasks.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const task = await taskService.get(id, user.id);
  return c.json({ data: task });
});

export { tasks as tasksRoute };
