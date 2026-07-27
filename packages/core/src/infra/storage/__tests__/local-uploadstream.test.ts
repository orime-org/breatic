// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * LocalStorageAdapter.uploadStream error handling (#1826, Gate-2 复攻 finding).
 *
 * The write stream emits 'error' ASYNCHRONOUSLY (ENOSPC / EACCES / a disk
 * fault). Without a PERSISTENT 'error' listener, an error fired while the loop
 * is awaiting `reader.read()` (not the write stream) is an unhandled 'error'
 * event → the process CRASHES. The fix attaches a persistent listener and
 * re-raises the captured error as a normal thrown error the caller cleans up.
 *
 * We trigger a REAL write-stream error (no mocking): point the key at an
 * existing DIRECTORY so `createWriteStream` fails with EISDIR. (The RED here —
 * without the persistent listener — is a process-level crash, which cannot be
 * asserted cleanly by reverting; this pins the GREEN contract: a clean reject.)
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import crypto from "node:crypto";
import { LocalStorageAdapter } from "@core/infra/storage/local.js";

const adapter = new LocalStorageAdapter();
const TEST_PREFIX = "__test_uploadstream__";

afterAll(() => {
  rmSync(adapter.getFilePath(TEST_PREFIX), { recursive: true, force: true });
});

/** A one-chunk web ReadableStream. */
function oneChunkBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
    },
  });
}

describe("LocalStorageAdapter.uploadStream — write-stream error is thrown, not an unhandled crash", () => {
  it("re-raises a createWriteStream EISDIR (target is a directory) as a rejection", async () => {
    const key = `${TEST_PREFIX}/collide-${crypto.randomUUID()}`;
    // Make the key resolve to an existing DIRECTORY → createWriteStream → EISDIR.
    mkdirSync(adapter.getFilePath(key), { recursive: true });

    await expect(adapter.uploadStream(key, oneChunkBody(), 1_000)).rejects.toThrow();
  });

  it("still succeeds on the normal path (fix does not regress a clean write)", async () => {
    const key = `${TEST_PREFIX}/ok-${crypto.randomUUID()}.bin`;
    const res = await adapter.uploadStream(key, oneChunkBody(), 1_000);
    expect(res).toEqual({ ok: true, size: 4 });
  });

  it("still returns the over-limit sentinel when the body exceeds maxBytes", async () => {
    const key = `${TEST_PREFIX}/big-${crypto.randomUUID()}.bin`;
    const res = await adapter.uploadStream(key, oneChunkBody(), 2);
    expect(res).toEqual({ ok: false, overLimit: true });
  });
});

describe("uploadStream — atomic publish (Gate-2 R5 H9)", () => {
  it("the final key does NOT exist while the body is still streaming", async () => {
    // The two-hop local protocol has no "write finished" signal: /uploaded only
    // checks head().exists. If the object appeared at byte 0, a report racing
    // the PUT could register a HALF-WRITTEN file — and then uploadStream's
    // over-limit / error paths delete it, leaving a live ledger row and a node
    // pinned to a 404. Writing to a temp path and renaming on completion makes
    // the key appear only when it is whole. (The pre-stream implementation
    // buffered the whole body then wrote once, so this held; the streaming
    // rewrite must not lose it.)
    const key = `${TEST_PREFIX}/${crypto.randomUUID()}.bin`;
    let released!: () => void;
    const gate = new Promise<void>((r) => {
      released = r;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        await gate; // hold the stream open mid-write
        controller.close();
      },
    });

    const inFlight = adapter.uploadStream(key, body, 1024);
    // Give the first chunk time to reach the disk.
    await new Promise((r) => setTimeout(r, 20));
    const midFlight = await adapter.head(key);
    expect(midFlight.exists).toBe(false);

    released();
    const res = await inFlight;
    expect(res).toEqual({ ok: true, size: 4 });
    // Published only now.
    const after = await adapter.head(key);
    expect(after.exists).toBe(true);
    expect(after.size).toBe(4);
  });

  it("an over-limit body leaves NO object at the final key (nothing to reclaim, nothing to 404)", async () => {
    const key = `${TEST_PREFIX}/${crypto.randomUUID()}.bin`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });

    const res = await adapter.uploadStream(key, body, 100);
    expect(res).toEqual({ ok: false, overLimit: true });
    expect((await adapter.head(key)).exists).toBe(false);
  });
});
