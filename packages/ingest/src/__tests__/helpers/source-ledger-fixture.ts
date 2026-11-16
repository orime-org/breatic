// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
// S6e E2-1 (design §3.2 item 1): the encoding parameters frozen at admission.
export const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000, sdr_16bit: 294000000, hdr_16bit: 71900000 }, aacEncodeSecondsPerSecond: 100 },
  copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
// S6c (design §3.5, §5.1): admission freezes the basic and the standard-4 prices together.
export const PRICING = {
  basic: { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 }, prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } },
  standard4: { containerClass: 'MiniToolContainerStd4', size: { vcpu: 4, memory_gib: 12, disk_gb: 20 }, prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } },
};

/**
 * The compact table key of one toolInputId (S6e E4-7: full and compact are stored per toolInputId).
 * @param key - Registered storage key.
 * @param toolInputId - The ledger instance.
 * @returns The table key.
 * @throws {Error} When shared does not export the derivation.
 */
export function tableKeyFor(key: string, toolInputId: string): string {
  const derive = (sharedModule as Record<string, unknown>).videoSourceLedgerTableKeyFor;
  expect(typeof derive).toBe('function');
  return (derive as (value: string, input: string) => string)(key, toolInputId);
}

/**
 * The full ledger key of one toolInputId (S6e E4-7).
 * @param key - Registered storage key.
 * @param toolInputId - The ledger instance.
 * @returns The full ledger key.
 * @throws {never} Never.
 */
export function fullKeyFor(key: string, toolInputId: string): string {
  return sharedModule.videoSourceLedgerKeyFor(key, toolInputId);
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
