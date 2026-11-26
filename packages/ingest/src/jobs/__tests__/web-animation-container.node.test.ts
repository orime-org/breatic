// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A web-animation job whose container would not take the run answers a plain `start_failed` value: an error thrown from
 * a Durable Object method reaches the route as a plain `Error`, so the outcome crosses RPC as data and the route answers
 * 503. The `Container` base needs a runtime with containers enabled, so it is replaced by a stand-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebAnimationJobRequest } from "@shared/upload/web-animation-job.js";

const runtime = vi.hoisted(() => ({ fetchStatus: 202, destroyed: 0 }));

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
    async start(): Promise<void> {}
    async destroy(): Promise<void> { runtime.destroyed += 1; }
    async setOutboundByHosts(): Promise<void> {}
    async schedule(): Promise<void> {}
    deleteSchedules(): void {}
    async containerFetch(): Promise<Response> { return new Response(null, { status: runtime.fetchStatus }); }
  },
}));

const { WebAnimationContainer } = await import("@ingest/jobs/web-animation-container.js");

const JOB: WebAnimationJobRequest = {
  containerClass: "WebAnimationContainer",
  jobId: "timeline:40000000-0000-4000-8000-000000000001",
  deadlineAt: Date.now() + 7_200_000,
  prompt: "A red square slides from left to right",
  viewport: { width: 1920, height: 1080 },
  fps: { num: 24, den: 1 },
  durationFrames: 96,
  packageKey: "web-animation/p1/40000000-0000-4000-8000-000000000001/index.html",
  manifestKey: "web-animation/p1/40000000-0000-4000-8000-000000000001/manifest.json",
  fontSetVersion: 1,
  maxPackageBytes: 5_000_000,
  maxTokens: 32_000,
  callTimeoutMs: 300_000,
  model: "deepseek/deepseek-v4.1-flash-1017",
  messagesPlan: {
    model: "deepseek/deepseek-v4.1-flash-1017",
    candidates: [{ upstream: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", vendorModel: "deepseek/deepseek-v4.1-flash-1017", keyEnv: "OPENROUTER_API_KEY" }],
  },
};

/**
 * A job object over an in-memory storage, with its container base replaced.
 * @returns The object and its storage.
 */
function owner(): { object: InstanceType<typeof WebAnimationContainer>; storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>();
  const ctx = {
    id: { toString: (): string => "unit-only-object" },
    container: { running: false },
    blockConcurrencyWhile: async <T>(work: () => Promise<T>): Promise<T> => work(),
    storage: {
      get: async (key: string): Promise<unknown> => storage.get(key),
      put: async (key: string, value: unknown): Promise<void> => { storage.set(key, structuredClone(value)); },
      delete: async (keys: string | string[]): Promise<boolean> => {
        for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
        return true;
      },
    },
  };
  return { object: new WebAnimationContainer(ctx as never, {} as never), storage };
}

beforeEach(() => {
  runtime.fetchStatus = 202;
  runtime.destroyed = 0;
});

afterEach(() => { vi.restoreAllMocks(); });

describe("a web-animation job whose container would not take the run", () => {
  it("answers a plain start_failed value and keeps no job behind it", async () => {
    const { object, storage } = owner();
    runtime.fetchStatus = 503;
    expect(structuredClone(await object.submit(JOB))).toEqual({ kind: "start_failed", reason: "the run was answered 503" });
    expect(storage.size).toBe(0);
    expect(runtime.destroyed).toBe(1);
  });
});
