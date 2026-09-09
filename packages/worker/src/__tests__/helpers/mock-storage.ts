// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Test helpers for where a local handler's output goes.
 *
 * Vitest's `vi.mock()` must be called at the top of a test file
 * (it's hoisted above imports). Each handler test does this:
 *
 *   import { installCoreStorageMock, type StorageMockState } from
 *     "../../helpers/mock-storage.js";
 *
 *   const storageState = installCoreStorageMock();
 *
 * The helper uses `vi.hoisted` + `vi.mock` to intercept both the storage
 * adapter (`@breatic/core`, which handlers read their inputs through) and the
 * upload service (`@breatic/domain`, which is where their outputs go since
 * #181), wiring both into a shared mock state. The state is returned so tests
 * can read uploads[] and register fetch-able sources.
 */

import { vi, type MockInstance } from "vitest";

export interface StorageUpload {
  key: string;
  buffer: Buffer;
  contentType: string;
}

export interface StorageMockState {
  /** Register a URL → Buffer mapping for the global fetch stub. */
  registerSource: (url: string, buffer: Buffer) => void;
  /** All uploads recorded by the mock adapter, in call order. */
  listUploaded: () => StorageUpload[];
  /** Clear uploads + sources. Call in `beforeEach` for isolation. */
  reset: () => void;
  /** Restore the real `fetch`. Call in `afterAll`. */
  restoreFetch: () => void;
}

/**
 * Install the storage mocks and a `global.fetch` stub.
 *
 * IMPORTANT — must be called at module top-level, before any handler
 * import. Call once per test file; call `state.reset()` in `beforeEach`
 * to clear uploads/sources between tests.
 */
export function installCoreStorageMock(): StorageMockState {
  const state = vi.hoisted(() => {
    const uploads: StorageUpload[] = [];
    const sources = new Map<string, Buffer>();
    let keyCounter = 0;
    return { uploads, sources, getNextKey: () => `mock-${++keyCounter}.out` };
  });

  vi.mock("@breatic/core", () => ({
    getStorageAdapter: async () => ({
      upload: async (key: string, buffer: Buffer, contentType: string) => {
        state.uploads.push({ key, buffer, contentType });
        return `mock://storage/${key}`;
      },
      head: async () => ({}),
      publicUrl: (k: string) => `mock://storage/${k}`,
      isOwnUrl: (url: string) => url.startsWith("mock://storage/"),
    }),
    storageKey: () => state.getNextKey(),
  }));

  // Where a local handler's output goes since #181: through the ingest Worker
  // rather than straight at the adapter. The key is minted on the way, by the
  // grant, so the one recorded here stands in for it.
  vi.mock("@breatic/domain", () => ({
    backendUploadService: {
      // A Blob, the way the real one takes it: a caller whose bytes are on
      // disk hands over a file-backed one. What landed is recorded as bytes,
      // since that is what a test reads back.
      uploadBytesToStorage: async (
        bytes: Blob,
        ctx: { contentType: string },
      ) => {
        const key = state.getNextKey();
        state.uploads.push({
          key,
          buffer: Buffer.from(await bytes.arrayBuffer()),
          contentType: ctx.contentType,
        });
        return { assetId: `asset-${key}`, fileUrl: `mock://storage/${key}` };
      },
    },
  }));

  const realFetch = global.fetch;
  const fetchSpy: MockInstance = vi
    .spyOn(global, "fetch")
    .mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input).toString();
      const buf = state.sources.get(url);
      if (!buf) {
        return new Response(`mock-storage: no source for ${url}`, { status: 404 });
      }
      return new Response(buf, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });

  return {
    registerSource: (url: string, buffer: Buffer) => state.sources.set(url, buffer),
    listUploaded: () => state.uploads.slice(),
    reset: () => {
      state.uploads.length = 0;
      state.sources.clear();
    },
    restoreFetch: () => {
      fetchSpy.mockRestore();
      global.fetch = realFetch;
    },
  };
}
