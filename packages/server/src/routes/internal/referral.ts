// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { Context, Hono } from "hono";
import { z } from "zod";
import { REFERRAL_CODE_INPUT_MAX } from "@breatic/shared";
import { withoutNul } from "@server/utils/without-nul.js";
import { requirePayments } from "@server/middleware/require-payments.js";
import { validate } from "@server/middleware/validate.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";
import * as referralAdmin from "@server/modules/referral/referral-admin.service.js";

const APPLICATIONS = "/internal/v1/promoter-applications";
const CODES = "/internal/v1/referral-codes";
const OPERATIONS = "/internal/v1/referral-operations";

const uuid = z.string().uuid();
const requestKey = z.string().regex(/^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const reason = withoutNul(z.string().min(1).max(500));
const idParam = z.object({ id: uuid });
const page = {
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
};

const approveBody = z.object({ reason, code: z.string().max(REFERRAL_CODE_INPUT_MAX).optional() }).strict();
const rejectBody = z.object({ reason, applicantNote: withoutNul(z.string().max(500)).optional() }).strict();
const codeBody = z.object({ reason }).strict();

/**
 * Sends a service answer as it is.
 * @param c - The request context.
 * @param answer - Status and body.
 * @returns The response.
 */
function send(c: Context, answer: referralAdmin.Answer): Response {
  return c.json(answer.body, answer.status);
}

/**
 * Reads what every back-office write carries besides its body.
 * @param c - The request context.
 * @param template - The route path, part of the fingerprint.
 * @param targetId - The application or code written to.
 * @param body - The validated body.
 * @param body.reason - Why, recorded with the request for the audit log.
 * @returns The write request, or null when the idempotency key is malformed.
 */
function writeRequest(c: Context, template: string, targetId: string, body: { reason: string }): referralAdmin.WriteRequest | null {
  const key = c.req.header("idempotency-key");
  if (!requestKey.safeParse(key).success) return null;
  const adminId = c.get("internalAdmin");
  c.set("internalReason", body.reason);
  return { key: key!, adminId, hash: fingerprint("POST", template, targetId, { adminId, body }) };
}

/**
 * Registers the referral program's back-office routes (inner#1868 §9).
 * @param app - The internal app.
 */
export function registerReferralRoutes(app: Hono): void {
  for (const base of [APPLICATIONS, CODES, OPERATIONS]) {
    app.use(base, requirePayments);
    app.use(`${base}/*`, requirePayments);
  }

  app.get(
    APPLICATIONS,
    validate("query", z.object({ status: z.enum(["pending", "approved", "rejected"]).optional(), ...page })),
    async (c) => c.json(await referralAdmin.applicationPage(c.req.valid("query")), 200),
  );
  app.get(`${APPLICATIONS}/:id`, validate("param", idParam), async (c) => send(c, await referralAdmin.application(c.req.valid("param").id)));

  app.post(`${APPLICATIONS}/:id/approve`, validate("param", idParam), validate("json", approveBody), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const req = writeRequest(c, `${APPLICATIONS}/:id/approve`, id, body);
    return req === null ? c.json({ code: "invalid_body" }, 422) : send(c, await referralAdmin.approve(id, body, req));
  });
  app.post(`${APPLICATIONS}/:id/reject`, validate("param", idParam), validate("json", rejectBody), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const req = writeRequest(c, `${APPLICATIONS}/:id/reject`, id, body);
    return req === null ? c.json({ code: "invalid_body" }, 422) : send(c, await referralAdmin.reject(id, body, req));
  });

  app.get(
    CODES,
    validate("query", z.object({ status: z.enum(["active", "disabled", "removed"]).optional(), ...page })),
    async (c) => c.json(await referralAdmin.codePage(c.req.valid("query")), 200),
  );
  for (const action of ["disable", "enable", "remove"] as const) {
    app.post(`${CODES}/:id/${action}`, validate("param", idParam), validate("json", codeBody), async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const req = writeRequest(c, `${CODES}/:id/${action}`, id, body);
      return req === null ? c.json({ code: "invalid_body" }, 422) : send(c, await referralAdmin.writeCode(action, id, body, req));
    });
  }

  app.get(`${OPERATIONS}/:key`, validate("param", z.object({ key: requestKey })), async (c) =>
    send(c, await referralAdmin.operation(c.req.valid("param").key)));
}
