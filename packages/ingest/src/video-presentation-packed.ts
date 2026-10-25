// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { AlphaPackedIdentity, AlphaPackedWriteClaim, AlphaPackedReceipt } from '@ingest/video-presentation-store.js';
import { hashStoredObject } from '@ingest/stored-object.js';

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
  const claim = await input.owner.claimPacked(input.identity, input.byteLength);
  if (claim === null) {
    await input.body.cancel();
    return { ok: false, status: 409 };
  }
  let committed = false;
  const controller = new AbortController();
  try {
    const fixed = new FixedLengthStream(claim.byteLength);
    const piping = input.body.pipeTo(fixed.writable, { signal: controller.signal });
    const writing = input.bucket.put(claim.key, fixed.readable, {
      onlyIf: claim.etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.etag }, httpMetadata: { contentType: 'video/mp4' },
    }).then(written => {
      if (written === null) controller.abort(new Error('Packed object version changed'));
      return written;
    });
    let written: R2Object | null;
    try { [written] = await Promise.all([writing, piping]); }
    catch (error) {
      controller.abort(error);
      await Promise.allSettled([writing, piping]);
      throw error;
    }
    if (written === null) return { ok: false, status: 409 };
    const receipt = { etag: written.etag, size: written.size, sha256: await hashStoredObject(input.bucket, claim.key) };
    committed = await input.owner.completePacked(input.identity, claim.owner, receipt);
    return { ok: committed, status: committed ? 200 : 409 };
  } finally {
    if (!committed) await input.owner.releasePacked(input.identity, claim.owner);
  }
}
