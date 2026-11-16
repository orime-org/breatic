// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

type AccountReader = { accounts: { retrieve(): Promise<{ id: string }> } };
type RealStripeTestConfig = Record<string, string | undefined> & { STRIPE_WEBHOOK_ACCOUNT_ID: string; STRIPE_WEBHOOK_ENDPOINT_ID: "" };

/**
 * Scopes CLI forwarding to its authenticated account and unknown endpoint.
 * @param stripe - The authenticated test-mode account reader.
 * @param config - The suite's environment and explicitly enabled services.
 * @returns Configuration for the real Stripe fixture.
 * @throws {Error} If the authenticated account cannot be retrieved.
 */
export async function realStripeTestConfig(stripe: AccountReader, config: Record<string, string | undefined>): Promise<RealStripeTestConfig> {
  const account = await stripe.accounts.retrieve();
  return { ...config, STRIPE_WEBHOOK_ACCOUNT_ID: account.id, STRIPE_WEBHOOK_ENDPOINT_ID: "" };
}
