// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { Hono } from "hono";
import { z } from "zod";
import { ConflictError, createQueue, currentConsent, defaultJobOpts, logger, validate } from "@breatic/core";
import { miniToolAnalysisService, type MiniToolAnalysisJob } from "@breatic/domain";
import { MINI_TOOL_ANALYSIS_JOB, miniToolAnalysisRequestSchema } from "@breatic/shared/mini-tools";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { runOnce } from "@server/middleware/run-once.js";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";
import { explainHoldRefusal, reserveForRunIn } from "@server/modules";
import { startRowedRun } from "@server/modules/task/generation-task.js";

const analyses = new Hono<{ Variables: AuthVariables }>();
const tasksQueue = createQueue("tasks");
analyses.use("*", requireAuth);

analyses.post(
  "/",
  rateLimitFor("mini_tool", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", miniToolAnalysisRequestSchema),
  runOnce("mini-tool"),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    try {
      const record = await miniToolAnalysisService.accept(body, user.id, async (accepted) => {
        const job: MiniToolAnalysisJob = {
          taskId: body.analysisRunId, userId: user.id, projectId: body.projectId,
          spaceId: body.spaceId, hostNodeId: body.hostNodeId, source: "mini_tool",
          sourceKey: accepted.params.sourceKey, params: accepted.params,
          analyticsConsent: currentConsent(),
        };
        return startRowedRun({
          taskId: job.taskId, projectId: job.projectId, spaceId: job.spaceId,
          nodeIds: [job.hostNodeId], userId: job.userId, action: "mini_tool",
          label: body.kind,
          enqueue: () => tasksQueue.add(MINI_TOOL_ANALYSIS_JOB, job, { ...defaultJobOpts(), jobId: job.taskId }),
          settleFailure: async (reason) => {
            const record = await miniToolAnalysisService.failMiniToolAnalysisAdmission(job.taskId, { code: reason });
            return record.status === "completed" ? "completed" : "failed";
          },
          logTag: "mini_tool_analysis", logContext: { kind: body.kind },
        });
      }, (taskId, credits, tx) => reserveForRunIn(tx, body.projectId, user.id, taskId, credits));
      return c.json({ data: record }, 201);
    } catch (thrown) {
      const err = await explainHoldRefusal(thrown);
      logger.error({
        err,
        ctx: {
          userId: user.id, projectId: body.projectId, spaceId: body.spaceId,
          hostNodeId: body.hostNodeId, analysisRunId: body.analysisRunId, kind: body.kind,
        },
      }, err instanceof ConflictError ? "mini_tool_analysis_identity_conflict" : "mini_tool_analysis_admission_failed");
      throw err;
    }
  },
);

analyses.get("/:id", validate("param", z.object({ id: z.string().uuid() })), async (c) => {
  const record = await miniToolAnalysisService.get(c.req.valid("param").id, c.get("user").id);
  return c.json({ data: record });
});

export { analyses as miniToolAnalysesRoute };
