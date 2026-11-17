// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recognising a failure of an account's own key (inner#1953) wherever it sits on an error's cause chain: provider
 * raises it as `AccountKeyFailure`, and reading a key row that is gone raises it as `account_key_missing`. It is never
 * judged into a refusal of the deployment, and nothing moves the call to our keys.
 */

import type { AccountKeyFailureKind, AccountKeyFailureReason } from "@breatic/provider";

const KINDS: readonly string[] = ["account_key_failed", "account_key_missing", "upstream_unavailable"] satisfies AccountKeyFailureKind[];

/** A key failure as read off an error. */
export interface AccountKeyFailureFacts {
  kind: AccountKeyFailureKind;
  upstream?: string;
  reason?: AccountKeyFailureReason;
}

/**
 * The first account-key failure on an error or its causes.
 * @param error - What was thrown.
 * @returns Its kind, upstream and reason, or undefined when the error is not one.
 */
export function accountKeyFailureIn(error: unknown): AccountKeyFailureFacts | undefined {
  const seen = new Set<unknown>();
  for (let at = error; typeof at === "object" && at !== null && !seen.has(at); at = (at as { cause?: unknown }).cause) {
    seen.add(at);
    const { kind, upstream, reason } = at as { kind?: unknown; upstream?: unknown; reason?: unknown };
    if (typeof kind === "string" && KINDS.includes(kind)) {
      return {
        kind: kind as AccountKeyFailureKind,
        ...(typeof upstream === "string" ? { upstream } : {}),
        ...(typeof reason === "string" ? { reason: reason as AccountKeyFailureReason } : {}),
      };
    }
  }
  return undefined;
}
