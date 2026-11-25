// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { getUnderstandConfig } from "@core/config/understand.js";
import { MONOREPO_ROOT } from "@core/config/env.js";
import { assertKnownQueues, getWorkerConfig, workerConcurrencyFor, workerConfigSchema } from "@core/config/worker.js";

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

  it("loads the approved long-media limits and source-file profile", () => {
    expect(getUnderstandConfig().long_media).toEqual({
      max_source_bytes: 2_147_483_648,
      max_sources: 10,
      max_segment_bytes: 20_000_000,
      audio_core_seconds: 300,
      video_core_seconds: 60,
      max_active_leaves: 512,
      max_concurrent_encoders: 2,
      delivery_concurrency: 2,
      per_operation_delivery_concurrency: 1,
      operation_lease_ms: 30_000,
      container_class: "LongMediaContainerStd4",
      container_max_instances: 2,
      profile_version: "source-file-v1",
      audio_codec: "libmp3lame",
      audio_bitrate: "128k",
      video_codec: "libx264",
      video_crf: 23,
      video_audio_codec: "aac",
      video_audio_bitrate: "128k",
    });
  });
});

// inner#1617: how often the sweep looks for unsettled charges, how old one must
// be before the sweep takes it from the settle that follows its delivery, and
// how many it takes per round.
describe("credit charge sweep", () => {
  it("reads the sweep's interval, minimum age and batch from config/worker.yaml", () => {
    expect(getWorkerConfig().credit_charge_sweep).toEqual({ interval_ms: 60_000, min_age_ms: 30_000, batch_size: 100 });
  });
});

// A misspelt queue name would leave that queue at the default without a word.
describe("assertKnownQueues", () => {
  it("accepts per-queue figures that name the queues the worker runs", () => {
    expect(() => assertKnownQueues(["tasks", "upload-finish", "url-ingest", "media-read", "audio-peaks", "mail", "long-media-dispatch", "credit-charge-sweep", "commerce-lot-mirror"])).not.toThrow();
  });

  it("refuses a per-queue figure for a queue the worker does not run", () => {
    expect(() => assertKnownQueues(["url-ingest", "mail"])).toThrow(/tasks/);
  });
});

// A waiter is judged at most every slot_wait_max_delay_ms and its check time is
// rewritten only once older than a third of slot_wait_stale_ms, so its check
// stays within the stale window only while the two together fit inside it
// (inner#1968).
describe("running-task gate settings", () => {
  it("accepts the shipped settings", () => {
    expect(workerConfigSchema.safeParse(parse(readFileSync(resolve(MONOREPO_ROOT, "config/worker.yaml"), "utf-8"))).success).toBe(true);
  });

  it("refuses a longest delay that lets a waiter's check age past the stale window", () => {
    const result = workerConfigSchema.safeParse({ slot_wait_stale_ms: 120_000, slot_wait_max_delay_ms: 90_000 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/slot_wait_max_delay_ms/);
  });
});

// #1580 test spec C-01: the deadline sweep's interval lives in config/worker.yaml.
describe("deadline sweep", () => {
  it("reads the sweep's interval from config/worker.yaml", () => {
    const shipped = parse(readFileSync(resolve(MONOREPO_ROOT, "config/worker.yaml"), "utf-8")) as { deadline_sweep: { interval_ms: number } };
    expect(getWorkerConfig().deadline_sweep.interval_ms).toBe(shipped.deadline_sweep.interval_ms);
  });

  it("defaults the interval to 30 seconds when the file leaves it out", () => {
    expect(workerConfigSchema.parse({}).deadline_sweep.interval_ms).toBe(30_000);
  });

  it("refuses an interval that is not a positive integer", () => {
    for (const interval_ms of [0, -1, 1.5]) {
      expect(workerConfigSchema.safeParse({ deadline_sweep: { interval_ms } }).success).toBe(false);
    }
  });
});
