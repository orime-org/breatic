// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { createSHA256 } from 'hash-wasm';

/**
 * Streaming chunked file hashing (asset slice 2, #1609). Every upload is
 * hashed regardless of size (user decision 2026-07-07 — no size line):
 * chunks stream through a WASM SHA-256 state, so memory stays constant
 * (one chunk at a time) and a 1 GB file costs seconds, not RAM.
 */

/** Default streaming chunk size: 8 MiB balances call overhead vs memory. */
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Compute the sha256 hex digest of a Blob/File by streaming fixed-size
 * chunks through a WASM hasher (constant memory, any file size).
 * @param blob - The file content to hash.
 * @param chunkBytes - Chunk size in bytes (default 8 MiB; tests shrink it
 *   to force multi-chunk streaming).
 * @returns Lowercase sha256 hex of the content.
 * @throws {Error} When the WASM hasher fails to load or a chunk read fails.
 */
export async function computeFileSha256(
  blob: Blob,
  chunkBytes: number = DEFAULT_CHUNK_BYTES,
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const chunk = blob.slice(offset, offset + chunkBytes);
    hasher.update(new Uint8Array(await chunk.arrayBuffer()));
  }
  return hasher.digest('hex');
}
