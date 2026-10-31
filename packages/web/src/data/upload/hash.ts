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
 * @param signal - Cancellation belonging to this hash operation.
 * @returns The sha256 hex, or `null` when hashing is unavailable/failed.
 *   `null` REFUSES the upload (see the module doc): the caller
 *   stops before asking for a ticket and shows a reload prompt.
 * @throws {DOMException} When the caller cancels this hash operation.
 */
export function hashFile(file: File, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let worker: Worker;
    try {
      worker = new Worker(new URL('./hash-worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    /**
     * Resolve once and always reclaim the worker thread.
     * @param value - The hex digest, or null on failure.
     * @throws {never} Never directly.
     */
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      resolve(value);
    };
    /**
     * Release this worker without publishing a late hash or failure.
     * @throws {never} Never directly.
     */
    const abort = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      reject(signal?.reason ?? new DOMException('Upload hash cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<HashWorkerResult>) => {
      settle(typeof event.data.hash === 'string' ? event.data.hash : null);
    };
    worker.onerror = () => settle(null);
    worker.postMessage({ file });
  });
}
