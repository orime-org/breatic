// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Users routes — batch lookup for collaborator UI (v10 §7.2.6).
 *
 * The frontend calls `GET /api/v1/users?ids=u1,u2,u3` to render
 * member rows (avatar / display name / email) after `useProjectMembers`
 * returns the role relation. Capped at 100 ids per call to keep the
 * endpoint cheap.
 *
 * The display name comes from each user's personal studio `name` (the
 * name moved off `users` to the personal studio — email-registration
 * rewrite, 2026-06-06). Users mid-onboarding (no studio yet) fall back to
 * the email local-part.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { authService, studioService } from "@server/modules";

const users = new Hono<{ Variables: AuthVariables }>();

users.use(requireAuth);

const querySchema = z.object({
  /** Comma-separated UUIDs. */
  ids: z.string().min(1),
});

/**
 * `GET /api/v1/users?ids=u1,u2,u3` — batch user display info.
 *
 * Returns up to 100 rows in arbitrary order. Soft-deleted users are
 * excluded; missing ids are silently dropped (caller handles
 * "deleted account" placeholder UI).
 *
 * Returned shape strips sensitive fields — only id, email, username
 * (display name from the personal studio), avatar are returned. Credits
 * / emailVerified / googleId are NOT exposed via this endpoint. The
 * `username` wire field name is kept for frontend back-compat; its value
 * is now the personal studio `name` (or `null` when the user has not
 * finished onboarding).
 * @returns `200` with
 *   `{ data: Array<{ id, email, username, avatar_url }> }`
 */
users.get("/", zValidator("query", querySchema), async (c) => {
  const { ids: rawIds } = c.req.valid("query");
  const idList = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 100);

  const rows = await authService.getUsersByIds(idList);
  const names = await studioService.getPersonalStudioNamesByUserIds(
    rows.map((u) => u.id),
  );
  return c.json({
    data: rows.map((u) => ({
      id: u.id,
      email: u.email,
      username: names.get(u.id) ?? null,
      avatar_url: u.avatarUrl,
    })),
  });
});

export { users as usersRoute };
