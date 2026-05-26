/**
 * Authentication middleware.
 *
 * Extracts Bearer token from the Authorization header,
 * resolves it to a user via the session store, and sets
 * the user entity on the Hono context.
 */

import type { MiddlewareHandler } from "hono";
import { authService } from "@breatic/core";

/** Hono context variables set by auth middleware. */
export interface AuthVariables {
  user: {
    id: string;
    email: string;
    username: string | null;
    avatarUrl: string | null;
    credits: number;
  };
}

/**
 * Require authentication — returns 401 if token is missing or invalid.
 */
export const requireAuth: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: { code: 401, message: "Missing authorization token" } }, 401);
  }

  const token = authHeader.slice(7);
  const user = await authService.getUserByToken(token);

  if (!user) {
    return c.json({ error: { code: 401, message: "Invalid or expired token" } }, 401);
  }

  c.set("user", {
    id: user.id,
    email: user.email,
    username: user.username,
    avatarUrl: user.avatarUrl,
    credits: user.credits,
  });
  await next();
};
