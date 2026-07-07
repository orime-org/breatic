// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { computeFileSha256 } from '@web/data/upload/hash-core';

/**
 * Web Worker entry for upload hashing (asset slice 2, #1609): receives a
 * File, streams it through the WASM SHA-256 (constant memory), posts back
 * `{ hash }` or `{ error }`. Runs off the main thread so hashing a large
 * file never blocks the canvas.
 */

self.onmessage = (event: MessageEvent<{ file: File }>): void => {
  computeFileSha256(event.data.file)
    .then((hash) => self.postMessage({ hash }))
    .catch((err: unknown) =>
      self.postMessage({
        error: err instanceof Error ? err.message : String(err),
      }),
    );
};
