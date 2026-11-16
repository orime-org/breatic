// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Maintenance endpoints mount exclusively after signed internal authentication.
 *
 * Storage reclaim works on one region's rows (inner#1955): the back office
 * calls the global region, names the region with `?region=` and the global
 * region hands the call to that region's own maintenance functions.
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { callRegion, env, getRegionsConfig, isGlobalRegion, isRegionUnavailable } from "@breatic/core";
import { validate } from "@server/middleware/validate.js";
import { maintenanceService } from "@server/modules/index.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";
const BASE = "/internal/v1/maintenance";
const uuid = z.string().uuid();
const key = z.string().regex(/^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const text = z.string().min(1).max(2048).refine(v => !v.includes("\0"));
const scope = z.object({
  id: uuid, storageKey: text, keptStorageKey: text
}).strict();
const ids = z.array(uuid).min(1).max(100).refine(v => new Set(v).size === v.length);
const items = z.array(scope).min(1).max(100).refine(v => new Set(v.map(i => i.id)).size === v.length);

/**
 * Send finite service replies without leaking implementation errors.
 * @param c - Signed context.
 * @param answer - Finite reply.
 * @returns HTTP response.
 */
function send(c: Context, answer: maintenanceService.MaintenanceAnswer<unknown>): Response {
  return c.json(answer.body as object, answer.status);
}

/**
 * Run one maintenance call in the region the request names: here, or in
 * another region through its `fn` region function when this is the global
 * region.
 * @param c - Signed context.
 * @param fn - The region function that runs the call in another region.
 * @param args - Its arguments.
 * @param here - The same call in this region.
 * @returns HTTP response: 422 for a region this deployment does not reach, 503 when it does not answer.
 * @throws {GlobalApiError} A region's refusal other than unavailability, a bug of ours.
 */
async function inRegion(
  c: Context,
  fn: string,
  args: unknown[],
  here: () => Promise<maintenanceService.MaintenanceAnswer<unknown>>,
): Promise<Response> {
  const region = c.req.query("region") ?? env.REGION;
  if (region === env.REGION) return send(c, await here());
  if (!isGlobalRegion(env) || !Object.hasOwn(env.REGION_API_URLS, region)) return c.json({ code: "invalid_body" }, 422);
  try {
    return send(c, (await callRegion(region, fn, args, getRegionsConfig().maintenance_forward_timeout_ms)) as maintenanceService.MaintenanceAnswer<unknown>);
  } catch (err) {
    if (isRegionUnavailable(err)) return c.json({ code: "unavailable" }, 503);
    throw err;
  }
}

/**
 * Register explicit internal-only queue and maintenance routes.
 * @param app - Authenticated internal app.
 */
export function registerMaintenanceRoutes(app: Hono): void {
  app.get(BASE + "/queue", (c) => inRegion(c, "maintenanceQueue", [], () => maintenanceService.queue()));
  app.get(BASE + "/reclaim/candidates", validate("query", z.object({
    pageSize: z.coerce.number().int().min(1).max(100).default(20), cursor: uuid.optional(), region: z.string().optional()
  }).strict()), async (c) => {
    const q = c.req.valid("query");
    return inRegion(c, "maintenanceCandidates", [q.pageSize, q.cursor], () => maintenanceService.candidates(q.pageSize, q.cursor));
  });
  app.post(BASE + "/reclaim/preview", validate("json", z.object({
    ids
  }).strict()), (c) => {
    const args = [c.req.valid("json").ids, c.get("internalAdmin")] as const;
    return inRegion(c, "maintenancePreview", [...args], () => maintenanceService.preview(...args));
  });
  app.post(BASE + "/reclaim/operations", validate("json", z.object({
    previewId: uuid, items
  }).strict()), async (c) => {
    const requestKey = c.req.header("idempotency-key");
    if (!key.safeParse(requestKey).success)
      return c.json({
        code: "invalid_body"
      }, 422);
    const body = c.req.valid("json");
    const requestedBy = c.get("internalAdmin");
    const submission = {
      key: requestKey!, requestedBy, ...body, hash: fingerprint("POST", BASE + "/reclaim/operations", requestedBy, body)
    };
    return inRegion(c, "maintenanceSubmit", [submission], () => maintenanceService.submit(submission));
  });
  app.get(BASE + "/reclaim/operations/:key", validate("param", z.object({
    key
  })), validate("query", z.object({
    runsPageSize: z.coerce.number().int().min(1).max(100).default(20), runsCursor: uuid.optional(), region: z.string().optional()
  }).strict()), (c) => {
    const query = c.req.valid("query");
    const args = [c.req.valid("param").key, query.runsPageSize, query.runsCursor] as const;
    return inRegion(c, "maintenanceOperation", [...args], () => maintenanceService.operation(...args));
  });
  app.get(BASE + "/reclaim/controls/:key", validate("param", z.object({
    key
  })), (c) => {
    const operationKey = c.req.valid("param").key;
    return inRegion(c, "maintenanceControlResult", [operationKey], () => maintenanceService.controlResult(operationKey));
  });
  app.post(BASE + "/reclaim/operations/:key/control", validate("param", z.object({
    key
  })), validate("json", z.object({
    action: z.enum(["pause", "resume"]), expectedVersion: z.number().int().positive()
  }).strict()), async (c) => {
    const requestKey = c.req.header("idempotency-key");
    if (!key.safeParse(requestKey).success)
      return c.json({
        code: "invalid_body"
      }, 422);
    const body = c.req.valid("json");
    const operationKey = c.req.valid("param").key;
    const requestedBy = c.get("internalAdmin");
    const request = {
      key: requestKey!, operationKey, requestedBy, ...body, hash: fingerprint("POST", BASE + "/reclaim/operations/:key/control", operationKey, {
        ...body, requestedBy
      })
    };
    return inRegion(c, "maintenanceControl", [request], () => maintenanceService.control(request));
  });
  app.post(BASE + "/reclaim/operations/:key/resume", validate("param", z.object({
    key
  })), validate("json", z.object({
    expectedVersion: z.number().int().positive()
  }).strict()), async (c) => {
    const requestKey = c.req.header("idempotency-key");
    if (!key.safeParse(requestKey).success)
      return c.json({
        code: "invalid_body"
      }, 422);
    const body = c.req.valid("json");
    const operationKey = c.req.valid("param").key;
    const requestedBy = c.get("internalAdmin");
    const request = {
      key: requestKey!, operationKey, requestedBy, ...body, action: "resume" as const, firstRunResume: true, hash: fingerprint("POST", BASE + "/reclaim/operations/:key/resume", operationKey, {
        ...body, requestedBy
      })
    };
    return inRegion(c, "maintenanceControl", [request], () => maintenanceService.control(request));
  });
}
