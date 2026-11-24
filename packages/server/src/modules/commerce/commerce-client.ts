// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Calls from the product to the billing service (inner#1993 §3.1, §3.2),
 * signed as `product`. A user's request carries the user in the path and the
 * request's language in the query, both inside the signature, so the billing
 * service answers in the user's language.
 */

import {
  COMMERCE_SIGNERS,
  UnavailableError,
  env,
  getCommerceConfig,
  isUnavailable,
  logger,
  signedCall,
  type SignedCallResult,
  type SignedCallTarget,
} from "@breatic/core";
import { getActiveLocale, t } from "@breatic/shared";

/** One call to the billing service. */
export interface CommerceCall {
  method: "GET" | "POST" | "PUT";
  /** Path under `/v1`, query included. */
  path: string;
  body?: unknown;
  /** The user's own key, carried as it came. */
  idempotencyKey?: string;
  /** A read a page waits on, held to `quick_call_timeout_ms`. */
  quick?: boolean;
}

/**
 * Where the billing service listens and how to sign for it.
 * @returns The target.
 */
export function commerceTarget(): SignedCallTarget {
  return { baseUrl: env.COMMERCE_API_URL, secret: env.COMMERCE_API_SECRET, signer: COMMERCE_SIGNERS.product };
}

/**
 * The path of one user's endpoint, with the request's language.
 * @param userId - The signed-in user.
 * @param sub - The endpoint under the user, query included.
 * @returns The path under `/v1`.
 */
export function userPath(userId: string, sub: string): string {
  const separator = sub.includes("?") ? "&" : "?";
  return `/users/${userId}${sub}${separator}locale=${encodeURIComponent(getActiveLocale())}`;
}

/**
 * Call the billing service.
 * @param call - What to send.
 * @returns Its 2xx answer.
 * @throws {SignedCallError} When it answers otherwise or not at all.
 */
export function callCommerce(call: CommerceCall): Promise<SignedCallResult> {
  const config = getCommerceConfig();
  return signedCall(commerceTarget(), {
    method: call.method,
    path: `/v1${call.path}`,
    ...(call.body === undefined ? {} : { body: call.body }),
    ...(call.idempotencyKey === undefined ? {} : { idempotencyKey: call.idempotencyKey }),
    timeoutMs: call.quick === true ? config.quick_call_timeout_ms : config.call_timeout_ms,
  });
}

/**
 * The refusal sent when the billing service cannot be reached.
 * @returns A 503 with `error.reason: "billing_unavailable"`.
 */
export function billingUnavailable(): UnavailableError {
  return new UnavailableError(t("server.billing.unavailable"), "billing_unavailable");
}

/**
 * Call the billing service for an answer the product reads itself.
 * @param call - What to send.
 * @returns Its 2xx answer's body.
 * @throws {UnavailableError} When the billing service cannot be reached.
 * @throws {SignedCallError} When it answers anything else but 2xx.
 */
export async function requestCommerce(call: CommerceCall): Promise<unknown> {
  try {
    return (await callCommerce(call)).body;
  } catch (err) {
    if (!isUnavailable(err)) throw err;
    logger.error({ err, path: call.path }, "commerce_call_unavailable");
    throw billingUnavailable();
  }
}
