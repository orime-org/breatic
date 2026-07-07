// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Upload-hash facade (asset slice 2, #1609). Spawns the hashing Web
 * Worker per call and resolves the sha256 hex — or `null` on ANY worker
 * failure (construction, WASM load, runtime error). `null` degrades the
 * upload to "store without ledger registration" (untracked signal on the
 * server): availability-first, an upload never breaks because hashing
 * broke (plan 2026-07-07 §6).
 */

/** Message shape the hash worker posts back. */
interface HashWorkerResult {
  hash?: string;
  error?: string;
}

/**
 * Hash a file for upload dedup via the hashing Web Worker.
 * @param file - The file about to be uploaded (any size — every file is
 *   hashed; there is no size line).
 * @returns The sha256 hex, or `null` when hashing is unavailable/failed
 *   (the upload proceeds unregistered — never rejects).
 */
export function hashFile(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./hash-worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(null);
      return;
    }
    /**
     * Resolve once and always reclaim the worker thread.
     * @param value - The hex digest, or null on failure.
     */
    const settle = (value: string | null): void => {
      worker.terminate();
      resolve(value);
    };
    worker.onmessage = (event: MessageEvent<HashWorkerResult>) => {
      settle(typeof event.data.hash === 'string' ? event.data.hash : null);
    };
    worker.onerror = () => settle(null);
    worker.postMessage({ file });
  });
}
