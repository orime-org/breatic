// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from "vitest";
import { getFullModelConfig, getVoiceSampleConfig } from "@breatic/domain";

import { planVoiceSamples } from "@worker/voice-samples/plan.js";
import { assertUploadsReachSampleAddress, servedFromHead, syncVoiceSamples } from "@worker/voice-samples/sync.js";

const JOBS = [
  { model: "m", key: "voice-samples/m/a.mp3", body: {} },
  { model: "m", key: "voice-samples/m/b.mp3", body: {} },
  { model: "m", key: "voice-samples/m/c.mp3", body: {} },
];

describe("syncVoiceSamples", () => {
  it("makes only the samples the address does not serve", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    const report = await syncVoiceSamples(JOBS, {
      exists: async (key) => key.endsWith("a.mp3"),
      generate: async () => Buffer.from("mp3"),
      upload,
      attempts: 1,
    });
    expect(report).toEqual({ present: 1, made: 2, failed: [] });
    expect(upload.mock.calls.map(([key]) => key)).toEqual(["voice-samples/m/b.mp3", "voice-samples/m/c.mp3"]);
  });

  it("tries a failed sample again, and reports the ones that never came", async () => {
    let calls = 0;
    const report = await syncVoiceSamples(JOBS, {
      exists: async () => false,
      generate: async (job) => {
        calls += 1;
        if (job.key.endsWith("b.mp3") && calls < 4) throw new Error("rate limit exceeded");
        if (job.key.endsWith("c.mp3")) throw new Error("voice not found");
        return Buffer.from("mp3");
      },
      upload: async () => undefined,
      attempts: 3,
    });
    expect(report.made).toBe(2);
    expect(report.failed).toEqual([{ key: "voice-samples/m/c.mp3", error: "voice not found" }]);
  });
});

describe("servedFromHead", () => {
  it("reads a success as served and a 404 as missing", () => {
    expect(servedFromHead("k.mp3", 200)).toBe(true);
    expect(servedFromHead("k.mp3", 404)).toBe(false);
  });

  it("stops on any other answer, which says nothing about whether the sample is there", () => {
    for (const status of [403, 429, 500, 503]) {
      expect(() => servedFromHead("k.mp3", status)).toThrow(`k.mp3: HEAD answered ${status}`);
    }
  });
});

describe("assertUploadsReachSampleAddress", () => {
  const sampleUrl = (key: string): string => `https://samples.test/${key}`;

  it("passes when the storage settings publish where every deployment plays from", () => {
    expect(() => assertUploadsReachSampleAddress((key) => `https://samples.test/${key}`, sampleUrl)).not.toThrow();
  });

  it("stops when the storage settings point at another bucket", () => {
    expect(() => assertUploadsReachSampleAddress((key) => `https://cdn.other/${key}`, sampleUrl)).toThrow(
      "The storage settings publish voice-samples/probe.mp3 at https://cdn.other/voice-samples/probe.mp3, " +
        "but every deployment plays it from https://samples.test/voice-samples/probe.mp3",
    );
  });
});

describe("the catalog's voice samples", () => {
  it("each have a sentence in the language their key names", async () => {
    const models = getFullModelConfig("tts").models;
    const keys = models.flatMap((m) =>
      (m.voices ?? []).flatMap((v) => [
        ...(v.sample_key === undefined ? [] : [v.sample_key]),
        ...Object.values(v.sample_keys ?? {}),
      ]),
    );
    const jobs = planVoiceSamples(models, getVoiceSampleConfig()).map((job) => job.key);
    expect(new Set(jobs)).toEqual(new Set(keys));
    expect(jobs).toHaveLength(new Set(jobs).size);
    expect(keys.length).toBeGreaterThan(0);
  });
});
