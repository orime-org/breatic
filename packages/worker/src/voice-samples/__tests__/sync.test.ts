// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from "vitest";
import { getFullModelConfig, getVoiceSampleConfig } from "@breatic/domain";

import { planVoiceSamples } from "@worker/voice-samples/plan.js";
import {
  assertUploadsReachSampleAddress,
  resumablePredict,
  servedFromHead,
  syncVoiceSamples,
} from "@worker/voice-samples/sync.js";
import { StillRunning } from "@worker/providers/still-running.js";

/** A wait no test in the first case reaches: those runs never report still going. */
const NO_WAIT = { budgetMs: 1, now: () => 0, sleepUntil: async () => undefined };

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
      predict: async (job) => `https://out.test/${job.key}`,
      download: async () => Buffer.from("mp3"),
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
      predict: async (job) => {
        calls += 1;
        if (job.key.endsWith("b.mp3") && calls < 4) throw new Error("rate limit exceeded");
        if (job.key.endsWith("c.mp3")) throw new Error("voice not found");
        return `https://out.test/${job.key}`;
      },
      download: async () => Buffer.from("mp3"),
      upload: async () => undefined,
      attempts: 3,
    });
    expect(report.made).toBe(2);
    expect(report.failed).toEqual([{ key: "voice-samples/m/c.mp3", error: "voice not found" }]);
  });

  it("runs every step after the prediction again when one of them fails", async () => {
    const predict = vi.fn().mockResolvedValue("https://out.test/a.mp3");
    const download = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(Buffer.from("raw"));
    const finish = vi.fn()
      .mockRejectedValueOnce(new Error("ffmpeg exited 1"))
      .mockResolvedValue(Buffer.from("small"));
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("upload timed out"))
      .mockResolvedValue(undefined);
    const report = await syncVoiceSamples([JOBS[0]!], {
      exists: async () => false, predict, download, finish, upload, attempts: 4,
    });
    expect(report).toEqual({ present: 0, made: 1, failed: [] });
    expect(download).toHaveBeenCalledTimes(4);
    expect(finish).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls.map(([, bytes]) => String(bytes))).toEqual(["small", "small"]);
  });

  it("checks it can make a sample once, before the first prediction, and only when one is missing", async () => {
    const order: string[] = [];
    const deps = {
      predict: async (job: { key: string }) => { order.push(`predict ${job.key}`); return "https://out.test/x"; },
      download: async () => Buffer.from("mp3"),
      upload: async () => undefined,
      beforeMaking: async () => { order.push("check"); },
      attempts: 1,
      concurrency: 1,
    };
    await syncVoiceSamples(JOBS, { ...deps, exists: async (key) => key.endsWith("a.mp3") });
    expect(order).toEqual(["check", "predict voice-samples/m/b.mp3", "predict voice-samples/m/c.mp3"]);
    order.length = 0;
    await syncVoiceSamples(JOBS, { ...deps, exists: async () => true });
    expect(order).toEqual([]);
  });

  it("stops before any prediction when the check fails", async () => {
    const predict = vi.fn();
    await expect(syncVoiceSamples(JOBS, {
      exists: async () => false,
      predict,
      download: async () => Buffer.from("mp3"),
      upload: async () => undefined,
      beforeMaking: async () => { throw new Error("ffmpeg cannot encode h264"); },
      attempts: 3,
    })).rejects.toThrow("ffmpeg cannot encode h264");
    expect(predict).not.toHaveBeenCalled();
  });
});

describe("resumablePredict", () => {
  it("polls the task it already submitted on a retry, and submits again after the upstream failed it", async () => {
    const seen: Array<string | null> = [];
    let call = 0;
    const predict = resumablePredict(
      async (_job, resume) => {
        call += 1;
        seen.push(resume.storedTaskId);
        if (resume.storedTaskId === null) await resume.persistTaskId(`task-${call}`);
        if (call === 1) throw new Error("poll ran out of time");
        if (call === 2) throw new Error("upstream failed the task");
        return "https://out.test/a.mp3";
      },
      (err) => err instanceof Error && err.message === "upstream failed the task",
      NO_WAIT,
    );
    const job = JOBS[0]!;
    await expect(predict(job)).rejects.toThrow("poll ran out of time");
    await expect(predict(job)).rejects.toThrow("upstream failed the task");
    await expect(predict(job)).resolves.toBe("https://out.test/a.mp3");
    expect(seen).toEqual([null, "task-1", null]);
  });

  // Table 4.1a, not submitted: the upstream answers failed on the first
  // question, so the next pass submits a new task.
  it("submits again after the upstream failed a task it had just been given", async () => {
    const seen: Array<string | null> = [];
    let call = 0;
    const predict = resumablePredict(
      async (_job, resume) => {
        call += 1;
        seen.push(resume.storedTaskId);
        if (resume.storedTaskId === null) await resume.persistTaskId(`task-${call}`);
        if (call === 1) throw new Error("upstream failed the task");
        return "https://out.test/a.mp3";
      },
      (err) => err instanceof Error && err.message === "upstream failed the task",
      NO_WAIT,
    );
    const job = JOBS[0]!;
    await expect(predict(job)).rejects.toThrow("upstream failed the task");
    await expect(predict(job)).resolves.toBe("https://out.test/a.mp3");
    expect(seen).toEqual([null, null]);
  });

  // Table 4.1a, not submitted x other error: the submit failed before an id
  // was stored, and may still have reached the upstream.
  it("submits again after a submit that stored no id, and says it may be the upstream's second", async () => {
    const calls: Array<{ stored: string | null; retryStarting: boolean }> = [];
    const predict = resumablePredict(
      async (_job, resume) => {
        calls.push({ stored: resume.storedTaskId, retryStarting: resume.retryStarting });
        if (calls.length === 1) throw new Error("socket hang up");
        return "https://out.test/a.mp3";
      },
      () => false,
      NO_WAIT,
    );
    const job = JOBS[0]!;
    await expect(predict(job)).rejects.toThrow("socket hang up");
    await expect(predict(job)).resolves.toBe("https://out.test/a.mp3");
    expect(calls).toEqual([
      { stored: null, retryStarting: false },
      { stored: null, retryStarting: true },
    ]);
  });

  it("does not say a sample may be submitted twice after the upstream failed it", async () => {
    const flags: boolean[] = [];
    const predict = resumablePredict(
      async (_job, resume) => {
        flags.push(resume.retryStarting);
        if (resume.storedTaskId === null) await resume.persistTaskId("task-1");
        if (flags.length === 1) throw new Error("upstream failed the task");
        return "https://out.test/a.mp3";
      },
      () => true,
      NO_WAIT,
    );
    const job = JOBS[0]!;
    await expect(predict(job)).rejects.toThrow();
    await predict(job);
    expect(flags).toEqual([false, false]);
  });

  describe("while the upstream is still going", () => {
    /**
     * A clock the test moves, and a wait that moves it.
     * @returns The clock and the waits it was asked for.
     */
    function clock(): { waiting: Parameters<typeof resumablePredict>[2]; waits: number[] } {
      const waits: number[] = [];
      let now = 1_000;
      return {
        waits,
        waiting: {
          budgetMs: 10_000,
          now: () => now,
          sleepUntil: async (at: number) => {
            waits.push(at);
            now = at;
          },
        },
      };
    }

    it("waits until the time the poll named and asks the same task again, submitting once", async () => {
      const { waiting, waits } = clock();
      const seen: Array<string | null> = [];
      let call = 0;
      const predict = resumablePredict(
        async (_job, resume) => {
          call += 1;
          seen.push(resume.storedTaskId);
          if (resume.storedTaskId === null) await resume.persistTaskId("task-1");
          if (call < 3) throw new StillRunning(waiting.now() + 3_000);
          return "https://out.test/a.mp3";
        },
        () => false,
        waiting,
      );

      await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
      expect(seen).toEqual([null, "task-1", "task-1"]);
      expect(waits).toEqual([4_000, 7_000]);
    });

    it("gives the sample up once it has waited the whole budget since it was submitted", async () => {
      const { waiting } = clock();
      const predict = resumablePredict(
        async (_job, resume) => {
          if (resume.storedTaskId === null) await resume.persistTaskId("task-1");
          throw new StillRunning(waiting.now() + 3_000);
        },
        () => false,
        waiting,
      );

      const err = await predict(JOBS[0]!).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StillRunning);
      expect(waiting.now()).toBeGreaterThanOrEqual(1_000 + 10_000);
    });

    it("keeps the task after giving up, so the next pass asks it again", async () => {
      const { waiting } = clock();
      const seen: Array<string | null> = [];
      let giveUp = true;
      const predict = resumablePredict(
        async (_job, resume) => {
          seen.push(resume.storedTaskId);
          if (resume.storedTaskId === null) await resume.persistTaskId("task-1");
          if (giveUp) throw new StillRunning(waiting.now() + 3_000);
          return "https://out.test/a.mp3";
        },
        () => false,
        waiting,
      );

      await predict(JOBS[0]!).catch(() => undefined);
      giveUp = false;

      await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
      expect(seen.at(-1)).toBe("task-1");
    });
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
