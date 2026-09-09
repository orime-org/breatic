// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload-hash facade (asset slice 2, #1609). Spawns the hashing Web
 * Worker per call and resolves the sha256 hex — or `null` on ANY worker
 * failure (construction, WASM load, runtime error).
 *
 * `null` now REFUSES the upload (#1826 §0 rule 4, "no hash, no upload", user
 * 2026-07-26). It used to degrade to "store without ledger registration"
 * (availability-first, plan 2026-07-07 §6), but untracked is not a usable
 * state: the object counts toward nothing, dedups with nothing, and — the
 * reason the rule changed — whatever pinned its URL 404s once the offline
 * reclaim removes the row-less object. The caller shows a reload prompt
 * (the worker's own code failing to load is the common cause).
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
 * @returns The sha256 hex, or `null` when hashing is unavailable/failed. Never
 *   rejects — but `null` REFUSES the upload (see the module doc): the caller
 *   stops before asking for a ticket and shows a reload prompt.
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
