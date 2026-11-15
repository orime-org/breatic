// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web-animation executions (inner#1711 design §4; #1490 design §4.4): accept a create, modification or export, list a
 * Motion Space's executions and the Timeline-made group, list the Project's results for the Timeline picker, read one
 * execution, resolve the sources a Project's web clips reference, cancel an execution and sign a preview address. The
 * paths keep their Timeline names, because tabs already deployed call them.
 */

import { Hono } from "hono";
import { z } from "zod";
import { WebAnimationExecutionRequestSchema } from "@breatic/shared/space-content";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { runOnce } from "@server/middleware/run-once.js";
import { validate } from "@server/middleware/validate.js";
import { webAnimationExecutionService as executions } from "@server/modules";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";

const timeline = new Hono<{ Variables: AuthVariables }>();

timeline.use("*", requireAuth);

/** The most ids one resolution may ask about: far more web clips than one Timeline holds. */
const MAX_RESOLVED_IDS = 500;

/** A comma-separated list of uuids in a query parameter; absent or empty reads as none. */
const idList = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value === "" ? [] : value.split(",")))
  .pipe(z.array(z.uuid()).max(MAX_RESOLVED_IDS));

const spaceQuery = z.object({ projectId: z.uuid(), spaceId: z.uuid() });
const webSourcesQuery = z.object({ projectId: z.uuid(), sourceIds: idList, executionIds: idList });
const idParam = z.object({ id: z.uuid() });
const projectQuery = z.object({ projectId: z.uuid() });
const page = { cursor: z.string().min(1).max(500).optional(), limit: z.coerce.number().int().positive().optional() };
const spaceExecutionsQuery = z.object({
  projectId: z.uuid(), spaceId: z.uuid(), scope: z.enum(["space", "timeline"]), group: z.enum(["done", "running"]), ...page,
});
const resultsQuery = z.object({ projectId: z.uuid(), ...page });
const cancelBody = z.object({ projectId: z.uuid().optional() });
/** The Project the route takes, apart from the request the shared schema reads strictly. */
const acceptBody = z.object({ projectId: z.uuid() }).loose()
  .transform(({ projectId, ...request }) => ({ projectId, request }))
  .pipe(z.object({ projectId: z.uuid(), request: WebAnimationExecutionRequestSchema }));

timeline.post(
  "/executions",
  rateLimitFor("timeline_execution", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", acceptBody),
  runOnce("timeline-execution"),
  async (c) => {
    const { projectId, request } = c.req.valid("json");
    const { row, created } = await executions.accept(c.get("user").id, { ...request, projectId });
    return c.json({ data: row }, created ? 201 : 200);
  },
);

// Kept for the older tabs of the deploy window: they read this array for their list and tab status. Removed in the
// next release, with the kind-less create the accept route still takes.
timeline.get("/executions", validate("query", spaceQuery), async (c) => {
  const { projectId, spaceId } = c.req.valid("query");
  return c.json({ data: await executions.list(c.get("user").id, projectId, spaceId) });
});

timeline.get("/space-executions", validate("query", spaceExecutionsQuery), async (c) => {
  return c.json({ data: await executions.listSpace(c.get("user").id, c.req.valid("query")) });
});

timeline.get("/results", validate("query", resultsQuery), async (c) => {
  return c.json({ data: await executions.listResults(c.get("user").id, c.req.valid("query")) });
});

timeline.get("/executions/:id", validate("param", idParam), validate("query", spaceQuery), async (c) => {
  const { projectId, spaceId } = c.req.valid("query");
  return c.json({ data: await executions.getOne(c.get("user").id, c.req.valid("param").id, projectId, spaceId) });
});

timeline.get("/web-sources", validate("query", webSourcesQuery), async (c) => {
  const { projectId, sourceIds, executionIds } = c.req.valid("query");
  return c.json({ data: await executions.resolveWebSources(c.get("user").id, projectId, sourceIds, executionIds) });
});

timeline.post(
  "/executions/:id/cancel",
  validate("header", idempotencyKeyHeaderSchema),
  validate("param", idParam),
  validate("json", cancelBody),
  async (c) => {
    return c.json({ data: await executions.cancel(c.get("user").id, c.req.valid("param").id, c.req.valid("json").projectId) });
  },
);

timeline.get("/sources/:id/preview", validate("param", idParam), validate("query", projectQuery), async (c) => {
  const url = await executions.previewUrl(c.get("user").id, c.req.valid("param").id, c.req.valid("query").projectId);
  return c.json({ data: { url } });
});

export { timeline as timelineRoute };
