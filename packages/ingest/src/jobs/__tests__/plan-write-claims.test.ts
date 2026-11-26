// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { miniToolPlanAccess, type MiniToolPlanJobRequest } from "@breatic/shared";
import { MiniToolContainerStd1, type MiniToolEnv } from "@ingest/jobs/mini-tool-container.js";
import { mediaObjectUrl } from "@ingest/media-object-route.js";
import type { PlanWriteTestObject } from "./helpers/plan-write-object.js";
import { head } from "../../__tests__/helpers/encoder-heads.js";

declare module "cloudflare:test" {
  interface ProvidedEnv { PLAN_WRITE_TEST: DurableObjectNamespace<PlanWriteTestObject> }
}

const CURRENT = "30000000-0000-4000-8000-000000000001";
const OLD = "30000000-0000-4000-8000-000000000002";
const A = new Uint8Array([...head("png"), 65]);
const B = new Uint8Array([...head("png"), 66]);

/** A production outbound handler routed to real workerd storage and R2. */
interface Fixture {
  key: string;
  calls: string[];
  stub: DurableObjectStub<PlanWriteTestObject>;
  invoke: (bytes: Uint8Array, attempt?: string) => Promise<Response>;
}

/**
 * Instrument actual bucket calls without answering any R2 operation in JavaScript.
 * @param calls - The calls made by the production outbound handler.
 * @returns The real bucket with transparent call recording.
 * @throws {never} Never.
 */
function observedBucket(calls: string[]): R2Bucket {
  return new Proxy(env.BUCKET, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        calls.push(String(property));
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/**
 * Prepare only the already accepted record; no media Container is constructed.
 * @returns The production outbound route and actual durable/R2 fixture.
 * @throws {Error} When fixture initialization or handler lookup fails.
 */
// §93 D5 (frames-split design §7.17 frame row 「不得把presentation ordinal当原解码n」, 「唯一写点：worker的配方构造」): a job frame recipe names a full-ledger entry and its PNG target, not a frameIndex.
async function fixture(): Promise<Fixture> {
  const nonce = crypto.randomUUID();
  const key = `plan-write-claim/${nonce}/result.png`;
  const request: MiniToolPlanJobRequest = {
    schemaVersion: 2, jobId: nonce, containerClass: "MiniToolContainerStd1", deadlineAt: Date.now() + 7200000,
    limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
    inputs: [{ inputId: "20000000-0000-4000-8000-000000000001", storageKey: `plan-write-claim/${nonce}/source.mp4` }],
    outputs: [{ outputIndex: 8, storageKey: key, contentType: "image/png", recipe: { kind: "frame", inputId: "20000000-0000-4000-8000-000000000001", grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 50, realFrameCount: 50 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 30, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }],
  };
  const id = env.PLAN_WRITE_TEST.idFromName(nonce);
  const stub = env.PLAN_WRITE_TEST.get(id);
  await stub.initialize(request, CURRENT);
  const handler = MiniToolContainerStd1.outboundHandlers?.jobObjects;
  if (!handler) throw new Error("Missing production jobObjects handler");
  const calls: string[] = [];
  const bindings = { ...env, BUCKET: observedBucket(calls), MINI_TOOL_STD1: env.PLAN_WRITE_TEST } as unknown as MiniToolEnv;
  return {
    key, stub, calls,
    invoke: async (bytes, attempt = CURRENT) => handler(
      new Request(`${mediaObjectUrl(key)}?attempt=${attempt}`, { method: "PUT", body: bytes }),
      bindings,
      { className: "MiniToolContainerStd1", containerId: id.toString(), params: { ...miniToolPlanAccess(request), attemptId: attempt } },
    ),
  };
}

/**
 * Compute the independent SHA-256 oracle over the original byte sequence.
 * @param bytes - The independently specified input bytes.
 * @returns Their lowercase SHA-256.
 * @throws {DOMException} When the runtime cannot hash the bytes.
 */
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("planned pre-write ownership through production outbound and real workerd DO/R2", () => {
  it("refuses a different second PUT before it can overwrite canonical bytes A", async () => {
    const f = await fixture();
    expect((await f.invoke(A)).status).toBe(200);
    const before = await f.stub.snapshot();
    const firstMeasurement = before?.written[f.key];
    expect(firstMeasurement).toEqual({ sha256: await digest(A), sizeBytes: A.length, contentType: "image/png" });
    f.calls.length = 0;
    const second = await Promise.allSettled([f.invoke(B)]);
    expect(second[0]?.status === "rejected" || (second[0]?.status === "fulfilled" && second[0].value.status >= 400)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer())).toEqual(A);
    expect((await f.stub.snapshot())?.written[f.key]).toEqual(firstMeasurement);
  });

  it("admits exactly one writer for two concurrent PUTs of the same issued key", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.invoke(A), f.invoke(B)]);
    const accepted = results.filter((result) => result.status === "fulfilled" && result.value.status === 200);
    expect(accepted).toHaveLength(1);
    expect(f.calls.filter((method) => method === "createMultipartUpload")).toHaveLength(1);
    const actual = new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer());
    const winner = results[0]?.status === "fulfilled" && results[0].value.status === 200 ? A : B;
    expect(actual).toEqual(winner);
    expect((await f.stub.snapshot())?.written[f.key]).toEqual({ sha256: await digest(winner), sizeBytes: winner.length, contentType: "image/png" });
  });

  it("keeps one durable writer for bounded arbitrary concurrent retry sets", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (count) => {
      const f = await fixture();
      const inputs = Array.from({ length: count }, (_, index) => new Uint8Array([...head("png"), index]));
      const results = await Promise.allSettled(inputs.map((bytes) => f.invoke(bytes)));
      const winners = results.flatMap((result, index) => result.status === "fulfilled" && result.value.status === 200 ? [index] : []);
      expect(winners).toHaveLength(1);
      expect(f.calls.filter((method) => method === "createMultipartUpload")).toHaveLength(1);
      const bytes = inputs[winners[0]!]!;
      expect(new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer())).toEqual(bytes);
      expect((await f.stub.snapshot())?.written[f.key]?.sha256).toBe(await digest(bytes));
    }), { numRuns: 5 });
  });

  it("refuses an old outbound context and matching old query before any R2 IO", async () => {
    const f = await fixture();
    const result = await Promise.allSettled([f.invoke(B, OLD)]);
    expect(result[0]?.status === "rejected" || (result[0]?.status === "fulfilled" && result[0].value.status >= 400)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await env.BUCKET.head(f.key)).toBeNull();
    expect((await f.stub.snapshot())?.written).toEqual({});
  });

  it("refuses a newly begun PUT after the original attempt is terminal", async () => {
    const f = await fixture();
    await f.stub.fail();
    const result = await Promise.allSettled([f.invoke(A)]);
    expect(result[0]?.status === "rejected" || (result[0]?.status === "fulfilled" && result[0].value.status >= 400)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await env.BUCKET.head(f.key)).toBeNull();
    expect((await f.stub.snapshot())?.state.phase).toBe("failed");
  });
});
