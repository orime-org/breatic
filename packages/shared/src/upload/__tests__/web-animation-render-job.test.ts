// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The container job protocol for the two new kinds (#1490 design §5.2, §6.1–§6.3): a modification names the package
 * it starts from, and an export is a render job on its own container class whose report carries what the ingest
 * Worker measured of the video and its cover, in the shape registration reads.
 */

import { describe, expect, it } from "vitest";

import {
  WEB_ANIMATION_CONTAINER_CLASS, WEB_ANIMATION_RENDER_CONTAINER_CLASS, webAnimationJobRequestSchema,
  webAnimationRenderJobReportSchema, webAnimationRenderJobRequestSchema,
} from "../web-animation-job.js";

const SHA = "c".repeat(64);
const FPS = { num: 24, den: 1 };

const createJob = {
  containerClass: WEB_ANIMATION_CONTAINER_CLASS,
  jobId: "timeline:00000000-0000-4000-8000-000000000001",
  deadlineAt: 1_800_000_000_000,
  prompt: "Make it slower",
  viewport: { width: 1080, height: 1920 },
  fps: FPS,
  durationFrames: 144,
  packageKey: "web-animation/p/e/index.html",
  manifestKey: "web-animation/p/e/manifest.json",
  fontSetVersion: 1,
  maxPackageBytes: 5_000_000,
  maxTokens: 64_000,
  callTimeoutMs: 600_000,
  model: "deepseek/deepseek-v4.1-flash-1017",
};

const renderJob = {
  containerClass: WEB_ANIMATION_RENDER_CONTAINER_CLASS,
  jobId: "timeline:00000000-0000-4000-8000-000000000002",
  deadlineAt: 1_800_000_000_000,
  packageKey: "web-animation/p/e/index.html",
  fontSetVersion: 1,
  width: 1080,
  height: 1920,
  fps: FPS,
  durationFrames: 144,
  quality: "standard",
  videoKey: "generated/2026/11/15/v.mp4",
  coverKey: "generated/2026/11/15/v_cover.png",
};

const video = {
  storageKey: "generated/2026/11/15/v.mp4",
  sha256: SHA,
  sizeBytes: 4_000_000,
  contentType: "video/mp4",
  width: 1080,
  height: 1920,
  durationSeconds: 6,
  cover: { storageKey: "generated/2026/11/15/v_cover.png", sha256: SHA, sizeBytes: 90_000, contentType: "image/png", width: 1080, height: 1920 },
};

describe("modification jobs", () => {
  it("name the base package they start from, with its frame and length", () => {
    const job = { ...createJob, base: { packageKey: "web-animation/p/b/index.html", viewport: { width: 1920, height: 1080 }, durationFrames: 96, fontSetVersion: 1 } };
    expect(webAnimationJobRequestSchema.parse(job)).toEqual(job);
  });

  it("refuse a base package outside the private prefix", () => {
    const job = { ...createJob, base: { packageKey: "generated/b/index.html", viewport: { width: 1920, height: 1080 }, durationFrames: 96, fontSetVersion: 1 } };
    expect(webAnimationJobRequestSchema.safeParse(job).success).toBe(false);
  });
});

describe("render jobs", () => {
  it("run on their own container class", () => {
    expect(WEB_ANIMATION_RENDER_CONTAINER_CLASS).toBe("WebAnimationRenderContainer");
  });

  it("accept the package, the frame, the length and the two output keys", () => {
    expect(webAnimationRenderJobRequestSchema.parse(renderJob)).toEqual(renderJob);
  });

  it("refuse a package outside the private prefix", () => {
    expect(webAnimationRenderJobRequestSchema.safeParse({ ...renderJob, packageKey: "generated/p/index.html" }).success).toBe(false);
  });

  it("refuse a video key under the private prefix, because the video is a studio asset", () => {
    expect(webAnimationRenderJobRequestSchema.safeParse({ ...renderJob, videoKey: "web-animation/p/v.mp4" }).success).toBe(false);
  });

  it("refuse the creation job's container class", () => {
    expect(webAnimationRenderJobRequestSchema.safeParse({ ...renderJob, containerClass: WEB_ANIMATION_CONTAINER_CLASS }).success).toBe(false);
  });
});

describe("render reports", () => {
  it("carry a done render's video and cover as the ingest Worker measured them", () => {
    const done = { state: "done", phase: null, progress: 1, container: { wallMs: 90_000, cpuUsec: 300_000_000 }, video, failureReason: null };
    expect(webAnimationRenderJobReportSchema.parse(done)).toEqual(done);
  });

  it("carry the rendering phase and how far it got while running", () => {
    const running = { state: "running", phase: "rendering", progress: 0.4, container: null, video: null, failureReason: null };
    expect(webAnimationRenderJobReportSchema.parse(running)).toEqual(running);
  });

  it.each(["render_failed", "frame_mismatch", "save_failed"])("carry the failure %s", (reason) => {
    const failed = { state: "failed", phase: null, progress: null, container: { wallMs: 1_000, cpuUsec: null }, video: null, failureReason: reason };
    expect(webAnimationRenderJobReportSchema.parse(failed)).toEqual(failed);
  });

  it("refuse a done report without its video", () => {
    const done = { state: "done", phase: null, progress: 1, container: { wallMs: 90_000, cpuUsec: null }, video: null, failureReason: null };
    expect(webAnimationRenderJobReportSchema.safeParse(done).success).toBe(false);
  });

  it("refuse a stopping state, which a render never reaches: a cancel ends it at once", () => {
    const stopping = { state: "stopping", phase: "rendering", progress: 0.4, container: null, video: null, failureReason: null };
    expect(webAnimationRenderJobReportSchema.safeParse(stopping).success).toBe(false);
  });

  it("refuse a progress outside 0 to 1", () => {
    const running = { state: "running", phase: "rendering", progress: 1.5, container: null, video: null, failureReason: null };
    expect(webAnimationRenderJobReportSchema.safeParse(running).success).toBe(false);
  });
});
