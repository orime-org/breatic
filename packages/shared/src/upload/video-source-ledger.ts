// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import type { VideoSourceLedgerCompanion, VideoSourceLedgerParseLimits, VideoSourceLedgerReceipt, VideoSourceLedgerState } from '@shared/upload/video-source-ledger-types.js';

/** Independently specified strict companion schema, pending its RED implementation. */
export const videoSourceLedgerCompanionSchema: z.ZodType<VideoSourceLedgerCompanion> = z.unknown().transform((): never => {
  throw Object.assign(new Error('Source ledger companion schema is not implemented'), { code: 'not_implemented' });
});
/** Independently specified measured receipt schema, pending its RED implementation. */
export const videoSourceLedgerReceiptSchema: z.ZodType<VideoSourceLedgerReceipt> = z.unknown().transform((): never => {
  throw Object.assign(new Error('Source ledger receipt schema is not implemented'), { code: 'not_implemented' });
});
/** Independent source capability state schema, pending its RED implementation. */
export const videoSourceLedgerStateSchema: z.ZodType<VideoSourceLedgerState> = z.unknown().transform((): never => {
  throw Object.assign(new Error('Source ledger state schema is not implemented'), { code: 'not_implemented' });
});

/**
 * Validate full source JSON against its measured receipt and mandatory caller limits.
 * @param value - Complete untrusted companion JSON supplied after a bounded body read.
 * @param receipt - Original measured stored companion identity and counts.
 * @param limits - Mandatory frozen physical-frame and occurrence ceilings.
 * @throws {Error} Until the independently specified null-returning parser is implemented.
 */
export function parseVideoSourceLedger(value: unknown, receipt: VideoSourceLedgerReceipt, limits: VideoSourceLedgerParseLimits): VideoSourceLedgerCompanion | null {
  void value; void receipt; void limits;
  throw Object.assign(new Error('Source ledger parser is not implemented'), { code: 'not_implemented' });
}

/**
 * Derive the source companion key from the registered canonical storage key.
 * @param key - Original registered canonical storage key.
 * @throws {Error} Until the independently specified key function is implemented.
 */
export function videoSourceLedgerKeyFor(key: string): string {
  void key;
  throw Object.assign(new Error('Source ledger key is not implemented'), { code: 'not_implemented' });
}
