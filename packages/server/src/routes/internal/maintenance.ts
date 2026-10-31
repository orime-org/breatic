// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Maintenance endpoints mount exclusively after signed internal authentication.
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
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
 * Register explicit internal-only queue and maintenance routes.
 * @param app - Authenticated internal app.
 */
export function registerMaintenanceRoutes(app: Hono): void {
  app.get(BASE + "/queue", async (c) => send(c, await maintenanceService.queue()));
  app.get(BASE + "/reclaim/candidates", validate("query", z.object({
    pageSize: z.coerce.number().int().min(1).max(100).default(20), cursor: uuid.optional()
  }).strict()), async (c) => {
    const q = c.req.valid("query");
    return send(c, await maintenanceService.candidates(q.pageSize, q.cursor));
  });
  app.post(BASE + "/reclaim/preview", validate("json", z.object({
    ids
  }).strict()), async (c) => send(c, await maintenanceService.preview(c.req.valid("json").ids, c.get("internalAdmin"))));
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
    return send(c, await maintenanceService.submit({
      key: requestKey!, requestedBy, ...body, hash: fingerprint("POST", BASE + "/reclaim/operations", requestedBy, body)
    }));
  });
  app.get(BASE + "/reclaim/operations/:key", validate("param", z.object({
    key
  })), validate("query", z.object({
    runsPageSize: z.coerce.number().int().min(1).max(100).default(20), runsCursor: uuid.optional()
  }).strict()), async (c) => {
    const query = c.req.valid("query");
    return send(c, await maintenanceService.operation(c.req.valid("param").key, query.runsPageSize, query.runsCursor));
  });
  app.get(BASE + "/reclaim/controls/:key", validate("param", z.object({
    key
  })), async (c) => send(c, await maintenanceService.controlResult(c.req.valid("param").key)));
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
    return send(c, await maintenanceService.control({
      key: requestKey!, operationKey, requestedBy, ...body, hash: fingerprint("POST", BASE + "/reclaim/operations/:key/control", operationKey, {
        ...body, requestedBy
      })
    }));
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
    return send(c, await maintenanceService.control({
      key: requestKey!, operationKey, requestedBy, ...body, action: "resume", firstRunResume: true, hash: fingerprint("POST", BASE + "/reclaim/operations/:key/resume", operationKey, {
        ...body, requestedBy
      })
    }));
  });
}
