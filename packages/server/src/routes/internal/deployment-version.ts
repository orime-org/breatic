// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Hono } from "hono";
import { logger } from "@breatic/core";
import { getDeploymentVersion } from "@server/modules/deployment/deployment-version.service.js";

/**
 * Register the authenticated server identity endpoint on the internal listener.
 * @param app - The authenticated internal app.
 */
export function registerDeploymentVersionRoute(app: Hono): void {
  app.get("/internal/v1/deployment-version", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await getDeploymentVersion());
    } catch (err) {
      logger.warn({ err }, "deployment_version_unavailable");
      return c.json({ code: "deployment_version_unavailable" }, 503);
    }
  });
}
