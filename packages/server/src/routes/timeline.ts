// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Timeline executions (inner#1711 design §4): accept a web-animation execution, list a Space's executions, resolve
 * the sources a Project's web clips reference, cancel an execution and sign a preview address.
 */

import { Hono } from "hono";
import { z } from "zod";
import { TimelineExecutionCreateInputSchema } from "@breatic/shared/space-content";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { runOnce } from "@server/middleware/run-once.js";
import { validate } from "@server/middleware/validate.js";
import { timelineExecutionService } from "@server/modules";
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

timeline.post(
  "/executions",
  rateLimitFor("timeline_execution", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", TimelineExecutionCreateInputSchema.extend({ projectId: z.uuid() })),
  runOnce("timeline-execution"),
  async (c) => {
    const { row, created } = await timelineExecutionService.accept(c.get("user").id, c.req.valid("json"));
    return c.json({ data: row }, created ? 201 : 200);
  },
);

timeline.get("/executions", validate("query", spaceQuery), async (c) => {
  const { projectId, spaceId } = c.req.valid("query");
  return c.json({ data: await timelineExecutionService.list(c.get("user").id, projectId, spaceId) });
});

timeline.get("/web-sources", validate("query", webSourcesQuery), async (c) => {
  const { projectId, sourceIds, executionIds } = c.req.valid("query");
  return c.json({ data: await timelineExecutionService.resolveWebSources(c.get("user").id, projectId, sourceIds, executionIds) });
});

timeline.post(
  "/executions/:id/cancel",
  validate("header", idempotencyKeyHeaderSchema),
  validate("param", idParam),
  async (c) => {
    return c.json({ data: await timelineExecutionService.cancel(c.get("user").id, c.req.valid("param").id) });
  },
);

timeline.get("/sources/:id/preview", validate("param", idParam), validate("query", projectQuery), async (c) => {
  const url = await timelineExecutionService.previewUrl(c.get("user").id, c.req.valid("param").id, c.req.valid("query").projectId);
  return c.json({ data: { url } });
});

export { timeline as timelineRoute };
