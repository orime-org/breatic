/**
 * Users routes — batch lookup for collaborator UI (v10 §7.2.6).
 *
 * The frontend calls `GET /api/v1/users?ids=u1,u2,u3` to render
 * member rows (avatar / username / email) after `useProjectMembers`
 * returns the role relation. Capped at 100 ids per call to keep the
 * endpoint cheap.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import * as userRepo from "@server/modules/user.repo.js";

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
 * Returned shape strips sensitive fields — only id, email, username,
 * avatar are returned. Credits / emailVerified / googleId are NOT
 * exposed via this endpoint.
 *
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

  const rows = await userRepo.getUsersByIds(idList);
  return c.json({
    data: rows.map((u) => ({
      id: u.id,
      email: u.email,
      username: u.username,
      avatar_url: u.avatarUrl,
    })),
  });
});

export { users as usersRoute };
