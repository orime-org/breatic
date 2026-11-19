// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Lip-sync admission over streamed container steps (inner#1306 execution design, the paragraph before §9.4): composite
 * chunks are cut by the chunk time share and may span loop and bounce segment boundaries; a chunk whose source frames go
 * back decodes its union source window to a raw file and is cut further so that window fits the raw disk budget, computed
 * once at admission; the clip's crop file of reused frames fits the same budget; the work is priced as actually decoded.
 */
import { describe, expect, it } from "vitest";
import { getMiniToolsConfig } from "@breatic/core";
import type { VideoPresentationVersion } from "@breatic/shared";
import {
  lipsyncPictureBytes, lipsyncResultSourceFrames, lipsyncSourceSpan, plannedStageJobs, type LipsyncTimeline,
} from "@breatic/shared/mini-tools";
import { lipsyncClipCropBytes, lipsyncCompositeChunks, lipsyncRawDiskBytes } from "../lipsync-admission.js";
import { lipSyncLayout } from "../execution-admission.service.js";

const DIGEST = "d".repeat(64);

/**
 * The selected version the lip-sync layout reads: an 8-bit SDR source read in place, a keyframe every second, on a
 * constant grid (frames-split design §3.5).
 * @param fps - Its grid rate.
 * @param count - Its grid frame count.
 * @param size - Its display size.
 * @param size.width - The width.
 * @param size.height - The height.
 * @returns The version.
 */
function versionOf(fps: number, count: number, size: { width: number; height: number }): VideoPresentationVersion {
  const receipt = { storageKey: "video/fixture/play.mp4", url: "https://assets.example.test/video/fixture/play.mp4", etag: "e", size: 4096, sha256: DIGEST, contentType: "video/mp4" };
  return {
    schemaVersion: 1, sourceFingerprint: DIGEST, versionId: DIGEST, toolInputId: DIGEST, planSha256: DIGEST, policyVersion: 1, producerVersion: DIGEST, profileVersion: DIGEST,
    original: { ...size, duration: count / fps },
    display: { ...size, fps: { numerator: fps, denominator: 1 }, frameCount: count, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: count, leadFrames: 0, holdFrames: 0 },
    playback: { kind: "native", carrier: receipt, displayRect: null },
    toolSource: { edit: null, keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false }, sourceDecodeKey: "sdr_8bit" },
  };
}

const HD = { width: 1920, height: 1080 };

/**
 * Lay out a two-person run on the configured standard-4 class with today's configuration.
 * @param fps - The source's frame rate.
 * @param frames - Its frame count.
 * @param timeline - The frozen timeline.
 * @param at - The people analysis's anchor frame, the source's display size and the reverse buffer when not today's; the
 * first frame of a 1080p source when absent.
 * @param at.anchor - The anchor frame.
 * @param at.size - The display size.
 * @param at.reverseBufferBytes - The reverse buffer.
 * @returns The layout, its seconds and the frozen disk budget.
 */
function layout(fps: number, frames: number, timeline: LipsyncTimeline, at: { anchor: number; size: { width: number; height: number }; reverseBufferBytes?: number } = { anchor: 0, size: HD }):
  ReturnType<typeof lipSyncLayout> {
  const config = structuredClone(getMiniToolsConfig());
  if (at.reverseBufferBytes !== undefined) config.encoding.reverse_buffer_bytes = at.reverseBufferBytes;
  const usedEnd = timeline.syncMode === "cut_off" ? timeline.duration : timeline.videoDuration;
  return lipSyncLayout(versionOf(fps, frames, at.size),
    { timeline, usedRange: { start: 0, end: usedEnd }, persons: 2, cropSize: 512, containerClass: "MiniToolContainerStd4", anchor: at.anchor }, config);
}

describe("lip-sync admission over streamed steps (execution design paragraph before §9.4)", () => {
  it("LD01 admits a 1080p 60 fps 300 s cut_off run in at most 8 composite jobs, every stage within the parallel cap", () => {
    const { layout: frozen } = layout(60, 18_000, { duration: 300, videoDuration: 300, syncMode: "cut_off" });
    expect(frozen.composite.length).toBeLessThanOrEqual(8);
    expect(frozen.composite[0]!.start).toBe(0);
    expect(frozen.composite.at(-1)!.end).toBe(18_000);
    for (const stage of plannedStageJobs(frozen)) expect(stage.jobs, stage.stage).toBeLessThanOrEqual(getMiniToolsConfig().encoding.max_parallel_chunks);
  });

  it.each(["loop", "bounce"] as const)("LD02 admits a 3 s 1080p 60 fps video in %s over 30 s, chunks spanning its cycles", (syncMode) => {
    const { layout: frozen } = layout(60, 180, { duration: 30, videoDuration: 3, syncMode });
    expect(frozen.composite.length).toBeLessThanOrEqual(8);
    // A cycle is 180 result frames (loop) or 360 (bounce); some chunk holds more than one, so it spans a segment boundary.
    expect(Math.max(...frozen.composite.map((chunk) => chunk.end - chunk.start))).toBeGreaterThan(syncMode === "loop" ? 180 : 360);
    for (const stage of plannedStageJobs(frozen)) expect(stage.jobs, stage.stage).toBeLessThanOrEqual(getMiniToolsConfig().encoding.max_parallel_chunks);
  });

  it("LD03 freezes the disk budget once: the class's disk times encoding.raw_disk_share", () => {
    const config = getMiniToolsConfig();
    expect(layout(60, 180, { duration: 30, videoDuration: 3, syncMode: "loop" }).rawDiskBytes)
      .toBe(lipsyncRawDiskBytes(config.classes.MiniToolContainerStd4!.disk_gb, config.encoding.raw_disk_share));
  });

  it("LD04 prices the clip as one forward decode and each composite chunk's source window once", () => {
    // Doubling the loop count doubles the result but not the source decoded: the 60 s run costs less than twice the 30 s one.
    const short = layout(60, 180, { duration: 30, videoDuration: 3, syncMode: "loop" }).seconds;
    const long = layout(60, 180, { duration: 60, videoDuration: 3, syncMode: "loop" }).seconds;
    expect(long).toBeGreaterThan(short);
    const cutOff = layout(60, 3600, { duration: 60, videoDuration: 60, syncMode: "cut_off" }).seconds;
    // 60 s of loop over a 3 s source decodes 180 source frames where 60 s of cut_off decodes 3600.
    expect(long).toBeLessThan(cutOff);
  });

  it("LD05 cuts a chunk that goes back so its union source window fits the disk, and leaves a forward chunk whole", () => {
    // A 10-frame source looped over 40 result frames, one time chunk; a picture of 100 bytes and a disk for 6 of them.
    const grid = { fps: { numerator: 10, denominator: 1 }, frameCount: 10 };
    const timeline: LipsyncTimeline = { duration: 4, videoDuration: 1, syncMode: "loop" };
    const sources = lipsyncResultSourceFrames(timeline, grid);
    const segments = [0, 10, 20, 30].map((start) => ({ resultStart: start, resultEnd: start + 10 }));
    const chunks = lipsyncCompositeChunks({ sources, segments, seconds: (window) => 1 + (window.end - window.start) * 0.01, shareSeconds: 100,
      rawBytes: (span) => (span.end - span.start) * 100, diskBytes: 600 });
    expect(chunks[0]!.start).toBe(0);
    for (let at = 1; at < chunks.length; at += 1) expect(chunks[at]!.start).toBe(chunks[at - 1]!.end);
    expect(chunks.at(-1)!.end).toBe(40);
    for (const chunk of chunks) {
      const span = lipsyncSourceSpan(sources, chunk);
      expect(!span.goesBack || (span.end - span.start) * 100 <= 600, JSON.stringify(chunk)).toBe(true);
    }
    // With room for the whole source window, the chunk spanning every cycle stays one.
    expect(lipsyncCompositeChunks({ sources, segments, seconds: () => 1, shareSeconds: 100, rawBytes: (span) => (span.end - span.start) * 100, diskBytes: 1000 }))
      .toEqual([{ start: 0, end: 40 }]);
  });

  it("LD06 cuts by the chunk time share and refuses a single frame over it", () => {
    const sources = Array.from({ length: 100 }, (_unused, k) => k);
    const chunks = lipsyncCompositeChunks({ sources, segments: [{ resultStart: 0, resultEnd: 100 }], seconds: (window) => 1 + (window.end - window.start), shareSeconds: 30,
      rawBytes: () => 0, diskBytes: 1 });
    for (const chunk of chunks) expect(1 + chunk.end - chunk.start).toBeLessThanOrEqual(30);
    expect(chunks).toHaveLength(4);
    expect(() => lipsyncCompositeChunks({ sources, segments: [{ resultStart: 0, resultEnd: 100 }], seconds: () => 31, shareSeconds: 30, rawBytes: () => 0, diskBytes: 1 }))
      .toThrow(RangeError);
  });

  // Execution design §10.2: an anchor past frame 0 prepares the forward clip [a, e) as prepare:fwd and the frames [0, a]
  // reversed as prepare:rev, whose reverse filter holds every decoded frame. A 4K30 source anchored at 60 s reverses 1801
  // frames of 12441600 bytes each through a 2 GiB buffer: 11 chunks and their stitch, sent with prepare:fwd at once. They
  // are frozen in the layout, counted in its stages for the parallel cap and priced in its seconds.
  it("LD08 freezes the tracking clips' preparation jobs from the reverse buffer, counts them in the stages and prices them", () => {
    const timeline: LipsyncTimeline = { duration: 90, videoDuration: 90, syncMode: "cut_off" };
    const UHD = { width: 3840, height: 2160 };
    const anchored = layout(30, 2700, timeline, { anchor: 1800, size: UHD, reverseBufferBytes: 2_147_483_648 });
    expect(anchored.layout.tracking.forward).toEqual([{ start: 1800, end: 2700 }]);
    const reverse = anchored.layout.tracking.reverse;
    expect(reverse).toHaveLength(11);
    expect(reverse[0]).toEqual({ start: 0, end: 172 });
    expect(reverse.at(-1)).toEqual({ start: 1720, end: 1801 });
    const stages = plannedStageJobs(anchored.layout);
    expect(stages).toContainEqual({ stage: "track_prepare", jobs: 12 });
    expect(stages).toContainEqual({ stage: "track_prepare_stitch", jobs: 1 });
    // The anchor on frame 0 tracks the preparation itself and prepares no clip.
    const first = layout(30, 2700, timeline, { anchor: 0, size: UHD, reverseBufferBytes: 2_147_483_648 });
    expect(first.layout.tracking).toEqual({ forward: [], reverse: [] });
    // One reversed job with a buffer that holds every frame: the 11 chunks add ten job starts and the stitch's.
    const whole = layout(30, 2700, timeline, { anchor: 1800, size: UHD, reverseBufferBytes: Number.MAX_SAFE_INTEGER });
    expect(whole.layout.tracking.reverse).toEqual([{ start: 0, end: 1801 }]);
    const start = getMiniToolsConfig().encoding.encoder.start_seconds;
    expect(whole.seconds - first.seconds).toBeGreaterThanOrEqual(2 * start);
    expect(anchored.seconds - whole.seconds).toBeGreaterThanOrEqual(11 * start);
  });

  it("LD07 the clip's crop file holds one crop per source frame the result uses after the decode passed it", () => {
    expect(lipsyncClipCropBytes([0, 1, 2, 2, 2, 0, 3], 512)).toBe(2 * lipsyncPictureBytes(512, 512, false));
    expect(lipsyncClipCropBytes([0, 1, 2, 3], 512)).toBe(0);
    // A variable-frame-rate loop: frame 1 is first shown after frame 2, which the decode reached by passing it.
    expect(lipsyncClipCropBytes([0, 2, 1, 2], 512)).toBe(2 * lipsyncPictureBytes(512, 512, false));
  });
});
