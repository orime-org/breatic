// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { AlphaPackedIdentity, AlphaPackedReceipt, SourceLedgerDeclaration, SourceLedgerWriteClaim } from '@ingest/video-presentation-store.js';

/** The production store and real-storage test fixture expose these same ports. */
export interface SourceLedgerOwner {
  claimSourceLedger(identity: AlphaPackedIdentity, declaration: SourceLedgerDeclaration): Promise<SourceLedgerWriteClaim | null>;
  completeSourceLedger(identity: AlphaPackedIdentity, owner: string, measured: AlphaPackedReceipt): Promise<boolean>;
  releaseSourceLedger(identity: AlphaPackedIdentity, owner: string): Promise<void>;
}

/**
 * Writes one original companion stream through its durable claim.
 * @param _input - Real R2, original owner and complete trusted producer stream.
 * @returns A physical publication acknowledgement.
 * @throws {Error} Until the dedicated source-ledger writer is implemented.
 */
export function writeVideoSourceLedger(_input: {
  bucket: R2Bucket; owner: SourceLedgerOwner; identity: AlphaPackedIdentity; declaration: SourceLedgerDeclaration; body: ReadableStream<Uint8Array>;
}): Promise<{ ok: boolean; status: number }> {
  return Promise.reject(new Error('Source-ledger writer is not implemented'));
}
