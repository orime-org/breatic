// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Waits for an account's pending referral binding before anything that
 * depends on it (inner#1993 §5.5, §8.4): a membership checkout reads the
 * binding for its first-period discount, and a later binding must meet the
 * first one already decided. The relay alone sends the row and counts its
 * attempts; the waiting request only wakes it and reads the row.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { commerceOutboxRepo, getCommerceConfig } from "@breatic/core";
import { billingUnavailable } from "@server/modules/commerce/commerce-client.js";
import { wakeCommerceRelay } from "@server/modules/commerce/commerce-relay.js";

/**
 * Wait until the account's referral binding has left the outbox: sent,
 * moved to the dead letters, or there was none.
 * @param userId - The account.
 * @returns Once no unsent binding is left.
 * @throws {UnavailableError} When it is still unsent after `quick_call_timeout_ms`; the row stays for the relay.
 */
export async function awaitReferralBinding(userId: string): Promise<void> {
  const { quick_call_timeout_ms: timeoutMs, wait_poll_ms: pollMs } = getCommerceConfig();
  const deadline = Date.now() + timeoutMs;
  wakeCommerceRelay();
  while (await commerceOutboxRepo.hasUnsentReferralBinding(userId)) {
    if (Date.now() >= deadline) throw billingUnavailable();
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
