// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Hono } from "hono";
import { z } from "zod";
import { MAX_TIMELINE_ASSET_PAGE_SIZE } from "@breatic/shared";
import { projectAssetReferenceService } from "@breatic/core";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@server/middleware/validate.js";

const projectAssets = new Hono<{ Variables: AuthVariables }>();
const projectParams = z.object({ projectId: z.uuid() });
const assetParams = projectParams.extend({ assetId: z.uuid() });
const videoQuery = z.object({
  kind: z.literal("video").default("video"),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().positive().max(MAX_TIMELINE_ASSET_PAGE_SIZE).optional(),
});

projectAssets.get("/:projectId/assets", requireAuth, validate("param", projectParams), validate("query", videoQuery), async (c) => {
  const { projectId } = c.req.valid("param");
  const { cursor, limit } = c.req.valid("query");
  const page = await projectAssetReferenceService.listProjectVideos({ projectId, userId: c.get("user").id, cursor, limit });
  return c.json({ data: page });
});

projectAssets.get("/:projectId/assets/:assetId", requireAuth, validate("param", assetParams), async (c) => {
  const { projectId, assetId } = c.req.valid("param");
  const asset = await projectAssetReferenceService.resolveProjectAsset({ projectId, assetId, userId: c.get("user").id });
  return c.json({ data: asset });
});

projectAssets.get("/:projectId/timeline-limits", requireAuth, validate("param", projectParams), async (c) => {
  const { projectId } = c.req.valid("param");
  return c.json({ data: await projectAssetReferenceService.getTimelineLimits(projectId, c.get("user").id) });
});

export { projectAssets as projectAssetsRoute };
