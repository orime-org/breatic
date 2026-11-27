// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { Hono } from "hono";
import { z } from "zod";
import { MAX_TIMELINE_ASSET_PAGE_SIZE } from "@breatic/shared";
import { projectAssetReferenceService, validate } from "@breatic/core";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";

const projectAssets = new Hono<{ Variables: AuthVariables }>();
const projectParams = z.object({ projectId: z.uuid() });
const mediaQuery = z.object({
  kind: z.enum(["image", "video"]).default("video"),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().positive().max(MAX_TIMELINE_ASSET_PAGE_SIZE).optional(),
});

projectAssets.get("/:projectId/assets", requireAuth, validate("param", projectParams), validate("query", mediaQuery), async (c) => {
  const { projectId } = c.req.valid("param");
  const { kind, cursor, limit } = c.req.valid("query");
  const page = await projectAssetReferenceService.listProjectMedia({ projectId, userId: c.get("user").id, kind, cursor, limit });
  return c.json({ data: page });
});

projectAssets.get("/:projectId/timeline-limits", requireAuth, validate("param", projectParams), async (c) => {
  const { projectId } = c.req.valid("param");
  return c.json({ data: await projectAssetReferenceService.getTimelineLimits(projectId, c.get("user").id) });
});

export { projectAssets as projectAssetsRoute };
