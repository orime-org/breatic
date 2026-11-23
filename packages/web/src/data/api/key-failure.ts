// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { ACCOUNT_KEY_FAILURE_KINDS, ACCOUNT_KEY_FAILURE_REASONS, type AccountKeyFailureKind, type AccountKeyFailureReason } from '@breatic/shared';

/** A failure of the payer's own key a run ended on (inner#1953): its kind, the upstream, why and whose key it was. */
export interface KeyFailure {
  readonly reason: AccountKeyFailureKind;
  readonly upstream?: string;
  readonly keyReason?: AccountKeyFailureReason;
  /** The account the key belongs to. */
  readonly keyOwner?: string;
}

/**
 * The key failure a frame or a stored mark names, if it names one: a chat reply's failed mark and a text tool's error
 * event carry the same fields.
 * @param data - The frame's or mark's data.
 * @returns The failure, or undefined for any other failure.
 */
export function readKeyFailure(data: unknown): KeyFailure | undefined {
  const { reason, upstream, keyReason, keyOwner } = (data ?? {}) as { reason?: unknown; upstream?: unknown; keyReason?: unknown; keyOwner?: unknown };
  if (!(ACCOUNT_KEY_FAILURE_KINDS as readonly unknown[]).includes(reason)) return undefined;
  return {
    reason: reason as AccountKeyFailureKind,
    ...(typeof upstream === 'string' && upstream !== '' ? { upstream } : {}),
    ...((ACCOUNT_KEY_FAILURE_REASONS as readonly unknown[]).includes(keyReason) ? { keyReason: keyReason as AccountKeyFailureReason } : {}),
    ...(typeof keyOwner === 'string' && keyOwner !== '' ? { keyOwner } : {}),
  };
}
