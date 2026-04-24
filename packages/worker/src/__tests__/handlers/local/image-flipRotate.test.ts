/**
 * Unit + integration tests for the `image/flipRotate` local handler.
 *
 * Unit: parseParams accept/reject table.
 * Integration: run the real Sharp pipeline against a generated
 * fixture and assert the output buffer is a valid PNG with the
 * expected transformed dimensions (90° rotation swaps W/H; flips
 * preserve W/H).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import sharp from "sharp";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestPng } from "../../helpers/fixtures.js";

// Must be at top-level so vi.mock/vi.hoisted hoist above handler imports.
const storage = installCoreStorageMock();

import flipRotateHandler from "../../../handlers/local/image/flipRotate.js";

beforeEach(() => storage.reset());
afterAll(() => storage.restoreFetch());

const ctx = {
  tempDir: "/tmp/unused-for-image",
  jobId: "test-job",
  taskType: "image",
  toolName: "flipRotate",
  userId: "user-test",
  projectId: "proj-test",
};

describe("image/flipRotate", () => {
  it("rejects non-http source URL", async () => {
    await expect(
      flipRotateHandler({ image: "data:image/png;base64,AAAA", op: "rotate90" }, ctx),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });

  it("rejects unknown op", async () => {
    await expect(
      flipRotateHandler({ image: "http://example.com/a.png", op: "tilt" }, ctx),
    ).rejects.toThrow(/op.*must be one of/);
  });

  it("rotate90 swaps dimensions", async () => {
    const source = await makeTestPng({ width: 200, height: 100 });
    storage.registerSource("http://example.com/src.png", source);

    await flipRotateHandler({ image: "http://example.com/src.png", op: "rotate90" }, ctx);

    const uploaded = storage.listUploaded();
    expect(uploaded).toHaveLength(1);
    const meta = await sharp(uploaded[0]!.buffer).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
    expect(meta.format).toBe("png");
  });

  it("flipHorizontal preserves dimensions", async () => {
    const source = await makeTestPng({ width: 200, height: 100 });
    storage.registerSource("http://example.com/src.png", source);

    await flipRotateHandler({ image: "http://example.com/src.png", op: "flipHorizontal" }, ctx);

    const meta = await sharp(storage.listUploaded()[0]!.buffer).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
  });

  it("rotateMinus90 swaps dimensions", async () => {
    const source = await makeTestPng({ width: 300, height: 150 });
    storage.registerSource("http://example.com/src.png", source);

    await flipRotateHandler({ image: "http://example.com/src.png", op: "rotateMinus90" }, ctx);

    const meta = await sharp(storage.listUploaded()[0]!.buffer).metadata();
    expect(meta.width).toBe(150);
    expect(meta.height).toBe(300);
  });

  it("flipVertical preserves dimensions", async () => {
    const source = await makeTestPng({ width: 80, height: 120 });
    storage.registerSource("http://example.com/src.png", source);

    await flipRotateHandler({ image: "http://example.com/src.png", op: "flipVertical" }, ctx);

    const meta = await sharp(storage.listUploaded()[0]!.buffer).metadata();
    expect(meta.width).toBe(80);
    expect(meta.height).toBe(120);
  });
});
