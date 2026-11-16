// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The global API (inner#1955): `POST /internal/global/<fn>` with
 * `{ "args": [...] }`, answered `{ "result": ... }`. Other regions reach the
 * global functions only through here; the request is signed like every
 * internal API request, with the admin id `region-<code>` of the calling
 * region. Only the global region serves it. `POST /internal/region/<fn>` is
 * the same request aimed the other way: the global region calling one
 * region's functions.
 */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { AppError, env, isGlobalRegion } from "@breatic/core";
import { GLOBAL_FUNCTIONS, REGION_FUNCTIONS } from "@breatic/domain";
import { SERVER_REGION_FUNCTIONS } from "@server/modules/region/region-functions.js";
import { REGION_ADMIN } from "@server/middleware/internal-auth.js";
import { validate } from "@server/middleware/validate.js";

const bodySchema = z.object({ args: z.array(z.unknown()) }).strict();

/** A set of functions served to other regions by name. */
type Served = Record<string, (...args: never[]) => Promise<unknown>>;

/**
 * Run one served function for a signed caller.
 * @param c - The request context, after validation.
 * @param functions - The functions served here.
 * @param allowed - Whether this process serves them to this caller.
 * @returns `{ result }`, or the refusal.
 */
async function serve(c: Context, functions: Served, allowed: boolean): Promise<Response> {
  if (!allowed) return c.json({ code: "forbidden" }, 403);
  const name = c.req.param("fn") ?? "";
  if (!Object.hasOwn(functions, name)) return c.json({ code: "unknown_function" }, 404);
  const fn = functions[name] as (...args: unknown[]) => Promise<unknown>;
  const { args } = (c.req.valid as (target: "json") => z.infer<typeof bodySchema>)("json");
  try {
    return c.json({ result: (await fn(...args)) ?? null });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.reason ?? "refused", message: err.message }, err.statusCode as 400);
    }
    throw err;
  }
}

/**
 * Mount the global API, and the region API the global region calls, on the internal app.
 * @param app - The internal app.
 */
export function registerGlobalApiRoutes(app: Hono): void {
  app.post("/internal/global/:fn", validate("json", bodySchema), (c) =>
    serve(c, GLOBAL_FUNCTIONS, isGlobalRegion(env) && REGION_ADMIN.test(c.get("internalAdmin"))),
  );
  // Only the global region calls a region's functions.
  app.post("/internal/region/:fn", validate("json", bodySchema), (c) =>
    serve(c, { ...REGION_FUNCTIONS, ...SERVER_REGION_FUNCTIONS }, c.get("internalAdmin") === `region-${env.GLOBAL_REGION}`),
  );
}
