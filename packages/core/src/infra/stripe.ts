/**
 * Stripe client singleton.
 *
 * Creates a Stripe client from STRIPE_SECRET_KEY.
 * Throws if the key is not configured.
 */

import Stripe from "stripe";
import { env } from "../config/env.js";

let _client: Stripe | null = null;

/**
 * Get the Stripe client singleton.
 *
 * @returns Configured Stripe client
 * @throws Error if STRIPE_SECRET_KEY is not set
 */
export function getStripeClient(): Stripe {
  if (!_client) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error(
        "Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.",
      );
    }
    _client = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _client;
}

/**
 * Verify a Stripe webhook signature and parse the event.
 *
 * @param payload - Raw request body (Buffer or string)
 * @param signature - `stripe-signature` header value
 * @returns Parsed Stripe event
 * @throws Error if signature is invalid or webhook secret is missing
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error(
      "Stripe webhook verification requires STRIPE_WEBHOOK_SECRET.",
    );
  }
  return getStripeClient().webhooks.constructEvent(
    payload,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );
}
