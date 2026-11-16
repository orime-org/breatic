// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/directory` — which region a Studio or Project lives in (inner#1955), read
 * from the global directory so the browser can pick that region's addresses
 * before it asks for the Studio or Project itself.
 */

import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError, studioDirectoryRepo } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@server/middleware/validate.js";

const directory = new Hono<{ Variables: AuthVariables }>();

directory.use(requireAuth);

directory.get("/studios/:slug", validate("param", z.object({ slug: z.string().min(1).max(64) })), async (c) => {
  const found = await studioDirectoryRepo.findRegionBySlug(c.req.valid("param").slug);
  if (found === undefined) throw new NotFoundError(t("server.error.not_found"));
  return c.json({ data: { region: found.region } });
});

directory.get("/projects/:id", validate("param", z.object({ id: z.string().uuid() })), async (c) => {
  const found = await studioDirectoryRepo.findProject(c.req.valid("param").id);
  if (found === null) throw new NotFoundError(t("server.project.not_found"));
  return c.json({ data: { region: found.region } });
});

export { directory as directoryRoute };
