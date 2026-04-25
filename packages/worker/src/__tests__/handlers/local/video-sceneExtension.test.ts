/**
 * Unit + integration tests for `video/scene-extension`.
 *
 * Integration: generate a 200x100 MP4, then extend the outer frame to
 * 300x150 (no offset) - expect output to be padded 300x150 (even).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestMp4, createTestTempDir } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import sceneExtensionHandler from "../../../handlers/local/video/sceneExtension.js";

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
    toolName: "scene-extension",
    userId: "user-test",
    projectId: "proj-test",
  };
}

describe("video/scene-extension", () => {
  it("rejects non-http source", async () => {
    await expect(
      sceneExtensionHandler(
        {
          video: "blob:x",
          frame: { w: 300, h: 150, ox: 0, oy: 0 },
          container: { width: 200, height: 100 },
        },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });

  it("rejects missing frame", async () => {
    await expect(
      sceneExtensionHandler(
        { video: "http://x/y.mp4", container: { width: 1, height: 1 } },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/`frame`/);
  });

  it("rejects non-finite frame.w", async () => {
    await expect(
      sceneExtensionHandler(
        {
          video: "http://x/y.mp4",
          frame: { w: NaN, h: 1, ox: 0, oy: 0 },
          container: { width: 1, height: 1 },
        },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/frame.*\.w must be a finite number/);
  });

  it("rejects non-positive container.width", async () => {
    await expect(
      sceneExtensionHandler(
        {
          video: "http://x/y.mp4",
          frame: { w: 1, h: 1, ox: 0, oy: 0 },
          container: { width: 0, height: 1 },
        },
        makeCtx("/tmp"),
      ),
    ).rejects.toThrow(/container\.width.*positive finite/);
  });

  it("degenerate frame === container short-circuits - source URL returned, no upload", async () => {
    const result = await sceneExtensionHandler(
      {
        video: "http://example.com/src.mp4",
        frame: { w: 200, h: 100, ox: 0, oy: 0 },
        container: { width: 200, height: 100 },
      },
      makeCtx("/tmp"),
    );
    expect(result.outputs[0]?.url).toBe("http://example.com/src.mp4");
    expect(storage.listUploaded()).toHaveLength(0);
  });

  it("extending 200x100 -> 300x150 pads output to 300x150 (even)", async () => {
    const { dir, cleanup } = createTestTempDir();
    try {
      const inPath = join(dir, "src.mp4");
      await makeTestMp4(inPath, { duration: 1.0, width: 200, height: 100 });
      storage.registerSource("http://example.com/src.mp4", readFileSync(inPath));

      await sceneExtensionHandler(
        {
          video: "http://example.com/src.mp4",
          frame: { w: 300, h: 150, ox: 0, oy: 0 },
          container: { width: 200, height: 100 },
        },
        makeCtx(dir),
      );

      const uploaded = storage.listUploaded();
      expect(uploaded).toHaveLength(1);
      const outPath = join(dir, "got.mp4");
      writeFileSync(outPath, uploaded[0]!.buffer);

      const { w, h } = await probeDimensions(outPath);
      expect(w).toBe(300);
      expect(h).toBe(150);
    } finally {
      cleanup();
    }
  }, 20_000);
});
