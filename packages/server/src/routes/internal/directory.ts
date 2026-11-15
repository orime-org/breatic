// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Directory repair for the back office (inner#1955): served by the global
 * region alone, which holds the directory.
 */

import type { Hono } from "hono";
import { z } from "zod";
import { env, isGlobalRegion, isRegionUnavailable, logger } from "@breatic/core";
import { validate } from "@server/middleware/validate.js";
import { repairStudioDirectory } from "@server/modules/region/directory-repair.js";

const params = z.object({ studioId: z.string().uuid() });

/**
 * Mount the repair route in the global region.
 * @param app - The internal app, after its rate limit and authentication.
 */
export function registerDirectoryRoutes(app: Hono): void {
  if (!isGlobalRegion(env)) return;
  app.post("/internal/v1/directory/studios/:studioId/snapshot", validate("param", params), async (c) => {
    const { studioId } = c.req.valid("param");
    try {
      const outcome = await repairStudioDirectory(studioId);
      return outcome === "not_found" ? c.json({ code: "not_found" }, 404) : c.json({ status: "emitted" }, 200);
    } catch (err) {
      if (!isRegionUnavailable(err)) throw err;
      logger.error({ err, ctx: { studioId } }, "directory_repair_region_unavailable");
      return c.json({ code: "region_unavailable" }, 503);
    }
  });
}
