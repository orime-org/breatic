/**
 * Authentication middleware.
 *
 * Extracts Bearer token from the Authorization header,
 * resolves it to a user via the session store, and sets
 * the user entity on the Hono context.
 */

import type { MiddlewareHandler } from "hono";
import { authService, env, rawPg } from "@breatic/core";

/** Hono context variables set by auth middleware. */
export interface AuthVariables {
  user: { id: string; email: string };
}

/** Default dev user for NoAccount mode (valid UUID for DB compatibility). */
const DEV_USER = { id: "00000000-0000-0000-0000-000000000000", email: "dev@localhost" };

/** Ensure the dev user row exists in the DB (NoAccount mode only, runs once). */
let devUserEnsured = false;
async function ensureDevUser(): Promise<void> {
  if (devUserEnsured || env.LOGIN_MODE !== "NoAccount") return;
  await rawPg`
    INSERT INTO users (id, email, username, email_verified, credits)
    VALUES (${DEV_USER.id}, ${DEV_USER.email}, 'Dev User', true, 99999)
    ON CONFLICT (id) DO NOTHING
  `;
  devUserEnsured = true;
}

/**
 * Require authentication — returns 401 if token is missing or invalid.
 *
 * In `NoAccount` mode (LOGIN_MODE=NoAccount), authentication is skipped
 * and a default dev user is injected. This is for local development only.
 */
export const requireAuth: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  // NoAccount mode: skip auth, inject dev user.
  if (env.LOGIN_MODE === "NoAccount") {
    await ensureDevUser();
    c.set("user", DEV_USER);
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: { code: 401, message: "Missing authorization token" } }, 401);
  }

  const token = authHeader.slice(7);
  const user = await authService.getUserByToken(token);

  if (!user) {
    return c.json({ error: { code: 401, message: "Invalid or expired token" } }, 401);
  }

  c.set("user", { id: user.id, email: user.email });
  await next();
};
