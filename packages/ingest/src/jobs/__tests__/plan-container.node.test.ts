// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import { MiniToolContainerStd1, type MiniToolEnv } from "@ingest/jobs/mini-tool-container.js";

const runtime = vi.hoisted(() => ({
  sent: [] as Request[],
  outbound: [] as Record<string, unknown>[],
  schedules: [] as { at: Date; payload: unknown }[],
  starts: 0,
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
    async start(): Promise<void> { runtime.starts += 1; }
    async destroy(): Promise<void> {}
    async setOutboundByHosts(value: Record<string, unknown>): Promise<void> { runtime.outbound.push(value); }
    async schedule(at: Date, _name: string, payload: unknown): Promise<void> { runtime.schedules.push({ at, payload }); }
    deleteSchedules(): void {}
    async containerFetch(request: Request): Promise<Response> { runtime.sent.push(request); return new Response(null, { status: 202 }); }
  },
}));

const NOW = 1700000000000;
const PLAN: MiniToolPlanJobRequest = {
  limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
  schemaVersion: 2, jobId: "plan-chunk-1", containerClass: "MiniToolContainerStd1", deadlineAt: NOW + 7200000,
  inputs: [
    { inputId: "20000000-0000-4000-8000-000000000001", storageKey: "fixtures/source-a.mp4" },
    { inputId: "20000000-0000-4000-8000-000000000002", storageKey: "fixtures/source-b.mp4" },
  ],
  outputs: [
    { outputIndex: 8, storageKey: "results/T/o08.png", contentType: "image/png", coverKey: "results/T/o08.cover.png", recipe: { kind: "frame", inputId: "20000000-0000-4000-8000-000000000002", frameIndex: 30 } },
    { outputIndex: 9, storageKey: "results/T/o09.png", contentType: "image/png", recipe: { kind: "frame", inputId: "20000000-0000-4000-8000-000000000001", frameIndex: 31 } },
  ],
};
const WRITTEN = { sha256: "a".repeat(64), sizeBytes: 64, contentType: "image/png" };
const MEDIA = { width: 960, height: 448, durationSeconds: null, cover: null };

/**
 * Make only the storage and lifecycle stand-in used by this Node unit suite.
 * @returns A DO whose Cloudflare container base is mocked, never a real image.
 * @throws {never} Never.
 */
function owner(): { object: MiniToolContainerStd1; storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>();
  const ctx = {
    id: { toString: () => "unit-only-object" }, container: { running: true },
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
});

afterEach(() => { vi.restoreAllMocks(); });

describe("planned DO state with a mocked container base, not an image", () => {
  it("dispatches both exact sources, indexed recipes and the original complete deadline", async () => {
    const { object } = owner();
    expect(await object.submit(PLAN)).toEqual({ schemaVersion: 2, state: "running" });
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
    expect(await object.submit({ outputs: PLAN.outputs, inputs: PLAN.inputs, deadlineAt: PLAN.deadlineAt, containerClass: PLAN.containerClass, jobId: PLAN.jobId, schemaVersion: 2, limits: PLAN.limits })).toEqual({ schemaVersion: 2, state: "running" });
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
      { ...PLAN, outputs: [{ ...PLAN.outputs[0]!, recipe: { kind: "frame", inputId: PLAN.inputs[0]!.inputId, frameIndex: 31 } }, PLAN.outputs[1]!] },
    ];
    for (const changed of changes) {
      await expect(object.submit(changed)).rejects.toThrow();
      expect(storage.get("job")).toEqual(held);
    }
    expect(runtime.starts).toBe(1);
  });

  it("keeps actual written index8 in a failed partial report instead of renumbering it to zero", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    await object.noteWritten(PLAN.outputs[0]!.storageKey, WRITTEN, attemptId);
    await object.noteReported({ schemaVersion: 2, attemptId, ok: false, cpuUsec: 123, outputs: [{ outputIndex: 8, storageKey: PLAN.outputs[0]!.storageKey, ...MEDIA }], reason: "tool_failed" });
    const result = await object.report();
    expect(result).toEqual({ schemaVersion: 2, state: "failed", reason: "tool_failed", usage: { wallMs: 0, cpuUsec: 123 }, outputs: [{ outputIndex: 8, storageKey: PLAN.outputs[0]!.storageKey, ...WRITTEN, ...MEDIA, upright: null }] });
    expect(await object.submit(PLAN)).toEqual(result);
    expect(runtime.starts).toBe(1);
  });

  it("rejects conflicting measurements and stale attempts without replacing the original write", async () => {
    const { object, storage } = owner();
    await object.submit(PLAN);
    const attemptId = (storage.get("job") as { state: { attemptId: string } }).state.attemptId;
    await object.noteWritten(PLAN.outputs[0]!.storageKey, WRITTEN, attemptId);
    const original = structuredClone(storage.get("job"));
    await expect(object.noteWritten(PLAN.outputs[0]!.storageKey, { ...WRITTEN, sha256: "b".repeat(64) }, attemptId)).rejects.toThrow();
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
});
