/**
 * Unit + integration tests for `video/speed`.
 *
 * Integration: generated 1-second 160×90 MP4 → speed×2 → expect
 * output duration ~0.5 s (±generous tolerance for encoder rounding).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestMp4, createTestTempDir } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import speedHandler from "../../../handlers/local/video/speed.js";

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
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      const d = parseFloat(out.trim());
      if (!Number.isFinite(d)) return reject(new Error(`Unparseable duration: ${out}`));
      resolve(d);
    });
  });
}

function makeCtx(tempDir: string) {
  return {
    tempDir,
    jobId: "test-job",
    taskType: "video",
    toolName: "speed",
    userId: "user-test",
    projectId: "proj-test",
  };
}

describe("video/speed", () => {
  it("rejects non-http source", async () => {
    await expect(
      speedHandler({ video: "blob:x", rate: 1.5 }, makeCtx("/tmp")),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });

  it("rejects rate=0", async () => {
    await expect(
      speedHandler({ video: "http://x/y.mp4", rate: 0 }, makeCtx("/tmp")),
    ).rejects.toThrow(/must be positive/);
  });

  it("rejects rate out of [0.1, 10]", async () => {
    await expect(
      speedHandler({ video: "http://x/y.mp4", rate: 100 }, makeCtx("/tmp")),
    ).rejects.toThrow(/\[0\.1, 10\]/);
  });

  it("2x speed halves the duration", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 1.0, width: 160, height: 90 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await speedHandler({ video: "http://example.com/src.mp4", rate: 2 }, makeCtx(dir));

      const uploaded = storage.listUploaded();
      expect(uploaded).toHaveLength(1);
      const outPath = join(dir, "uploaded.mp4");
      writeFileSync(outPath, uploaded[0]!.buffer);

      const dur = await probeDuration(outPath);
      expect(dur).toBeGreaterThan(0.35);
      expect(dur).toBeLessThan(0.7);
    } finally {
      cleanup();
    }
  }, 20_000);
});
