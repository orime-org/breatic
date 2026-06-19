// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio-role gate (slice 3) — mirrors `requireRole` (project) for studio
 * member-management routes. Resolves the studio by its `:slug` route param,
 * loads the caller's studio role, and rejects anyone below `min` with a
 * generic 403 (which also hides studio existence from non-members). The member
 * routes all require 'admin': studio credits are shared, so only the admin
 * governs membership.
 */

import type { MiddlewareHandler } from "hono";
import { ForbiddenError } from "@breatic/core";
import { studioAuthService } from "@breatic/domain";
import { studioService } from "@server/modules";
import { t } from "@breatic/shared";
import type { AuthVariables } from "@server/middleware/auth.js";
import type { StudioRole } from "@breatic/shared";

const STUDIO_ROLE_RANK: Record<StudioRole, number> = {
  admin: 3,
  maintainer: 2,
  guest: 1,
};

/**
 * `requireStudioRole(min)` — gate a studio route (param `:slug`) on the caller
 * having at least `min` studio role.
 * @param min - Minimum studio role required to pass the gate
 * @returns A Hono middleware bound to the `:slug` route param
 * @throws {ForbiddenError} slug missing, studio not found (existence hidden),
 *   caller is not a member, or their role is below `min`
 */
export function requireStudioRole(
  min: StudioRole,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const userId = c.get("user").id;
    const slug = c.req.param("slug");
    if (!slug) throw new ForbiddenError(t("server.error.forbidden"));
    const studio = await studioService.getStudioBySlug(slug);
    if (!studio) throw new ForbiddenError(t("server.error.forbidden"));
    const role = await studioAuthService.loadStudioRole(userId, studio.id);
    if (role === null || STUDIO_ROLE_RANK[role] < STUDIO_ROLE_RANK[min]) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    await next();
  };
}
