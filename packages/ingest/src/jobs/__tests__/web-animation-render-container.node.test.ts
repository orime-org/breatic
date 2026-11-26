// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A render job whose container would not take the render answers a plain `start_failed` value: an error thrown from a
 * Durable Object method reaches the route as a plain `Error`, so the outcome crosses RPC as data and the route answers
 * 503. The `Container` base needs a runtime with containers enabled, so it is replaced by a stand-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebAnimationRenderJobRequest } from "@breatic/shared/space-content";

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

const { WebAnimationRenderContainer } = await import("@ingest/jobs/web-animation-render-container.js");

const JOB: WebAnimationRenderJobRequest = {
  containerClass: "WebAnimationRenderContainer",
  jobId: "timeline:50000000-0000-4000-8000-000000000001",
  deadlineAt: Date.now() + 7_200_000,
  packageKey: "web-animation/p1/40000000-0000-4000-8000-000000000001/index.html",
  fontSetVersion: 1,
  width: 1080,
  height: 1920,
  fps: { num: 24, den: 1 },
  durationFrames: 144,
  quality: "standard",
  videoKey: "generated/2026/11/15/v.mp4",
  coverKey: "generated/2026/11/15/v_cover.png",
};

/**
 * A render object over an in-memory storage, with its container base replaced.
 * @returns The object and its storage.
 */
function owner(): { object: InstanceType<typeof WebAnimationRenderContainer>; storage: Map<string, unknown> } {
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
  return { object: new WebAnimationRenderContainer(ctx as never, {} as never), storage };
}

beforeEach(() => {
  runtime.fetchStatus = 202;
  runtime.destroyed = 0;
});

afterEach(() => { vi.restoreAllMocks(); });

describe("a render job whose container would not take the render", () => {
  it("answers a plain start_failed value and keeps no job behind it", async () => {
    const { object, storage } = owner();
    runtime.fetchStatus = 503;
    expect(structuredClone(await object.submit(JOB))).toEqual({ kind: "start_failed", reason: "the render was answered 503" });
    expect(storage.size).toBe(0);
    expect(runtime.destroyed).toBe(1);
  });

  it("answers its report when the container took the render", async () => {
    const { object } = owner();
    const answer = await object.submit(JOB);
    expect(answer.kind).toBe("report");
  });
});
