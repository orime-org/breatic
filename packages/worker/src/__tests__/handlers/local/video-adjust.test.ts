/**
 * Integration tests for `video/adjust`.
 *
 * Verifies: non-http rejection; neutral short-circuits; non-neutral
 * value produces a valid MP4 of ≈ input duration (eq filter doesn't
 * change duration).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { defaultAdjustValue } from "@breatic/shared";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestMp4, createTestTempDir } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import adjustHandler from "../../../handlers/local/video/adjust.js";

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
    toolName: "adjust",
    userId: "user-test",
    projectId: "proj-test",
  };
}

describe("video/adjust", () => {
  it("rejects non-http source", async () => {
    await expect(
      adjustHandler({ video: "blob:x", value: defaultAdjustValue }, makeCtx("/tmp")),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });

  it("neutral value returns source URL unchanged", async () => {
    const result = await adjustHandler(
      { video: "http://example.com/src.mp4", value: { ...defaultAdjustValue } },
      makeCtx("/tmp"),
    );
    expect(result.outputs[0]?.url).toBe("http://example.com/src.mp4");
    expect(storage.listUploaded()).toHaveLength(0);
  });

  it("non-neutral value produces same-duration output", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 1.0, width: 160, height: 90 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await adjustHandler(
        {
          video: "http://example.com/src.mp4",
          value: { ...defaultAdjustValue, exposure: 30, saturation: 20 },
        },
        makeCtx(dir),
      );

      const outPath = join(dir, "got.mp4");
      expect(storage.listUploaded()).toHaveLength(1);
      writeFileSync(outPath, storage.listUploaded()[0]!.buffer);
      const dur = await probeDuration(outPath);
      expect(dur).toBeGreaterThan(0.8);
      expect(dur).toBeLessThan(1.3);
    } finally {
      cleanup();
    }
  }, 20_000);
});
