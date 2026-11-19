// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The render job endpoints (#1490 design §6.1): `POST /jobs` dispatches a `WebAnimationRenderContainer` request to the
 * `WEB_ANIMATION_RENDER` binding, one object per job id, and the read and cancel routes name the same class. Like the
 * creation container the binding is optional: without it the three endpoints answer 501 `feature_disabled`, and the
 * other job classes keep working.
 *
 * The pool has no container runtime, so the namespace is a stand-in that records what the route asked of the object.
 */

import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { WebAnimationRenderJobReport, WebAnimationRenderJobRequest } from "@shared/upload/web-animation-job.js";
import * as entry from "@ingest/index.js";
import worker from "@ingest/index.js";

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

const JOB_PATH = `/jobs/WebAnimationRenderContainer/${encodeURIComponent(JOB.jobId)}`;

const RUNNING: WebAnimationRenderJobReport = { state: "running", phase: "rendering", container: null, video: null, failureReason: null };

/**
 * A namespace whose one object records its calls.
 * @returns The namespace and its recorders.
 */
function standIn() {
  const stub = {
    submit: vi.fn(async (_request: WebAnimationRenderJobRequest) => ({ kind: "report", report: RUNNING })),
    report: vi.fn(async () => RUNNING),
    cancel: vi.fn(async (_deadlineAt: number) => ({ ...RUNNING, state: "cancelled" })),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name })),
    idFromString: vi.fn((id: string) => ({ id })),
    get: vi.fn((_id: unknown) => stub),
  };
  return { namespace, stub };
}

/**
 * The test env with the render binding, or without it.
 * @param namespace - The stand-in, or undefined to leave the binding out.
 * @returns The env.
 */
function bindings(namespace: unknown): typeof env {
  const full: Record<string, unknown> = { ...env };
  if (namespace === undefined) delete full.WEB_ANIMATION_RENDER;
  else full.WEB_ANIMATION_RENDER = namespace;
  return full as unknown as typeof env;
}

/**
 * Send one request to the Worker with our secret.
 * @param bound - The env.
 * @param path - The path.
 * @param init - The request.
 * @returns The response.
 */
async function call(bound: typeof env, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-ingest-secret", env.INGEST_SHARED_SECRET);
  return worker.fetch(new Request(`https://ingest.example.com${path}`, { ...init, headers }), bound, createExecutionContext());
}

describe("the WebAnimationRenderContainer class", () => {
  it("is exported from the Worker's entry, so wrangler can bind it", () => {
    expect(typeof (entry as Record<string, unknown>).WebAnimationRenderContainer).toBe("function");
  });
});

describe("render job routes", () => {
  it("submits a render job to its own object, named by the job id", async () => {
    const { namespace, stub } = standIn();
    const res = await call(bindings(namespace), "/jobs", { method: "POST", body: JSON.stringify(JOB) });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual(RUNNING);
    expect(namespace.idFromName).toHaveBeenCalledWith(JOB.jobId);
    expect(stub.submit).toHaveBeenCalledWith(JOB);
  });

  it("reads and cancels a render job through the same class", async () => {
    const { namespace, stub } = standIn();
    expect((await call(bindings(namespace), JOB_PATH, { method: "GET" })).status).toBe(200);
    const cancelled = await call(bindings(namespace), `${JOB_PATH}/cancel`, { method: "POST", body: JSON.stringify({ deadlineAt: JOB.deadlineAt }) });
    expect(cancelled.status).toBe(200);
    expect(stub.report).toHaveBeenCalledTimes(1);
    expect(stub.cancel).toHaveBeenCalledWith(JOB.deadlineAt);
  });

  it("answers 501 feature_disabled on all three routes without the binding", async () => {
    const bound = bindings(undefined);
    for (const res of [
      await call(bound, "/jobs", { method: "POST", body: JSON.stringify(JOB) }),
      await call(bound, JOB_PATH, { method: "GET" }),
      await call(bound, `${JOB_PATH}/cancel`, { method: "POST", body: JSON.stringify({ deadlineAt: JOB.deadlineAt }) }),
    ]) {
      expect(res.status).toBe(501);
      expect(await res.text()).toContain("feature_disabled");
    }
  });

  it("refuses a render request whose output key sits under the private prefix with 400", async () => {
    const { namespace, stub } = standIn();
    expect((await call(bindings(namespace), "/jobs", { method: "POST", body: JSON.stringify(JOB) })).status).toBe(200);
    const res = await call(bindings(namespace), "/jobs", { method: "POST", body: JSON.stringify({ ...JOB, videoKey: "web-animation/p1/v.mp4" }) });
    expect(res.status).toBe(400);
    expect(stub.submit).toHaveBeenCalledTimes(1);
  });
});
