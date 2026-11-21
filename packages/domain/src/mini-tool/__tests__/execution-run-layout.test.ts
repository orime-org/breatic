// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The §5.4 job layout admission freezes (frames-split design §5.4 limit row): only a segment can be encoded in chunks,
 * so a frame output whose single job alone exceeds one chunk share is refused as too long, never laid out for chunking.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { AppError, getMiniToolsConfig, loadLocales } from "@breatic/core";
import { t } from "@breatic/shared";
import { runLayout } from "../execution-admission.service.js";
import { presentedSource } from "../../../../server/src/__tests__/integration/presentation-fixtures.js";

beforeAll(() => { loadLocales(); });

/**
 * The selected version of a source whose one keyframe interval is a given length, so every job reading it pays that pre-roll.
 * @param maxKeyframeInterval - The longest keyframe interval in seconds.
 * @returns The version.
 */
async function versionWith(maxKeyframeInterval: number): Promise<Awaited<ReturnType<typeof presentedSource>>["bundle"]> {
  const presented = await presentedSource("a".repeat(64), "video/source.mp4", (key) => `https://assets.example.test/${key}`,
    { keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval, allKeyframes: false } });
  return presented.bundle;
}

describe("an output that alone exceeds one chunk share (§5.4)", () => {
  it.each(["video.extract-frames", "video.focus-crop"] as const)("LY01 %s: a frame whose pre-roll exceeds the share is refused too long", async (tool) => {
    // 20000 s to the next keyframe at 200 fps is a 4000001-frame pre-roll, beyond one share of the two-hour budget.
    const version = await versionWith(20_000);
    const outputs = [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001",
      recipe: tool === "video.focus-crop" ? { kind: "frame" as const, frameIndex: 10, crop: { x: 0, y: 0, width: 100, height: 100 } } : { kind: "frame" as const, frameIndex: 10 } }];
    const config = getMiniToolsConfig();
    let thrown: unknown;
    try { runLayout(outputs, version, config, tool); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ statusCode: 400, message: t("server.mini_tool.runTooLong", { max: config.encoding.max_parallel_chunks }) });
  });

  it("LY02 a frame within the share is batched", async () => {
    const version = await versionWith(1.25);
    const { layout } = runLayout([{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "frame", frameIndex: 10 } }], version, getMiniToolsConfig(), "video.extract-frames");
    expect(layout).toEqual({ batches: [[0]], encodes: [] });
  });
});
