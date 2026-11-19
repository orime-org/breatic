// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product internal listener's authentication: core's signature and nonce
 * checks, nonces in the product's Redis, its events logged here. The billing
 * service signs as `commerce` with `COMMERCE_API_SECRET` and reaches only
 * `/internal/v1/commerce/`; a request signed as `product` is never accepted
 * here; every other signer is a back office admin checked against
 * `INTERNAL_API_SECRET` and kept out of that prefix (inner#1993 §3.1).
 */

import { createInternalAuth, env, getRedis, logger, type InternalAuthEvent, type SignerSecrets } from "@breatic/core";

/** The billing service's signer name. */
const COMMERCE_SIGNER = "commerce";
/** The name this server signs as when it calls the billing service. */
const PRODUCT_SIGNER = "product";
/** The paths only the billing service may reach. */
const COMMERCE_PREFIX = "/internal/v1/commerce/";

/**
 * The secrets a signer's requests are checked against on this listener.
 * @param signer - The signer named in `x-internal-admin`.
 * @returns The current and previous secrets, or null when this listener accepts nothing from the signer.
 */
export function signerSecrets(signer: string): SignerSecrets | null {
  if (signer === PRODUCT_SIGNER) return null;
  if (signer === COMMERCE_SIGNER) {
    return { current: env.COMMERCE_API_SECRET, previous: env.COMMERCE_API_SECRET_PREVIOUS };
  }
  return { current: env.INTERNAL_API_SECRET, previous: env.INTERNAL_API_SECRET_PREVIOUS };
}

/**
 * Whether a signer may reach a path on this listener.
 * @param signer - The verified signer.
 * @param path - The request path.
 * @returns True for the billing service inside the commerce prefix and for everyone else outside it.
 */
export function signerMayAccess(signer: string, path: string): boolean {
  return (signer === COMMERCE_SIGNER) === path.startsWith(COMMERCE_PREFIX);
}

/**
 * Log one authentication event.
 * @param event - What the authentication saw.
 */
function report(event: InternalAuthEvent): void {
  switch (event.kind) {
    case "rejected":
      logger.warn({ step: event.step, path: event.path }, "internal_auth_rejected");
      return;
    case "forbidden":
      logger.warn({ signer: event.signer, path: event.path }, "internal_auth_forbidden");
      return;
    case "nonce_unavailable":
      logger.error({ err: event.err }, "internal_nonce_unavailable");
  }
}

export const internalAuth = createInternalAuth({
  secretsFor: signerSecrets,
  mayAccess: signerMayAccess,
  redis: getRedis,
  keyPrefix: () => env.ENV,
  report,
});
