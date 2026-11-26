// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import { MiniToolContainerStd1, type MiniToolEnv } from "@ingest/jobs/mini-tool-container.js";

const runtime = vi.hoisted(() => ({
  sent: [] as Request[],
  outbound: [] as Record<string, unknown>[],
  schedules: [] as { at: Date; payload: unknown }[],
  starts: 0,
  startError: null as Error | null,
  fetchError: null as Error | null,
  outboundError: null as Error | null,
  destroyError: null as Error | null,
  deletedSchedules: [] as string[],
  fetchStatus: 202,
  runningAfterStart: true,
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
    async start(): Promise<void> {
      runtime.starts += 1;
      (this.ctx as { container: { running: boolean } }).container.running = runtime.runningAfterStart;
      if (runtime.startError !== null) throw runtime.startError;
    }
    async destroy(): Promise<void> { if (runtime.destroyError !== null) throw runtime.destroyError; (this.ctx as { container: { running: boolean } }).container.running = false; }
    async setOutboundByHosts(value: Record<string, unknown>): Promise<void> { runtime.outbound.push(value); if (runtime.outboundError !== null) throw runtime.outboundError; }
    async schedule(at: Date, _name: string, payload: unknown): Promise<void> { runtime.schedules.push({ at, payload }); }
    deleteSchedules(name: string): void { runtime.deletedSchedules.push(name); }
    async containerFetch(request: Request): Promise<Response> { runtime.sent.push(request); if (runtime.fetchError !== null) throw runtime.fetchError; return new Response(null, { status: runtime.fetchStatus }); }
  },
}));

const NOW = 1700000000000;
// §93 D5 (frames-split design §7.17 frame row 「不得把presentation ordinal当原解码n」, 「唯一写点：worker的配方构造」): a job frame recipe names a full-ledger entry and its PNG target, not a frameIndex.
const PLAN: MiniToolPlanJobRequest = {
  limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
  schemaVersion: 2, jobId: "plan-chunk-1", containerClass: "MiniToolContainerStd1", deadlineAt: NOW + 7200000,
  inputs: [
    { inputId: "20000000-0000-4000-8000-000000000001", storageKey: "fixtures/source-a.mp4" },
    { inputId: "20000000-0000-4000-8000-000000000002", storageKey: "fixtures/source-b.mp4" },
  ],
  outputs: [
    { outputIndex: 8, storageKey: "results/T/o08.png", contentType: "image/png", coverKey: "results/T/o08.cover.png", recipe: { kind: "frame", inputId: "20000000-0000-4000-8000-000000000002", grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 50, realFrameCount: 50 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 30, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } },
    { outputIndex: 9, storageKey: "results/T/o09.png", contentType: "image/png", recipe: { kind: "frame", inputId: "20000000-0000-4000-8000-000000000001", grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 50, realFrameCount: 50 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 31, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } },
  ],
};
const WRITTEN = { sha256: "a".repeat(64), sizeBytes: 64, contentType: "image/png" };
const MEDIA = { width: 960, height: 448, durationSeconds: null, cover: null };

/**
 * Make only the storage and lifecycle stand-in used by this Node unit suite.
 * @param running - The fixture's initial observed runtime flag.
 * @returns A DO whose Cloudflare container base is mocked, never a real image.
 * @throws {never} Never.
 */
function owner(running = true): { object: MiniToolContainerStd1; storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>();
  const ctx = {
    id: { toString: () => "unit-only-object" }, container: { running },
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => storage.delete(key),
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({ get: async (key: string) => storage.get(key), put: async (key: string, value: unknown) => { storage.set(key, value); } }),
    },
  };
  return { object: new MiniToolContainerStd1(ctx as unknown as ConstructorParameters<typeof MiniToolContainerStd1>[0], {} as MiniToolEnv), storage };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  runtime.sent.length = 0;
  runtime.outbound.length = 0;
  runtime.schedules.length = 0;
  runtime.starts = 0;
  runtime.startError = null;
  runtime.fetchError = null;
  runtime.outboundError = null;
  runtime.destroyError = null;
  runtime.deletedSchedules.length = 0;
  runtime.fetchStatus = 202;
  runtime.runningAfterStart = true;
});

afterEach(() => { vi.restoreAllMocks(); });

describe("planned DO state with a mocked container base, not an image", () => {
  it("dispatches both exact sources, indexed recipes and the original complete deadline", async () => {
    const { object } = owner();
    expect(await object.submit(PLAN)).toEqual({ kind: "report", report: { schemaVersion: 2, state: "running" } });
    const sent = await runtime.sent[0]!.json<Record<string, unknown>>();
    expect(sent).toMatchObject({ schemaVersion: 2, deadlineAt: PLAN.deadlineAt });
    expect(sent.inputs).toEqual([
      expect.objectContaining({ inputId: PLAN.inputs[0]!.inputId, url: expect.stringContaining("fixtures/source-a.mp4") }),
      expect.objectContaining({ inputId: PLAN.inputs[1]!.inputId, url: expect.stringContaining("fixtures/source-b.mp4") }),
    ]);
    expect(sent.outputs).toEqual(PLAN.outputs.map((output) => expect.objectContaining({ outputIndex: output.outputIndex, key: output.storageKey, recipe: output.recipe })));
    expect(runtime.schedules).toEqual([{ at: new Date(PLAN.deadlineAt), payload: expect.objectContaining({ attemptId: expect.any(String) }) }]);
  });

  it("replays the same frozen request without a new start, attempt or deadline", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const held = structuredClone(storage.get("job"));
    expect(await object.submit({ outputs: PLAN.outputs, inputs: PLAN.inputs, deadlineAt: PLAN.deadlineAt, containerClass: PLAN.containerClass, jobId: PLAN.jobId, schemaVersion: 2, limits: PLAN.limits })).toEqual({ kind: "report", report: { schemaVersion: 2, state: "running" } });
    expect(storage.get("job")).toEqual(held);
    expect(runtime.starts).toBe(1);
    expect(runtime.schedules).toHaveLength(1);
  });

  it("refuses altered deadline, source, class, output index, key or recipe and preserves held facts", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const held = structuredClone(storage.get("job"));
    const changes: MiniToolPlanJobRequest[] = [
      { ...PLAN, deadlineAt: PLAN.deadlineAt + 1 },
      { ...PLAN, containerClass: "MiniToolContainerStd4" },
      { ...PLAN, inputs: [{ ...PLAN.inputs[0]!, storageKey: "fixtures/other.mp4" }, PLAN.inputs[1]!] },
      { ...PLAN, outputs: [{ ...PLAN.outputs[0]!, outputIndex: 16 }, PLAN.outputs[1]!] },
      { ...PLAN, outputs: [{ ...PLAN.outputs[0]!, storageKey: "results/other.png" }, PLAN.outputs[1]!] },
      { ...PLAN, outputs: [{ ...PLAN.outputs[0]!, recipe: { kind: "frame", inputId: PLAN.inputs[0]!.inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 50, realFrameCount: 50 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 31, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }, PLAN.outputs[1]!] },
    ];
    for (const changed of changes) {
      expect(await object.submit(changed)).toEqual({ kind: "conflict" });
      expect(storage.get("job")).toEqual(held);
    }
    expect(runtime.starts).toBe(1);
  });

  it("keeps actual written index8 in a failed partial report instead of renumbering it to zero", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    const token = await object.claimOutputWrite(PLAN.outputs[0]!.storageKey, attemptId);
    expect(token).toEqual(expect.any(String));
    await object.noteWritten(PLAN.outputs[0]!.storageKey, WRITTEN, attemptId, token!);
    await object.noteReported({ schemaVersion: 2, attemptId, ok: false, cpuUsec: 123, outputs: [{ outputIndex: 8, storageKey: PLAN.outputs[0]!.storageKey, ...MEDIA }], reason: "tool_failed" });
    const result = await object.report();
    expect(result).toEqual({ schemaVersion: 2, state: "failed", reason: "tool_failed", usage: { wallMs: 0, cpuUsec: 123 }, outputs: [{ outputIndex: 8, storageKey: PLAN.outputs[0]!.storageKey, ...WRITTEN, ...MEDIA, upright: null }] });
    expect(await object.submit(PLAN)).toEqual({ kind: "report", report: result });
    expect(runtime.starts).toBe(1);
  });

  it("rejects conflicting measurements and stale attempts without replacing the original write", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    const token = await object.claimOutputWrite(PLAN.outputs[0]!.storageKey, attemptId);
    expect(token).toEqual(expect.any(String));
    await object.noteWritten(PLAN.outputs[0]!.storageKey, WRITTEN, attemptId, token!);
    const original = structuredClone(storage.get("job"));
    await expect(object.noteWritten(PLAN.outputs[0]!.storageKey, { ...WRITTEN, sha256: "b".repeat(64) }, attemptId, token!)).rejects.toThrow();
    await expect(object.noteWritten(PLAN.outputs[1]!.storageKey, WRITTEN, "old-attempt")).rejects.toThrow();
    expect(storage.get("job")).toEqual(original);
  });

  it("does not accept self-declared done without all Worker-measured main outputs", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    await object.noteReported({ schemaVersion: 2, attemptId, ok: true, cpuUsec: 123, outputs: PLAN.outputs.map((output) => ({ outputIndex: output.outputIndex, storageKey: output.storageKey, ...MEDIA })) });
    expect(await object.report()).toMatchObject({ schemaVersion: 2, state: "failed", outputs: [] });
  });

  it("refuses stale or wrong index/key media reports without mutating the running job", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    const held = structuredClone(storage.get("job"));
    for (const body of [
      { schemaVersion: 2 as const, attemptId: "old-attempt", ok: false, cpuUsec: null, outputs: [] },
      { schemaVersion: 2 as const, attemptId, ok: true, cpuUsec: 123, outputs: [{ outputIndex: 8, storageKey: PLAN.outputs[1]!.storageKey, ...MEDIA }] },
    ]) {
      await expect(object.noteReported(body)).rejects.toThrow();
      expect(storage.get("job")).toEqual(held);
    }
  });

  it("answers a plan submitted at or after its deadline as failed with reason expired, starting nothing", async () => {
    const { object } = owner();
    vi.spyOn(Date, "now").mockReturnValue(PLAN.deadlineAt);
    expect(await object.submit(PLAN)).toMatchObject({ kind: "report", report: { schemaVersion: 2, state: "failed", reason: "expired" } });
    expect(runtime.starts).toBe(0);
  });

  it("keeps an ended job's unknown usage when its container's report lands after the end", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    await object.expireJob({ attemptId });
    const ended = await object.report();
    expect(ended).toMatchObject({ schemaVersion: 2, state: "failed", reason: "expired", usage: null });
    const held = structuredClone(storage.get("job"));
    await object.noteReported({ schemaVersion: 2, attemptId, ok: false, cpuUsec: 123, outputs: [], reason: "tool_failed" });
    expect(storage.get("job")).toEqual(held);
    expect(await object.report()).toEqual(ended);
  });
});


const NO_START_FACTS = { startRequested: false, startResolved: false, runningObserved: false, runDispatchAttempted: false, runAcknowledged: false };

describe("planned startup facts preserve unknown consumption, with only the container base mocked", () => {
  it("preserves a failed start with running false and reports unknown usage without restarting on replay", async () => {
    const { object, storage } = owner(false);
    runtime.runningAfterStart = false;
    runtime.startError = new Error("start command outcome is unknown");
    expect(await object.submit(PLAN)).toMatchObject({ kind: "start_failed" });
    const held = structuredClone(storage.get("job"));
    expect(await object.report()).toMatchObject({ schemaVersion: 2, state: "failed", usage: null, outputs: [] });
    expect(held).toMatchObject({ request: PLAN, startFacts: { ...NO_START_FACTS, startRequested: true } });
    const attemptId = (held as { state: { attemptId: string } }).state.attemptId;
    expect(await object.submit(PLAN)).toMatchObject({ kind: "report", report: { state: "failed", usage: null } });
    expect((storage.get("job") as { state: { attemptId: string } }).state.attemptId).toBe(attemptId);
    expect(storage.get("job")).toEqual(held);
    expect(runtime.starts).toBe(1);
    expect(runtime.sent).toHaveLength(0);
  });

  it("preserves observed running after a throwing start without turning that flag into measured usage", async () => {
    const { object, storage } = owner(false);
    runtime.startError = new Error("start reply was lost after the runtime became running");
    expect(await object.submit(PLAN)).toMatchObject({ kind: "start_failed" });
    expect(await object.report()).toMatchObject({ state: "failed", usage: null });
    expect(storage.get("job")).toMatchObject({ request: PLAN, startFacts: { ...NO_START_FACTS, startRequested: true, runningObserved: true } });
    const held = structuredClone(storage.get("job"));
    expect(await object.submit(PLAN)).toMatchObject({ kind: "report", report: { state: "failed", usage: null } });
    expect(storage.get("job")).toEqual(held);
    expect(runtime.starts).toBe(1);
  });

  it("keeps the original attempt and unknown usage when the run request reply is lost", async () => {
    const { object, storage } = owner(false);
    runtime.fetchError = new Error("container run acknowledgement was lost");
    expect(await object.submit(PLAN)).toMatchObject({ kind: "start_failed" });
    expect(await object.report()).toMatchObject({ state: "failed", usage: null });
    expect(storage.get("job")).toMatchObject({ request: PLAN, startFacts: { ...NO_START_FACTS, startRequested: true, startResolved: true, runningObserved: true, runDispatchAttempted: true } });
    const held = structuredClone(storage.get("job"));
    expect(await object.submit(PLAN)).toMatchObject({ kind: "report", report: { state: "failed", usage: null } });
    expect(storage.get("job")).toEqual(held);
    expect(runtime.starts).toBe(1);
    expect(runtime.sent).toHaveLength(1);
  });

  it("does not infer a meter from a non-202 run response after start resolved", async () => {
    const { object, storage } = owner(false);
    runtime.fetchStatus = 503;
    expect(await object.submit(PLAN)).toMatchObject({ kind: "start_failed" });
    expect(await object.report()).toMatchObject({ state: "failed", usage: null });
    expect(storage.get("job")).toMatchObject({ request: PLAN, startFacts: { ...NO_START_FACTS, startRequested: true, startResolved: true, runningObserved: true, runDispatchAttempted: true } });
  });

  // An error thrown across the Durable Object RPC boundary loses its class and name, so the outcome is a plain value.
  it("answers a run the container would not take as a plain start_failed value, which the route turns into 503", async () => {
    const { object } = owner(false);
    runtime.fetchStatus = 503;
    expect(structuredClone(await object.submit(PLAN))).toEqual({ kind: "start_failed", reason: "the run was answered 503" });
  });

  it("retains the accepted request when outbound setup fails before any start call", async () => {
    const { object, storage } = owner(false);
    runtime.outboundError = new Error("outbound capability setup failed");
    expect(await object.submit(PLAN)).toMatchObject({ kind: "start_failed" });
    expect(await object.report()).toMatchObject({ state: "failed", usage: null });
    expect(storage.get("job")).toMatchObject({ request: PLAN, startFacts: NO_START_FACTS });
    expect(runtime.starts).toBe(0);
    expect(runtime.sent).toHaveLength(0);
  });

  it("does not fabricate known usage from a later stop callback without any run meter", async () => {
    const { object, storage } = owner(false);
    runtime.fetchError = new Error("run response was lost");
    expect(await object.submit(PLAN)).toMatchObject({ kind: "start_failed" });
    const held = structuredClone(storage.get("job"));
    await object.onStop({ exitCode: 0, reason: "exit" });
    expect(await object.report()).toMatchObject({ state: "failed", usage: null });
    expect((storage.get("job") as { state: unknown }).state).toEqual((held as { state: unknown }).state);
    expect(await object.submit(PLAN)).toMatchObject({ kind: "report", report: { state: "failed", usage: null } });
    expect(runtime.starts).toBe(1);
  });

  // S6d D3-3 (inner#1306 §91): the job report hands a packed output's geometry on to the worker.
  // Frames-split design §7.17 grid_count: the request declares no output and writes no object; the count reaches the report.
  const COUNT_JOB = { ...PLAN, jobId: "plan-count-1", outputs: [],
    count: { kind: "grid_count", inputId: PLAN.inputs[0]!.inputId, gridStart: { numerator: 0, denominator: 1 }, fps: { numerator: 25, denominator: 1 }, gridEnd: null } } as MiniToolPlanJobRequest;
  const COUNTED = { lastVideoTime: { numerator: 49, denominator: 25 }, sourceFrames: 50 };

  it("GC06 a grid count job sends its count recipe and no output, and its done report carries the container's count", async () => {
    const { object, storage } = owner();
    expect(await object.submit(COUNT_JOB)).toEqual({ kind: "report", report: { schemaVersion: 2, state: "running" } });
    const sent = await runtime.sent[0]!.json<Record<string, unknown>>();
    expect(sent).toMatchObject({ outputs: [], count: COUNT_JOB.count });
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    await object.noteReported({ schemaVersion: 2, attemptId, ok: true, cpuUsec: 123, outputs: [], count: COUNTED });
    expect(await object.report()).toEqual({ schemaVersion: 2, state: "done", outputs: [], usage: { wallMs: 0, cpuUsec: 123 }, count: COUNTED });
  });

  it("GC07 a count job's ok report without its count, or an output job's report with one, is refused", async () => {
    const counting = owner();
    await counting.object.submit(COUNT_JOB);
    const countAttempt = (counting.storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    await expect(counting.object.noteReported({ schemaVersion: 2, attemptId: countAttempt, ok: true, cpuUsec: 1, outputs: [] })).rejects.toThrow(/count/);
    const writing = owner();
    await writing.object.submit(PLAN);
    const attemptId = (writing.storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    await expect(writing.object.noteReported({ schemaVersion: 2, attemptId, ok: false, cpuUsec: 1, outputs: [], reason: "tool_failed", count: COUNTED })).rejects.toThrow(/count/);
  });

  it("PK03 the report carries a packed output's geometry as the container reported it", async () => {
    const GEOMETRY = { packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };
    const [source, chunk] = PLAN.inputs;
    const target = { width: 192, height: 64, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "packed", crf: 18, preset: "medium" };
    const stitch = { ...PLAN, jobId: "plan-stitch-1", outputs: [{ outputIndex: 0, storageKey: "results/T/stitch.mp4", contentType: "video/mp4",
      recipe: { kind: "stitch", inputId: source!.inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 50, realFrameCount: 50 },
        chunks: [{ inputId: chunk!.inputId, frames: { start: 0, end: 50 } }], audio: false, target } }] } as unknown as MiniToolPlanJobRequest;
    const { object, storage } = owner();
    await object.submit(stitch);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    const token = await object.claimOutputWrite("results/T/stitch.mp4", attemptId);
    await object.noteWritten("results/T/stitch.mp4", { ...WRITTEN, contentType: "video/mp4" }, attemptId, token!);
    await object.noteReported({ schemaVersion: 2, attemptId, ok: true, cpuUsec: 123, outputs: [{ outputIndex: 0, storageKey: "results/T/stitch.mp4", width: 192, height: 64, durationSeconds: 2, cover: null, packing: GEOMETRY }] } as never);
    expect(await object.report()).toMatchObject({ outputs: [{ outputIndex: 0, storageKey: "results/T/stitch.mp4", packing: GEOMETRY }] });
  });
});

describe("an old-protocol job whose container cannot be reached", () => {
  // The start failure's own cleanup re-registers the outbound handlers, and the platform refuses that the same way.
  it("still answers start_failed when clearing its outbound handlers fails too", async () => {
    const { object } = owner(false);
    runtime.outboundError = new Error("Updating sidecar egress config failed with: 404");
    const job = { jobId: "task:t1", containerClass: "MiniToolContainerStd1", deadlineAt: NOW + 7200000, op: "trim", params: {},
      input: { storageKey: "fixtures/source-a.mp4" }, outputs: [{ storageKey: "results/T/out.mp4", contentType: "video/mp4" }] } as never;
    expect(await object.submit(job)).toMatchObject({ kind: "start_failed" });
    expect(await object.report()).toBeNull();
    expect(runtime.deletedSchedules).toEqual(["expireJob"]);
  });

  it("logs each cleanup effect the platform refuses and still runs the others", async () => {
    const { object } = owner(false);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime.outboundError = new Error("Updating sidecar egress config failed with: 404");
    runtime.destroyError = new Error("destroy refused");
    const job = { jobId: "task:t1", containerClass: "MiniToolContainerStd1", deadlineAt: NOW + 7200000, op: "trim", params: {},
      input: { storageKey: "fixtures/source-a.mp4" }, outputs: [{ storageKey: "results/T/out.mp4", contentType: "video/mp4" }] } as never;
    expect(await object.submit(job)).toMatchObject({ kind: "start_failed" });
    const effects = logged.mock.calls.filter(([label]) => label === "ingest_mini_tool_effect_failed").map(([, ctx]) => (ctx as { effect: string }).effect);
    expect(effects).toEqual(["destroy", "clearOverrides"]);
    expect(runtime.deletedSchedules).toEqual(["expireJob"]);
  });
});
