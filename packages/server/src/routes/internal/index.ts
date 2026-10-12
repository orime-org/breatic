// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API's authorisation table (inner#1410 §4.3, §4.5): every
 * route the back office may call, by method and path. Anything else falls
 * to the app's `notFound`, which answers 403.
 *
 * Each route is one handler — no per-route middleware — so the table below
 * is exactly what `app.routes` lists. The handlers only translate HTTP into
 * the disposition service's calls.
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ValidationError } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { t } from "@breatic/shared";
import "@server/middleware/internal-auth.js";
import {
  preview,
  requestOneShot,
  requestRefund,
  resendMail,
  type Answer,
} from "@server/modules/credit-refund/disposition.service.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";

type Ctx = Context;

const LOT = "/internal/v1/credit-lots/:lotId/refund";
const RESEND = "/internal/v1/refund-operations/:operationId/mail/resend";

const reason = z.string().min(1).max(500);
const refundIds = z.array(z.string().min(1).max(255)).max(100);
const uuid = z.string().uuid();

const BODIES = {
  approve: z.object({ reason, confirmedRefundIds: refundIds }).strict(),
  retry: z.object({ reason, confirmedRefundIds: refundIds }).strict(),
  refund_again: z.object({ reason, failedRefundIds: refundIds, notify: z.boolean() }).strict(),
  reject: z.object({ reason }).strict(),
  send_back: z.object({ reason }).strict(),
  settle: z
    .object({
      reason,
      notify: z.boolean(),
      confirmedSucceededCents: z.number().int().nonnegative(),
      acceptPartial: z.boolean(),
    })
    .strict(),
  resolve_outside: z.object({ reason, failedRefundIds: refundIds }).strict(),
  resend: z.object({ reason }).strict(),
};

/** A write request, read and checked. */
interface Write<T> {
  body: T;
  key: string;
  hash: string;
  adminId: string;
}

/**
 * Read a write request: the path id, the JSON body against its schema, the
 * `Idempotency-Key` header, and the request's fingerprint.
 * @param c - The context.
 * @param template - The route's path template.
 * @param idParam - The path parameter naming the target.
 * @param schema - The body schema.
 * @returns The target id and the checked request.
 * @throws {HTTPException} 400 when the body is not JSON.
 * @throws {ValidationError} 422 when the id, body or key is malformed.
 */
async function readWrite<S extends z.ZodTypeAny>(
  c: Ctx,
  template: string,
  idParam: "lotId" | "operationId",
  schema: S,
): Promise<{ targetId: string } & Write<z.infer<S>>> {
  const targetId = readId(c, idParam);
  // The signature check already read the raw bytes; parse those.
  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    throw new HTTPException(400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(t("server.internal.invalid_body"));
  const key = c.req.header("idempotency-key");
  if (key === undefined || !creditLotService.REFKEY_PATTERN.test(key)) {
    throw new ValidationError(t("server.internal.invalid_idempotency_key"));
  }
  return {
    targetId,
    body: parsed.data,
    key,
    hash: fingerprint("POST", template, targetId, raw),
    adminId: c.get("internalAdmin"),
  };
}

/**
 * A uuid path parameter.
 * @param c - The context.
 * @param name - The parameter.
 * @returns Its value.
 * @throws {ValidationError} 422 when it is not a uuid.
 */
function readId(c: Ctx, name: "lotId" | "operationId"): string {
  const value = c.req.param(name);
  if (!uuid.safeParse(value).success) throw new ValidationError(t("server.internal.invalid_body"));
  return value!;
}

/**
 * Send a service answer.
 * @param c - The context.
 * @param answer - Status and body.
 * @returns The response.
 */
function send(c: Ctx, answer: Answer<unknown>): Response {
  return c.json(answer.body as object, answer.status);
}

/**
 * A handler for one of the endpoints that create a Stripe refund.
 * @param kind - approve, retry or refund_again.
 * @param template - Its path template.
 * @returns The handler.
 */
function createRefundRoute(kind: "approve" | "retry" | "refund_again", template: string) {
  return async (c: Ctx): Promise<Response> => {
    const w = await readWrite(c, template, "lotId", BODIES[kind]);
    const { reason: why, ...body } = w.body;
    return send(c, await requestRefund(kind, { lotId: w.targetId, adminId: w.adminId, key: w.key, hash: w.hash, reason: why }, body));
  };
}

/**
 * A handler for one of the endpoints that finish in their request.
 * @param kind - reject, settle, send_back or resolve_outside.
 * @param template - Its path template.
 * @returns The handler.
 */
function oneShotRoute(kind: "reject" | "settle" | "send_back" | "resolve_outside", template: string) {
  return async (c: Ctx): Promise<Response> => {
    const w = await readWrite(c, template, "lotId", BODIES[kind]);
    const { reason: why, ...body } = w.body;
    return send(c, await requestOneShot(kind, { lotId: w.targetId, adminId: w.adminId, key: w.key, hash: w.hash, reason: why }, body));
  };
}

/** The table: method, path template, handler. */
const ROUTES: { method: "get" | "post"; path: string; handler: (c: Ctx) => Promise<Response> }[] = [
  { method: "get", path: LOT, handler: async (c) => c.json(await preview(readId(c, "lotId")), 200) },
  { method: "post", path: `${LOT}/approve`, handler: createRefundRoute("approve", `${LOT}/approve`) },
  { method: "post", path: `${LOT}/retry`, handler: createRefundRoute("retry", `${LOT}/retry`) },
  { method: "post", path: `${LOT}/refund-again`, handler: createRefundRoute("refund_again", `${LOT}/refund-again`) },
  { method: "post", path: `${LOT}/reject`, handler: oneShotRoute("reject", `${LOT}/reject`) },
  { method: "post", path: `${LOT}/settle`, handler: oneShotRoute("settle", `${LOT}/settle`) },
  { method: "post", path: `${LOT}/send-back`, handler: oneShotRoute("send_back", `${LOT}/send-back`) },
  { method: "post", path: `${LOT}/resolved-outside`, handler: oneShotRoute("resolve_outside", `${LOT}/resolved-outside`) },
  {
    method: "post",
    path: RESEND,
    handler: async (c) => {
      const w = await readWrite(c, RESEND, "operationId", BODIES.resend);
      return send(c, await resendMail({ operationId: w.targetId, adminId: w.adminId, key: w.key, hash: w.hash, reason: w.body.reason }));
    },
  },
];

/**
 * Register the table on the internal app.
 * @param app - The internal app, after its rate limit and authentication.
 */
export function registerInternalRoutes(app: Hono): void {
  for (const route of ROUTES) app[route.method](route.path, route.handler);
}
