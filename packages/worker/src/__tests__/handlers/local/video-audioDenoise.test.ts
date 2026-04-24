/**
 * Integration tests for `video/audio-denoise`.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestMp4, createTestTempDir } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import audioDenoiseHandler from "../../../handlers/local/video/audioDenoise.js";

beforeEach(() => storage.reset());
afterAll(() => storage.restoreFetch());

async function probeHasAudio(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      resolve(out.trim() === "audio");
    });
  });
}

function makeCtx(tempDir: string) {
  return {
    tempDir,
    jobId: "test-job",
    taskType: "video",
    toolName: "audio-denoise",
    userId: "user-test",
    projectId: "proj-test",
  };
}

describe("video/audio-denoise", () => {
  it("rejects intensity out of range", async () => {
    await expect(
      audioDenoiseHandler({ video: "http://x/y.mp4", intensity: 150 }, makeCtx("/tmp")),
    ).rejects.toThrow(/\[0, 100\]/);
  });

  it("rejects non-number intensity", async () => {
    await expect(
      audioDenoiseHandler({ video: "http://x/y.mp4", intensity: "high" }, makeCtx("/tmp")),
    ).rejects.toThrow(/finite number/);
  });

  it("intensity<1 short-circuits", async () => {
    const result = await audioDenoiseHandler(
      { video: "http://example.com/src.mp4", intensity: 0 },
      makeCtx("/tmp"),
    );
    expect(result.url).toBe("http://example.com/src.mp4");
    expect(storage.listUploaded()).toHaveLength(0);
  });

  it("non-trivial intensity produces MP4 with audio track", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 1.0, width: 160, height: 90, withAudio: true });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await audioDenoiseHandler(
        { video: "http://example.com/src.mp4", intensity: 50 },
        makeCtx(dir),
      );

      const outPath = join(dir, "got.mp4");
      expect(storage.listUploaded()).toHaveLength(1);
      writeFileSync(outPath, storage.listUploaded()[0]!.buffer);
      expect(await probeHasAudio(outPath)).toBe(true);
    } finally {
      cleanup();
    }
  }, 20_000);
});
