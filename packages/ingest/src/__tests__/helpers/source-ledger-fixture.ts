// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared values and byte utilities for the presentation store tests (inner#1306).
 * The store harness itself is `machine-store.ts`; the earlier RPC fixture over the
 * v1 store API was removed with the S6c rewrite (test plan §89).
 */

import { expect } from 'vitest';
import * as sharedModule from '@breatic/shared';

export const ORIGINAL = { width: 95, height: 63, duration: 2.4 };
// inner#1306 §77: six budgets, no frame-count ceiling.
export const LEDGER_LIMITS = { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216,
  isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 };
export const PRICING = { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 },
  prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } };

/**
 * The registered key of the compact table; a missing export fails the case that reaches it.
 * @param key - Registered storage key.
 * @returns The table key.
 * @throws {Error} When shared does not export the derivation.
 */
export function tableKeyFor(key: string): string {
  const derive = (sharedModule as Record<string, unknown>).videoSourceLedgerTableKeyFor;
  expect(typeof derive).toBe('function');
  return (derive as (value: string) => string)(key);
}

/** Expose complete bytes, keeping cancellation-observed sources live until demand. @throws {never} Never. */
export function stream(bytes: Uint8Array, canceled?: () => void): ReadableStream<Uint8Array> {
  if (canceled === undefined) return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  let emitted = false;
  return new ReadableStream({
    pull(controller) {
      if (emitted) { controller.close(); return; }
      emitted = true;
      controller.enqueue(bytes);
    },
    cancel() { canceled(); },
  }, { highWaterMark: 0 });
}

/** Compute an independent standard SHA over literal input, not through the production hash helper. @throws {Error} When the platform digest fails. */
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}
