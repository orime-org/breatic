// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio routes — the container shell (slice 1).
 *
 * Two endpoints, both authenticated:
 *   - `GET /api/v1/studios`        — the current user's studios (switcher).
 *   - `GET /api/v1/studio/:slug`   — one studio's public-facing shell.
 *
 * The shell is visible to any authenticated user (decision A — a studio's
 * `/studio/{slug}` page is its front door): a non-member gets a `200` with
 * `myStudioRole: null` (a guest), NOT a `403`. A slug with no active studio
 * surfaces as `NotFoundError` → `404` via the global error handler.
 *
 * Translation layer only (prohibition #1): map the request to a
 * `studioService` call and wrap the result in the `{ data }` envelope.
 */

import { Hono } from "hono";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { studioService } from "@server/modules";

const studios = new Hono<{ Variables: AuthVariables }>();

studios.use(requireAuth);

/**
 * `GET /api/v1/studios` — every studio the current user is an active
 * member of, personal-first (the switcher list).
 * @returns `200` with `{ data: StudioSummary[] }`
 */
studios.get("/", async (c) => {
  const user = c.get("user");
  const data = await studioService.listUserStudios(user.id);
  return c.json({ data });
});

const studio = new Hono<{ Variables: AuthVariables }>();

studio.use(requireAuth);

/**
 * `GET /api/v1/studio/:slug` — one studio's public-facing shell, with the
 * viewing user's role (`admin` / `member` / `null` = guest).
 * @returns `200` with `{ data: StudioDetail }`; `404` when no active studio
 *   has that slug (service throws `NotFoundError`)
 */
studio.get("/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const data = await studioService.getStudioDetail(slug, user.id);
  return c.json({ data });
});

export { studios as studiosRoute, studio as studioRoute };
