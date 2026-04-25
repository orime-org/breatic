/**
 * Unit + integration tests for `video/hdr-conversion`.
 *
 * Integration: generate a 160×90 MP4 → run the handler with both the
 * traditional (aiEnhance=false) and AI-enhance paths → expect an MP4
 * output tagged as bt709 (the front-end behaviour we mirror).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestMp4, createTestTempDir } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import hdrHandler from "../../../handlers/local/video/hdrConversion.js";

beforeEach(() => storage.reset());
afterAll(() => storage.restoreFetch());

async function probeColorspace(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=color_space",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      resolve(out.trim());
    });
  });
}

function makeCtx(tempDir: string, toolName = "hdr-conversion") {
  return {
    tempDir,
    jobId: "test-job",
    taskType: "video",
    toolName,
    userId: "user-test",
    projectId: "proj-test",
  };
}

describe("video/hdr-conversion", () => {
  it("rejects non-http source", async () => {
    await expect(
      hdrHandler(
        { video: "blob:x", preset: "hdr10", intensity: 50, aiEnhance: false },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });

  it("rejects unknown preset", async () => {
    await expect(
      hdrHandler(
        { video: "http://x/y.mp4", preset: "sdr", intensity: 50, aiEnhance: false },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/preset.*must be one of/);
  });

  it("rejects intensity out of range", async () => {
    await expect(
      hdrHandler(
        { video: "http://x/y.mp4", preset: "hdr10", intensity: 200, aiEnhance: false },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/\[0, 100\]/);
  });

  it("rejects non-boolean aiEnhance", async () => {
    await expect(
      hdrHandler(
        { video: "http://x/y.mp4", preset: "hdr10", intensity: 50, aiEnhance: "yes" },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/aiEnhance.*boolean/);
  });

  it("traditional path (aiEnhance=false) produces bt709 MP4", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 1.0, width: 160, height: 90 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await hdrHandler(
        {
          video: "http://example.com/src.mp4",
          preset: "hdr10",
          intensity: 50,
          aiEnhance: false,
        },
        makeCtx(dir),
      );

      const uploaded = storage.listUploaded();
      expect(uploaded).toHaveLength(1);
      const outPath = join(dir, "got.mp4");
      writeFileSync(outPath, uploaded[0]!.buffer);

      expect(await probeColorspace(outPath)).toBe("bt709");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("ai-enhance path produces bt709 MP4", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 1.0, width: 160, height: 90 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await hdrHandler(
        {
          video: "http://example.com/src.mp4",
          preset: "hlg",
          intensity: 80,
          aiEnhance: true,
        },
        makeCtx(dir),
      );

      const uploaded = storage.listUploaded();
      expect(uploaded).toHaveLength(1);
      const outPath = join(dir, "got.mp4");
      writeFileSync(outPath, uploaded[0]!.buffer);

      expect(await probeColorspace(outPath)).toBe("bt709");
    } finally {
      cleanup();
    }
  }, 45_000);
});
