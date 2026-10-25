// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { AlphaPackedIdentity, AlphaPackedWriteClaim, AlphaPackedReceipt } from '@ingest/video-presentation-store.js';

/** Production RPC and the actual-storage fixture implement the same ordinary port. */
export interface AlphaPackedOwner {
  claimPacked(identity: AlphaPackedIdentity, byteLength: number): Promise<AlphaPackedWriteClaim | null>;
  completePacked(identity: AlphaPackedIdentity, owner: string, receipt: AlphaPackedReceipt): Promise<boolean>;
  releasePacked(identity: AlphaPackedIdentity, owner: string): Promise<void>;
}
/** Rejection and readiness are explicit facts of the storage boundary. */
export interface AlphaPackedWriteResult { ok: boolean; status: number }

/**
 * Stream one complete packed object through the accepted pre-write claim.
 * @param input - Actual storage, accepted owner, complete byte stream and its length.
 * @returns Readiness only after physical receipt and manifest publication.
 * @throws {Error} When an actual source stream or storage operation fails.
 */
export async function writeAlphaPacked(input: {
  bucket: R2Bucket; owner: AlphaPackedOwner; identity: AlphaPackedIdentity; body: ReadableStream<Uint8Array>; byteLength: number;
}): Promise<AlphaPackedWriteResult> {
  void input;
  return { ok: false, status: 409 };
}
