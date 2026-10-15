// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal app's error exit (inner#1410 §4.6): every thrown thing is
 * answered by who caused it, in the internal API's `{ code, detail }` shape,
 * never in the public app's `{ error: … }` shape.
 *
 * | thrown                         | answer                                  |
 * |--------------------------------|-----------------------------------------|
 * | RefundRefusal                  | its status, `{ code, detail }`, detail  |
 * |                                | is `server.internal.<detailKey>` in en  |
 * | ValidationError (validate())   | 422 invalid_body, detail is             |
 * |                                | `server.internal.invalid_body` in en    |
 * | HTTPException (unreadable body)| 400 invalid_body                        |
 * | other AppError                 | 404 not_found / 409 lot_state_changed / |
 * |                                | 422 invalid_body, detail = its message  |
 * | anything else                  | 500 internal_error, logged with logger.error |
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

import { ConflictError, NotFoundError, ValidationError, loadLocales } from "@breatic/core";
import { t } from "@breatic/shared";
import * as internalErrors from "@server/middleware/internal-errors.js";
import { RefundRefusal } from "@server/modules/credit-refund/refusal.js";

const { internalErrorHandler } = internalErrors;

loadLocales();

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * A one-route app that throws `err` and answers through the internal exit.
 * @param err - What the route throws.
 * @returns The response.
 */
async function answerFor(err: unknown): Promise<Response> {
  const app = new Hono();
  app.onError(internalErrorHandler);
  app.get("/boom", () => {
    throw err;
  });
  return app.request("/boom");
}

describe("internalErrorHandler", () => {
  it.each([
    [404, "not_found", "lot_not_found"],
    [409, "operation_in_progress", "operation_in_progress"],
    [409, "mail_not_resendable", "mail_not_resendable"],
    [422, "idempotency_key_reused", "idempotency_key_reused"],
  ] as const)("a RefundRefusal(%i, %s) answers its status with { code, detail } in English", async (status, code, detailKey) => {
    const res = await answerFor(new RefundRefusal(status, code, detailKey));

    expect(res.status).toBe(status);
    const body = (await res.json()) as { code: string; detail: string };
    expect(Object.keys(body).sort()).toEqual(["code", "detail"]);
    expect(body.code).toBe(code);
    expect(body.detail).toBe(t(`server.internal.${detailKey}`));
    expect(body.detail.startsWith("server.")).toBe(false);
  });

  // The services throw RefundRefusal; a second, empty error class beside it
  // only invites a route to throw the wrong one.
  it("exports no error class of its own beside RefundRefusal", () => {
    expect(internalErrors).not.toHaveProperty("InternalApiError");
  });

  // validate() throws with the public app's sentence ("Invalid input"); the
  // internal answer carries the internal API's own sentence instead.
  it("a ValidationError from validate() is 422 invalid_body with the server.internal.invalid_body sentence", async () => {
    const res = await answerFor(new ValidationError(t("server.error.validation")));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "invalid_body", detail: t("server.internal.invalid_body") });
  });

  it("hono's HTTPException for an unreadable body is 400 invalid_body", async () => {
    const res = await answerFor(new HTTPException(400, { message: "Malformed JSON in request body" }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
  });

  it.each([
    [new NotFoundError("Credit lot not found"), 404, "not_found", "Credit lot not found"],
    [new ConflictError("Lot is not refunding"), 409, "lot_state_changed", "Lot is not refunding"],
  ])("an AppError from the domain maps by status with its message as detail (%#)", async (err, status, code, message) => {
    const res = await answerFor(err);

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, detail: message });
  });

  it("anything else is 500 internal_error, says nothing more, and is logged with the original", async () => {
    const boom = new Error("pg connection reset");
    const res = await answerFor(boom);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "internal_error" });
    expect(logged.error).toHaveBeenCalledTimes(1);
    const args = logged.error.mock.calls[0] as unknown[];
    const carriesOriginal = args.some(
      (a) => a === boom || (typeof a === "object" && a !== null && Object.values(a).includes(boom)),
    );
    expect(carriesOriginal).toBe(true);
  });
});
