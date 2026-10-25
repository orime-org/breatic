// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { getUnderstandConfig } from "@core/config/understand.js";
import { assertKnownQueues, getWorkerConfig, workerConcurrencyFor } from "@core/config/worker.js";

// A task waiting on an upstream is back on the queue between questions, so
// waiting holds no worker slot (inner#1337).
describe("worker concurrency", () => {
  it("gives the tasks queue the slots config/worker.yaml names for it", () => {
    expect(workerConcurrencyFor("tasks")).toBe(50);
  });

  it("gives the queues that wait on the ingest Worker as many places as tasks", () => {
    // Each waits as long as its task's two hours allow (inner#1367).
    expect(workerConcurrencyFor("upload-finish")).toBe(50);
    expect(workerConcurrencyFor("url-ingest")).toBe(50);
    expect(workerConcurrencyFor("media-read")).toBe(50);
  });

  it("gives every other queue the default", () => {
    expect(workerConcurrencyFor("mail")).toBe(5);
  });

  it("limits the long-media SQL outbox scan to one worker at a time", () => {
    expect(workerConcurrencyFor("long-media-dispatch")).toBe(1);
  });

  it("has no per-round wait left: an upstream is asked once per pickup", () => {
    expect(getWorkerConfig()).not.toHaveProperty("poll_max_wait");
  });

  it("holds at most five media readings in memory at once", () => {
    expect(getUnderstandConfig().max_concurrent).toBe(5);
  });

  it("loads the approved long-media limits and versioned channel-preserving profile", () => {
    expect(getUnderstandConfig().long_media).toEqual({
      max_source_bytes: 2_147_483_648,
      max_sources: 10,
      max_segment_bytes: 20_000_000,
      audio_core_seconds: 300,
      video_core_seconds: 60,
      overlap_seconds: 2,
      max_active_leaves: 512,
      delivery_concurrency: 2,
      per_operation_delivery_concurrency: 1,
      container_class: "LongMediaContainerStd4",
      container_max_instances: 2,
      profile_version: "channel-v1",
      audio_codec: "libmp3lame",
      audio_bitrate: "128k",
      video_codec: "libx264",
      video_crf: 23,
      video_audio_codec: "aac",
      video_audio_bitrate: "128k",
    });
  });
});

// A misspelt queue name would leave that queue at the default without a word.
describe("assertKnownQueues", () => {
  it("accepts per-queue figures that name the queues the worker runs", () => {
    expect(() => assertKnownQueues(["tasks", "upload-finish", "url-ingest", "media-read", "audio-peaks", "mail", "long-media-dispatch"])).not.toThrow();
  });

  it("refuses a per-queue figure for a queue the worker does not run", () => {
    expect(() => assertKnownQueues(["url-ingest", "mail"])).toThrow(/tasks/);
  });
});
