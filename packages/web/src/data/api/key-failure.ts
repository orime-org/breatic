// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { ACCOUNT_KEY_FAILURE_KINDS, ACCOUNT_KEY_FAILURE_REASONS, type AccountKeyFailureKind, type AccountKeyFailureReason } from '@breatic/shared';

/** A failure of the payer's own key a run ended on (inner#1953): its kind, the upstream and why. */
export interface KeyFailure {
  readonly reason: AccountKeyFailureKind;
  readonly upstream?: string;
  readonly keyReason?: AccountKeyFailureReason;
}

/**
 * The key failure a frame or a stored mark names, if it names one: a chat reply's failed mark and a text tool's error
 * event carry the same three fields.
 * @param data - The frame's or mark's data.
 * @returns The failure, or undefined for any other failure.
 */
export function readKeyFailure(data: unknown): KeyFailure | undefined {
  const { reason, upstream, keyReason } = (data ?? {}) as { reason?: unknown; upstream?: unknown; keyReason?: unknown };
  if (!(ACCOUNT_KEY_FAILURE_KINDS as readonly unknown[]).includes(reason)) return undefined;
  return {
    reason: reason as AccountKeyFailureKind,
    ...(typeof upstream === 'string' && upstream !== '' ? { upstream } : {}),
    ...((ACCOUNT_KEY_FAILURE_REASONS as readonly unknown[]).includes(keyReason) ? { keyReason: keyReason as AccountKeyFailureReason } : {}),
  };
}
