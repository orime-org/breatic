// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from "@breatic/core";
import type { StripeWebhookResult } from "@breatic/shared";
import { beginAttempt, finishAttempt } from "@server/modules/stripe-webhook/attempts.repo.js";
import type { CompletionState, WebhookIdentity } from "@server/modules/stripe-webhook/types.js";

/**
 * Narrows protocol objects without trusting the verified payload's field types.
 * @param value - The candidate protocol object.
 * @returns Whether it has a record shape.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Checks the text contract shared by the record schema and its audit readers.
 * @param value - The candidate identity field.
 * @param maximum - Its database contract bound.
 * @returns Whether the field fits the record contract.
 */
function isText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\u0000");
}

/**
 * Extracts recordable identity only after HTTP signature verification.
 * @param value - The verified event payload.
 * @returns Its controlled identity, or null for an invalid protocol shape.
 */
export function parseWebhookIdentity(value: unknown): WebhookIdentity | null {
  if (!isObject(value) || !isText(value.id, 255) || !isText(value.type, 80) || typeof value.livemode !== "boolean") return null;
  if (!isObject(value.data) || !isObject(value.data.object)) return null;
  if (value.account !== undefined && !isText(value.account, 255)) return null;
  return { eventId: value.id, eventType: value.type, livemode: value.livemode, connectedAccountId: value.account ?? null };
}

/**
 * Persists a request's start using deployment metadata from the injected config.
 * @param id - The independent attempt UUID allocated by the HTTP boundary.
 * @param identity - The verified event identity.
 * @param receivedAt - When the application entered its webhook path.
 * @throws {Error} If the start transaction cannot be acknowledged.
 */
export async function startWebhookAttempt(id: string, identity: WebhookIdentity, receivedAt: Date): Promise<void> {
  await beginAttempt({ ...identity, id, receivedAt, accountId: env.STRIPE_WEBHOOK_ACCOUNT_ID ?? null, endpointId: env.STRIPE_WEBHOOK_ENDPOINT_ID ?? null, environment: env.ENV });
}

/**
 * Persists the handler result after its response has been formed.
 * @param id - The attempt whose start was acknowledged.
 * @param responseStatus - The existing handler response status.
 * @param result - The finite processing classification.
 * @returns Whether this was the first completed result.
 * @throws {Error} If the completion transaction cannot be acknowledged.
 */
export function finishWebhookAttempt(id: string, responseStatus: number, result: StripeWebhookResult): Promise<CompletionState> {
  return finishAttempt({ id, responseStatus, result });
}
