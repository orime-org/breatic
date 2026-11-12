// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The awareness claims a page publishes for the uploads it runs, shared by the Document's pending media blocks and
 * the Timeline's upload placeholders: what a client says about an upload, how a reader combines the claims, and the
 * timer that keeps them alive in a hidden tab.
 */

/** The awareness field claims are published in. */
export const CLAIMS_FIELD = 'uploads';

/** What a client says about an upload in {@link CLAIMS_FIELD}: running it, or it failed. */
export type UploadClaim = 'uploading' | 'failed';

/**
 * What the clients in awareness claim about an upload. A client running it
 * outweighs one that saw it fail: the upload is still going somewhere.
 * @param states - Awareness states by client id.
 * @param uploadId - The upload.
 * @returns The claim, or null when nobody claims it.
 * @throws {never} Never.
 */
export function claimIn(states: ReadonlyMap<number, Record<string, unknown>>, uploadId: string): UploadClaim | null {
  let claim: UploadClaim | null = null;
  for (const state of states.values()) {
    const uploads = state[CLAIMS_FIELD];
    if (typeof uploads !== 'object' || uploads === null) continue;
    const said: unknown = (uploads as Record<string, unknown>)[uploadId];
    if (said === 'uploading') return 'uploading';
    if (said === 'failed') claim = 'failed';
  }
  return claim;
}

/**
 * Ticks on a Worker's timer, which a hidden tab does not slow, so a page keeps renewing the awareness claims it
 * publishes for its uploads before y-protocols' 30-second expiry (inner#1351 + inner#1390 design §5.5).
 * @param tick - Called on each tick.
 * @returns What stops the timer.
 * @throws {never} Never.
 */
export function renewOnWorker(tick: () => void): () => void {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./claim-renewal-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // ponytail: main-thread fallback, throttled to once in 30 s+ when hidden.
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }
  worker.onmessage = tick;
  return () => worker.terminate();
}
