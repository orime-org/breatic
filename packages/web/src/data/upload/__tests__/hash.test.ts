// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';

import { computeFileSha256 } from '@web/data/upload/hash-core';
import { hashFile } from '@web/data/upload/hash';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Known SHA-256 vectors (FIPS 180-2).
const SHA256_ABC =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA256_EMPTY =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('computeFileSha256 — streaming chunked sha256 (hash-wasm)', () => {
  it('hashes a small file to the known vector', async () => {
    const file = new File(['abc'], 'a.txt', { type: 'text/plain' });
    await expect(computeFileSha256(file)).resolves.toBe(SHA256_ABC);
  });

  it('hashes an empty file to the empty-input vector', async () => {
    const file = new File([], 'empty.bin');
    await expect(computeFileSha256(file)).resolves.toBe(SHA256_EMPTY);
  });

  it('chunked streaming equals whole-file hashing (chunk boundary invariant)', async () => {
    const content = 'abcdefghij-0123456789-ABCDEFGHIJ';
    const file = new File([content], 'c.bin');
    const whole = await computeFileSha256(file);
    // Chunk size smaller than the content forces multiple .update() calls;
    // a correct streaming implementation is boundary-invariant.
    const chunked = await computeFileSha256(file, 4);
    expect(chunked).toBe(whole);
  });
});

describe('hashFile — Web Worker facade with availability degrade', () => {
  it('resolves the worker-computed hex on success', async () => {
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(): void {
        queueMicrotask(() => {
          this.onmessage?.({ data: { hash: SHA256_ABC } } as MessageEvent);
        });
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', FakeWorker);

    const file = new File(['abc'], 'a.txt');
    await expect(hashFile(file)).resolves.toBe(SHA256_ABC);
  });

  it('degrades to null when the worker errors (upload must not break)', async () => {
    class ErrorWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(): void {
        queueMicrotask(() => {
          this.onerror?.(new Error('wasm load failed'));
        });
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', ErrorWorker);

    const file = new File(['abc'], 'a.txt');
    await expect(hashFile(file)).resolves.toBeNull();
  });

  it('degrades to null when Worker construction itself throws', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('no worker support');
        }
      },
    );

    const file = new File(['abc'], 'a.txt');
    await expect(hashFile(file)).resolves.toBeNull();
  });

  it('degrades to null when the worker reports an internal error message', async () => {
    class InternalErrorWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(): void {
        queueMicrotask(() => {
          this.onmessage?.({ data: { error: 'oom' } } as MessageEvent);
        });
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', InternalErrorWorker);

    const file = new File(['abc'], 'a.txt');
    await expect(hashFile(file)).resolves.toBeNull();
  });
});
