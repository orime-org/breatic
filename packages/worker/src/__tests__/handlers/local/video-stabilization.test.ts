/**
 * Unit + integration tests for `video/stabilization`.
 *
 * Integration: generated 1-second 200x100 MP4 -> cropPct=10 -> expect
 * output dimensions to be ~0.8 x source on each axis (both even).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestMp4, createTestTempDir } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import stabilizationHandler from "../../../handlers/local/video/stabilization.js";

beforeEach(() => storage.reset());
afterAll(() => storage.restoreFetch());

async function probeDimensions(path: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "default=noprint_wrappers=1",
      path,
    ]);
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      const w = Number(/width=(\d+)/.exec(out)?.[1]);
      const h = Number(/height=(\d+)/.exec(out)?.[1]);
      if (!Number.isFinite(w) || !Number.isFinite(h)) {
        return reject(new Error(`Unparseable probe output: ${out}`));
      }
      resolve({ w, h });
    });
  });
}

function makeCtx(tempDir: string) {
  return {
    tempDir,
    jobId: "test-job",
    taskType: "video",
    toolName: "stabilization",
    userId: "user-test",
    projectId: "proj-test",
  };
}

describe("video/stabilization", () => {
  it("rejects non-http source", async () => {
    await expect(
      stabilizationHandler({ video: "blob:x", cropPct: 5 }, makeCtx("/tmp")),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });

  it("rejects cropPct > 14", async () => {
    await expect(
      stabilizationHandler({ video: "http://x/y.mp4", cropPct: 20 }, makeCtx("/tmp")),
    ).rejects.toThrow(/\[0, 14\]/);
  });

  it("rejects negative cropPct", async () => {
    await expect(
      stabilizationHandler({ video: "http://x/y.mp4", cropPct: -1 }, makeCtx("/tmp")),
    ).rejects.toThrow(/\[0, 14\]/);
  });

  it("cropPct=0 short-circuits — source URL returned, no upload", async () => {
    const result = await stabilizationHandler(
      { video: "http://example.com/src.mp4", cropPct: 0 },
      makeCtx("/tmp"),
    );
    expect(result.outputs[0]?.url).toBe("http://example.com/src.mp4");
    expect(storage.listUploaded()).toHaveLength(0);
  });

  it("cropPct=10 shrinks both dimensions to ~80% (even)", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 1.0, width: 200, height: 100 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await stabilizationHandler(
        { video: "http://example.com/src.mp4", cropPct: 10 },
        makeCtx(dir),
      );

      const uploaded = storage.listUploaded();
      expect(uploaded).toHaveLength(1);
      const outPath = join(dir, "got.mp4");
      writeFileSync(outPath, uploaded[0]!.buffer);

      const { w, h } = await probeDimensions(outPath);
      // 200 * 0.8 = 160; 100 * 0.8 = 80. trunc(.../2)*2 keeps even.
      expect(w).toBe(160);
      expect(h).toBe(80);
    } finally {
      cleanup();
    }
  }, 20_000);
});
