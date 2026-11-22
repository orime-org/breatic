// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from "hono";
import { z } from "zod";
import { miniToolExecutionService } from "@breatic/domain";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@breatic/core";

const miniToolRuns = new Hono<{ Variables: AuthVariables }>();
miniToolRuns.use(requireAuth);
miniToolRuns.get("/:runId", validate("param", z.object({ projectId: z.uuid(), runId: z.uuid() })), async (c) => {
  const { projectId, runId } = c.req.valid("param");
  const data = await miniToolExecutionService.getMiniToolExecution(projectId, runId, c.get("user").id);
  return c.json({ data });
});
export { miniToolRuns as miniToolRunsRoute };
