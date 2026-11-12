// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, vi } from "vitest";
import { getFullModelConfig, getVoiceSampleConfig } from "@breatic/domain";

import { planVoiceSamples } from "@worker/voice-samples/plan.js";
import { SendNotAccepted } from "@breatic/provider";
import type { MediaAnswer, MediaRunner, MediaTicket } from "@breatic/provider/media";

import { MediaRunFailed } from "@worker/handlers/media-run.js";
import {
  assertUploadsReachSampleAddress,
  servedFromHead,
  syncVoiceSamples,
  ticketedPredict,
} from "@worker/voice-samples/sync.js";
import { StillRunning } from "@worker/handlers/still-running.js";

const JOBS = [
  { model: "m", key: "voice-samples/m/a.mp3", input: { prompt: "Hello.", params: {} } },
  { model: "m", key: "voice-samples/m/b.mp3", input: { prompt: "Hello.", params: {} } },
  { model: "m", key: "voice-samples/m/c.mp3", input: { prompt: "Hello.", params: {} } },
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

describe("ticketedPredict", () => {
  /** A ticket as provider writes one: a version, a phase and the steps a send state reads. */
  const ticket = (version: number, phase: "send" | "running"): MediaTicket =>
    ({ version, phase, steps: [{ kind: "generate", status: phase === "send" ? "pending" : "submitted" }] });
  const NONE = { clones: [], retiredClones: [], warnings: [] };
  const send = (t: MediaTicket): MediaAnswer => ({ state: "send", ticket: t, step: { kind: "generate" }, ...NONE });
  const running = (t: MediaTicket, askAgainAt: number): MediaAnswer => ({ state: "running", ticket: t, askAgainAt, ...NONE });
  const done: MediaAnswer = { state: "done", outputs: [{ kind: "url", url: "https://out.test/a.mp3" }], costs: [], servedBy: "wavespeed", ...NONE };

  /**
   * A runner whose answers each case scripts.
   * @param answers - What each call answers.
   * @returns The runner.
   */
  function runnerOf(answers: Partial<Record<"plan" | "send" | "poll" | "recover", ReturnType<typeof vi.fn>>>): MediaRunner {
    return {
      plan: answers.plan ?? vi.fn(),
      send: answers.send ?? vi.fn(),
      poll: answers.poll ?? vi.fn(),
      recover: answers.recover ?? vi.fn(),
      ticketFromLegacy: vi.fn(),
      abandon: vi.fn(),
    };
  }

  /**
   * A clock the test moves, and a wait that moves it.
   * @returns The clock and the waits it was asked for.
   */
  function clock(): { waiting: Parameters<typeof ticketedPredict>[1]; waits: number[] } {
    const waits: number[] = [];
    let now = 1_000;
    return {
      waits,
      waiting: {
        budgetMs: 10_000,
        pollIntervalMs: 3_000,
        now: () => now,
        sleepUntil: async (at: number) => {
          waits.push(at);
          now = at;
        },
      },
    };
  }

  it("plans a sample in our param names and answers where its output is", async () => {
    const runner = runnerOf({ plan: vi.fn(async () => send(ticket(1, "send"))), send: vi.fn(async () => done) });
    const predict = ticketedPredict(runner, clock().waiting);

    await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
    expect(runner.plan).toHaveBeenCalledWith("m", JOBS[0]!.input, { mode: "default" }, expect.objectContaining({ idempotencyKey: JOBS[0]!.key }));
  });

  it("recovers a send that got no answer on the next pass, instead of planning again", async () => {
    const planned = ticket(1, "send");
    const runner = runnerOf({
      plan: vi.fn(async () => send(planned)),
      send: vi.fn(async () => Promise.reject(new Error("socket hang up"))),
      recover: vi.fn(async () => done),
    });
    const predict = ticketedPredict(runner, clock().waiting);

    await expect(predict(JOBS[0]!)).rejects.toThrow("socket hang up");
    await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
    expect(runner.plan).toHaveBeenCalledTimes(1);
    expect(runner.recover).toHaveBeenCalledWith(planned, expect.anything());
  });

  it("sends the same ticket again after an upstream did not take it", async () => {
    const planned = ticket(1, "send");
    const runner = runnerOf({
      plan: vi.fn(async () => send(planned)),
      send: vi.fn().mockRejectedValueOnce(new SendNotAccepted("wavespeed", new Error("no slot"))).mockResolvedValueOnce(done),
    });
    const predict = ticketedPredict(runner, clock().waiting);

    await expect(predict(JOBS[0]!)).rejects.toBeInstanceOf(SendNotAccepted);
    await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
    expect(runner.plan).toHaveBeenCalledTimes(1);
    expect(runner.recover).not.toHaveBeenCalled();
    expect(runner.send).toHaveBeenNthCalledWith(2, planned, expect.anything());
  });

  it("plans again after provider answered the run failed", async () => {
    const runner = runnerOf({
      plan: vi.fn(async () => send(ticket(1, "send"))),
      send: vi.fn()
        .mockResolvedValueOnce({ state: "failed", reason: new Error("refused"), costs: [], ...NONE })
        .mockResolvedValueOnce(done),
    });
    const predict = ticketedPredict(runner, clock().waiting);

    await expect(predict(JOBS[0]!)).rejects.toBeInstanceOf(MediaRunFailed);
    await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
    expect(runner.plan).toHaveBeenCalledTimes(2);
  });

  describe("while the upstream is still going", () => {
    it("waits until the time the answer named and asks the same ticket again, planning once", async () => {
      const { waiting, waits } = clock();
      const taken = ticket(2, "running");
      const runner = runnerOf({
        plan: vi.fn(async () => send(ticket(1, "send"))),
        send: vi.fn(async () => running(taken, 4_000)),
        poll: vi.fn().mockResolvedValueOnce(running(taken, 7_000)).mockResolvedValueOnce(done),
      });
      const predict = ticketedPredict(runner, waiting);

      await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
      expect(runner.plan).toHaveBeenCalledTimes(1);
      expect(runner.poll).toHaveBeenCalledWith(taken, expect.anything());
      expect(waits).toEqual([4_000, 7_000]);
    });

    it("gives the sample up once it has waited the whole budget since its first try", async () => {
      const { waiting } = clock();
      const taken = ticket(2, "running");
      const runner = runnerOf({
        plan: vi.fn(async () => send(ticket(1, "send"))),
        send: vi.fn(async () => running(taken, waiting.now() + 3_000)),
        poll: vi.fn(async () => running(taken, waiting.now() + 3_000)),
      });

      const err = await ticketedPredict(runner, waiting)(JOBS[0]!).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StillRunning);
      expect(waiting.now()).toBeGreaterThanOrEqual(1_000 + 10_000);
    });

    it("keeps the ticket after giving up, so the next pass asks it again", async () => {
      const { waiting } = clock();
      const taken = ticket(2, "running");
      let giveUp = true;
      const runner = runnerOf({
        plan: vi.fn(async () => send(ticket(1, "send"))),
        send: vi.fn(async () => running(taken, waiting.now() + 3_000)),
        poll: vi.fn(async () => (giveUp ? running(taken, waiting.now() + 3_000) : done)),
      });
      const predict = ticketedPredict(runner, waiting);

      await predict(JOBS[0]!).catch(() => undefined);
      giveUp = false;

      await expect(predict(JOBS[0]!)).resolves.toBe("https://out.test/a.mp3");
      expect(runner.plan).toHaveBeenCalledTimes(1);
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
