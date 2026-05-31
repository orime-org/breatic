/**
 * Project role middleware (v10 §7.2.3).
 *
 * Routes that operate on a project gate themselves with
 * `requireRole(min)` — the middleware loads the caller's effective
 * role on the project (via `projectAuthService.loadProjectRole`),
 * compares against the minimum, and either rejects with 403 or
 * stamps the role on `c.var.role` for the handler to consume.
 *
 * Both "no such project" and "user has no membership" collapse to
 * `403 Forbidden`. Distinguishing them with `404` would leak project
 * existence to outsiders who guess UUIDs (BUG-048 class).
 *
 * The middleware reads `:pid` from the route param. Routes that use
 * a different param name (e.g. `:id` on the legacy `projects.ts`
 * routes) should re-mount with `requireRoleOnParam('id', 'edit')`.
 */

import type { Context, MiddlewareHandler } from "hono";
import { projectAuthService } from "@breatic/core";
import { ForbiddenError } from "@breatic/core";
import { ROLE_RANK, t } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";
import type { AuthVariables } from "@server/middleware/auth.js";

/** Variables stamped on `c` by `requireRole`. */
export interface RoleVariables {
  /** Project UUID resolved from the route param. */
  projectId: string;
  /** The caller's role on `projectId`. */
  role: ProjectRole;
}

/** Combined variable surface used by handlers downstream of the middleware. */
export type AuthRoleVariables = AuthVariables & RoleVariables;

/**
 * Build a middleware that requires the caller to have at least
 * `min` role on the project named by route param `paramName`.
 */
export function requireRoleOnParam(
  paramName: string,
  min: ProjectRole,
): MiddlewareHandler<{ Variables: AuthRoleVariables }> {
  return async (c, next) => {
    const userId = c.get("user").id;
    const projectId = c.req.param(paramName);
    if (!projectId) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }

    const role = await projectAuthService.loadProjectRole(userId, projectId);
    if (role === null) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }
    if (ROLE_RANK[role] < ROLE_RANK[min]) {
      throw new ForbiddenError(t("server.error.forbidden"));
    }

    c.set("projectId", projectId);
    c.set("role", role);
    await next();
  };
}

/**
 * `requireRole(min)` — middleware preset for routes that take the
 * project UUID under route param `:pid`. Routes that don't use
 * `:pid` should call {@link requireRoleOnParam} directly.
 */
export function requireRole(
  min: ProjectRole,
): MiddlewareHandler<{ Variables: AuthRoleVariables }> {
  return requireRoleOnParam("pid", min);
}

/**
 * Helper for routes that already loaded the role and want to read
 * it back without re-querying.
 */
export function getRole(c: Context<{ Variables: AuthRoleVariables }>): ProjectRole {
  return c.get("role");
}

/**
 * Read the project UUID that {@link requireRole} validated + stamped.
 *
 * Routes behind `requireRole(...)` should use this instead of
 * `c.req.param("pid") as string`: the cast is both redundant (the
 * middleware already resolved + validated the param) and dishonest
 * (it asserts non-undefined where the typed `c.var.projectId` proves
 * it). Only valid downstream of `requireRole` / `requireRoleOnParam`.
 */
export function getProjectId(c: Context<{ Variables: AuthRoleVariables }>): string {
  return c.get("projectId");
}
