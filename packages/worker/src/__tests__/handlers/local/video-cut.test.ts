// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit + integration tests for `video/cut`.
 *
 * Integration: Generate a 2-second source, cut single + multi-segment,
 * expect output duration ≈ sum of segment lengths.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestMp4, createTestTempDir } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import cutHandler from "../../../handlers/local/video/cut.js";

beforeEach(() => storage.reset());
afterAll(() => storage.restoreFetch());

async function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      resolve(parseFloat(out.trim()));
    });
  });
}

function makeCtx(tempDir: string) {
  return {
    tempDir,
    jobId: "test-job",
    taskType: "video",
    toolName: "cut",
    userId: "user-test",
    projectId: "proj-test",
  };
}

describe("video/cut", () => {
  it("rejects empty segments array", async () => {
    await expect(
      cutHandler({ video: "http://x/y.mp4", segments: [] }, makeCtx("/tmp")),
    ).rejects.toThrow(/non-empty array/);
  });

  it("rejects end<=start", async () => {
    await expect(
      cutHandler(
        { video: "http://x/y.mp4", segments: [{ start: 1, end: 1 }] },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/end must be > start/);
  });

  it("rejects negative start", async () => {
    await expect(
      cutHandler(
        { video: "http://x/y.mp4", segments: [{ start: -1, end: 2 }] },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/start must be >= 0/);
  });

  it("single-segment cut produces expected duration", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 2.0, width: 160, height: 90 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await cutHandler(
        {
          video: "http://example.com/src.mp4",
          segments: [{ start: 0.2, end: 1.0 }],
        },
        makeCtx(dir),
      );

      const outPath = join(dir, "got.mp4");
      expect(storage.listUploaded()).toHaveLength(1);
      writeFileSync(outPath, storage.listUploaded()[0]!.buffer);
      const dur = await probeDuration(outPath);
      expect(dur).toBeGreaterThan(0.5);
      expect(dur).toBeLessThan(1.1);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("multi-segment produces N independent outputs with expected durations", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 2.0, width: 160, height: 90 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      const result = await cutHandler(
        {
          video: "http://example.com/src.mp4",
          segments: [
            { start: 0.2, end: 0.8 },
            { start: 1.2, end: 1.6 },
          ],
        },
        makeCtx(dir),
      );

      // Post-refactor: each segment becomes an independent output.
      expect(result.outputs).toHaveLength(2);
      expect(storage.listUploaded()).toHaveLength(2);

      const uploaded = storage.listUploaded();
      const expected = [0.6, 0.4]; // segment durations
      for (let i = 0; i < uploaded.length; i++) {
        const outPath = join(dir, `got-${i}.mp4`);
        writeFileSync(outPath, uploaded[i]!.buffer);
        const dur = await probeDuration(outPath);
        expect(dur).toBeGreaterThan(expected[i]! - 0.3);
        expect(dur).toBeLessThan(expected[i]! + 0.3);
      }
    } finally {
      cleanup();
    }
  }, 30_000);
});
