/**
 * Unit + integration tests for the `image/adjust` local handler.
 *
 * Unit: parseParams rejects bad inputs; neutral value short-circuits.
 * Integration: non-neutral value produces a valid PNG of the same
 * dimensions as the source (adjust never changes size).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import sharp from "sharp";
import { defaultAdjustValue } from "@breatic/shared";
import { installCoreStorageMock } from "../../helpers/mock-storage.js";
import { makeTestPng } from "../../helpers/fixtures.js";

const storage = installCoreStorageMock();

import adjustHandler from "../../../handlers/local/image/adjust.js";

beforeEach(() => storage.reset());
afterAll(() => storage.restoreFetch());

const ctx = {
  tempDir: "/tmp/unused-for-image",
  jobId: "test-job",
  taskType: "image",
  toolName: "manual-adjust",
  userId: "user-test",
  projectId: "proj-test",
};

describe("image/adjust", () => {
  it("rejects non-http source URL", async () => {
    await expect(
      adjustHandler({ image: "blob:foo", value: defaultAdjustValue }, ctx),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });

  it("neutral value short-circuits and returns source URL unchanged", async () => {
    const result = await adjustHandler(
      { image: "http://example.com/src.png", value: { ...defaultAdjustValue } },
      ctx,
    );
    expect(result.url).toBe("http://example.com/src.png");
    expect(storage.listUploaded()).toHaveLength(0);
  });

  it("non-neutral value produces same-dimension PNG output", async () => {
    const source = await makeTestPng({ width: 150, height: 100 });
    storage.registerSource("http://example.com/src.png", source);

    await adjustHandler(
      {
        image: "http://example.com/src.png",
        value: { ...defaultAdjustValue, exposure: 30, saturation: 20 },
      },
      ctx,
    );

    const uploaded = storage.listUploaded();
    expect(uploaded).toHaveLength(1);
    const meta = await sharp(uploaded[0]!.buffer).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(150);
    expect(meta.height).toBe(100);
  });

  it("missing `value` field uses all-defaults and short-circuits", async () => {
    const result = await adjustHandler({ image: "http://example.com/src.png" }, ctx);
    expect(result.url).toBe("http://example.com/src.png");
  });
});
