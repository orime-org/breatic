// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API's authorisation table (inner#1410 §4.3, §4.5): every
 * route the back office may call, by method and path. Anything else falls
 * to the app's `notFound`, which answers 403.
 *
 * The handlers only translate HTTP into the disposition service's calls; a
 * write's body is checked by `validate` before its handler runs.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { creditLotService } from "@breatic/domain";
import "@server/middleware/internal-auth.js";
import { validate } from "@server/middleware/validate.js";
import {
  preview,
  requestOneShot,
  requestRefund,
  resendMail,
  type Answer,
  type WriteRequest,
} from "@server/modules/credit-refund/disposition.service.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";
import { RefundRefusal } from "@server/modules/credit-refund/refusal.js";
import { registerEnterpriseMembershipRoutes } from "@server/routes/internal/enterprise-membership.js";

const LOT = "/internal/v1/credit-lots/:lotId/refund";
const RESEND = "/internal/v1/refund-operations/:operationId/mail/resend";

/**
 * A non-empty string field. Postgres text cannot hold NUL, so a NUL is
 * refused here as a malformed body.
 * @param max - The longest value accepted.
 * @returns The schema.
 */
function text(max: number): z.ZodType<string> {
  return z.string().min(1).max(max).refine((s) => !s.includes("\u0000"));
}
const reason = text(500);
const refundIds = z.array(text(255)).max(100);
const uuid = z.string().uuid();

const BODIES = {
  approve: z.object({ reason, confirmedRefundIds: refundIds }).strict(),
  retry: z.object({ reason, confirmedRefundIds: refundIds }).strict(),
  reject: z.object({ reason }).strict(),
  send_back: z.object({ reason }).strict(),
  settle: z
    .object({
      reason,
      notify: z.boolean(),
      confirmedSucceededCents: z.number().int().nonnegative(),
    })
    .strict(),
  resolve_outside: z
    .object({ reason, failedRefundIds: refundIds, confirmedSucceededCents: z.number().int().nonnegative() })
    .strict(),
  restore_credits: z.object({ reason, failedRefundIds: refundIds }).strict(),
  resend: z.object({ reason }).strict(),
};

type BodyKind = keyof typeof BODIES;
type Body<K extends BodyKind> = z.infer<(typeof BODIES)[K]>;

/**
 * The checked parts of a write request: the target in the path, the
 * `Idempotency-Key` header and the fingerprint over both and the body. The
 * operator's reason is put on the context for the request's log line.
 * @param c - The context, after `validate`.
 * @param template - The route's path template.
 * @param idParam - The path parameter naming the target.
 * @param body - The validated body.
 * @param body.reason - Why, as the operator wrote it.
 * @returns The request as the service reads it, plus the target id.
 * @throws {RefundRefusal} 422 when the id or the key is malformed.
 */
function readWrite(
  c: Context,
  template: string,
  idParam: "lotId" | "operationId",
  body: { reason: string },
): Omit<WriteRequest, "lotId"> & { targetId: string } {
  c.set("internalReason", body.reason);
  const targetId = readId(c, idParam);
  const key = c.req.header("idempotency-key");
  if (key === undefined || !creditLotService.REFKEY_PATTERN.test(key)) {
    throw new RefundRefusal(422, "invalid_body", "invalid_idempotency_key");
  }
  return {
    targetId,
    key,
    hash: fingerprint("POST", template, targetId, body),
    adminId: c.get("internalAdmin"),
    reason: body.reason,
  };
}

/**
 * A uuid path parameter.
 * @param c - The context.
 * @param name - The parameter.
 * @returns Its value.
 * @throws {RefundRefusal} 422 when it is not a uuid.
 */
function readId(c: Context, name: "lotId" | "operationId"): string {
  const value = c.req.param(name);
  if (!uuid.safeParse(value).success) throw new RefundRefusal(422, "invalid_body", "invalid_body");
  return value!;
}

/**
 * Send a service answer.
 * @param c - The context.
 * @param answer - Status and body.
 * @returns The response.
 */
function send(c: Context, answer: Answer<unknown>): Response {
  return c.json(answer.body as object, answer.status);
}

/** One row of the table. */
interface Route {
  method: "get" | "post";
  path: string;
  handlers: MiddlewareHandler[];
}

/**
 * A write on a lot: validate the body, then hand the request to the service.
 * @param kind - The body schema and the disposition kind.
 * @param path - The path template, which is also what the fingerprint names.
 * @param run - The service call, given the kind.
 * @returns The route.
 */
function lotWrite<K extends Exclude<BodyKind, "resend">>(
  kind: K,
  path: string,
  run: (kind: K, req: WriteRequest, rest: Omit<Body<K>, "reason">) => Promise<Answer<unknown>>,
): Route {
  /**
   * Read the request and call the service.
   * @param c - The context, after `validate`.
   * @returns The service's answer.
   */
  const handler = async (c: Context): Promise<Response> => {
    const body = (c.req.valid as (target: "json") => Body<K>)("json");
    const { targetId, ...req } = readWrite(c, path, "lotId", body);
    const { reason: _reason, ...rest } = body;
    return send(c, await run(kind, { ...req, lotId: targetId }, rest));
  };
  return { method: "post", path, handlers: [validate("json", BODIES[kind]), handler] };
}

/** The table: method, path template, handlers. */
const ROUTES: Route[] = [
  {
    method: "get",
    path: LOT,
    handlers: [async (c) => c.json(await preview(readId(c, "lotId")), 200)],
  },
  lotWrite("approve", `${LOT}/approve`, requestRefund),
  lotWrite("retry", `${LOT}/retry`, requestRefund),
  lotWrite("reject", `${LOT}/reject`, requestOneShot),
  lotWrite("settle", `${LOT}/settle`, requestOneShot),
  lotWrite("send_back", `${LOT}/send-back`, requestOneShot),
  lotWrite("resolve_outside", `${LOT}/resolved-outside`, requestOneShot),
  lotWrite("restore_credits", `${LOT}/restore-credits`, requestOneShot),
  {
    method: "post",
    path: RESEND,
    handlers: [
      validate("json", BODIES.resend),
      async (c) => {
        const body = (c.req.valid as (target: "json") => Body<"resend">)("json");
        const { targetId, ...req } = readWrite(c, RESEND, "operationId", body);
        return send(c, await resendMail({ ...req, operationId: targetId }));
      },
    ],
  },
];

/**
 * Register the table on the internal app.
 * @param app - The internal app, after its rate limit and authentication.
 */
export function registerInternalRoutes(app: Hono): void {
  for (const route of ROUTES) app.on(route.method.toUpperCase(), [route.path], ...route.handlers);
  registerEnterpriseMembershipRoutes(app);
}
