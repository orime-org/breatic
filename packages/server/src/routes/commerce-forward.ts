// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hands a user's request to the billing service and its answer back
 * (inner#1993 §3.2): a definite answer, refusals included, goes back as it
 * came; a billing service out of reach is a 503 `billing_unavailable`.
 */

import type { Context } from "hono";
import { SignedCallError, isUnavailable, logger, type SignedCallResult } from "@breatic/core";
import { billingUnavailable, callCommerce, type CommerceCall } from "@server/modules/commerce/commerce-client.js";

/**
 * Call the billing service, or say what to answer the user when it did not
 * answer 2xx.
 * @param c - The request context.
 * @param call - What to send.
 * @returns Its 2xx answer, or the response that relays its refusal.
 * @throws {UnavailableError} When the billing service cannot be reached.
 */
export async function callCommerceOrAnswer(c: Context, call: CommerceCall): Promise<{ answer: SignedCallResult } | { response: Response }> {
  try {
    return { answer: await callCommerce(call) };
  } catch (err) {
    if (err instanceof SignedCallError && err.status !== null && !isUnavailable(err)) {
      return { response: c.json(err.body ?? {}, err.status as 400) };
    }
    logger.error({ err, path: call.path }, "commerce_forward_unavailable");
    if (isUnavailable(err)) throw billingUnavailable();
    throw err;
  }
}

/**
 * Forward one call and send back what the billing service answered.
 * @param c - The request context.
 * @param call - What to send.
 * @returns The billing service's answer.
 * @throws {UnavailableError} When the billing service cannot be reached.
 */
export async function forwardToCommerce(c: Context, call: CommerceCall): Promise<Response> {
  const result = await callCommerceOrAnswer(c, call);
  if ("response" in result) return result.response;
  return c.json(result.answer.body ?? {}, result.answer.status as 200);
}

/**
 * The user's idempotency key, carried to the billing service as it came.
 * @param header - The validated headers.
 * @returns The key to send, if the request carried one.
 */
export function idempotencyKeyOf(header: { "idempotency-key"?: string | undefined }): { idempotencyKey?: string } {
  const key = header["idempotency-key"];
  return key === undefined ? {} : { idempotencyKey: key };
}
