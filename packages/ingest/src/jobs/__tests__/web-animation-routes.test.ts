// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation job endpoints (inner#1711 design §3.7, §6): `POST /jobs` dispatching on `containerClass`,
 * `GET /jobs/WebAnimationContainer/<id>` and `POST /jobs/WebAnimationContainer/<id>/cancel`.
 *
 * Web-animation execution is optional on a deployment: the `WEB_ANIMATION` Durable Object binding, its containers
 * entry and the `HARNESS_OPENROUTER_API_KEY` secret stay out of `REQUIRED_SETTINGS`. Missing any of them, the three
 * endpoints answer 501 `feature_disabled` before the namespace is touched, which the worker reads as a terminal answer,
 * while every other endpoint keeps working. 503 keeps its meaning: the container could not start this time.
 *
 * The pool has no container runtime, so the namespace here is a stand-in that records what the route asked of the
 * job object; the object's own behaviour is specified in `web-animation-transition.node.test.ts`.
 */

import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { WebAnimationJobReport, WebAnimationJobRequest } from "@shared/upload/web-animation-job.js";
import * as entry from "@ingest/index.js";
import worker from "@ingest/index.js";

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
};

const JOB_PATH = `/jobs/WebAnimationContainer/${encodeURIComponent(JOB.jobId)}`;

const RUNNING: WebAnimationJobReport = {
  state: "running", phase: "writing", steps: [], calls: [], container: null, outputs: [], failureReason: null,
};

const BEFORE_SUBMIT: WebAnimationJobReport = {
  state: "cancelled_before_submit", phase: null, steps: [], calls: [], container: null, outputs: [], failureReason: null,
};

/** What the stand-in job object answers. */
interface ObjectAnswers {
  submit?: () => Promise<unknown>;
  report?: () => Promise<WebAnimationJobReport | null>;
  cancel?: () => Promise<WebAnimationJobReport>;
}

/**
 * A namespace whose one object records its calls.
 * @param answers - What the object answers.
 * @returns The namespace and its recorders.
 */
function standIn(answers: ObjectAnswers = {}) {
  const stub = {
    submit: vi.fn(async (_request: WebAnimationJobRequest) => (answers.submit ? answers.submit() : { kind: "report", report: RUNNING })),
    report: vi.fn(async () => (answers.report ? answers.report() : RUNNING)),
    cancel: vi.fn(async (_deadlineAt: number) => (answers.cancel ? answers.cancel() : { ...RUNNING, state: "stopping" })),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name })),
    idFromString: vi.fn((id: string) => ({ id })),
    get: vi.fn((_id: unknown) => stub),
  };
  return { namespace, stub };
}

/**
 * The test env with web animation configured, or with the named settings taken away.
 * @param namespace - The stand-in namespace.
 * @param without - Settings to leave out.
 * @param overrides - Settings to set to another value.
 * @returns The env.
 */
function configured(namespace: unknown, without: string[] = [], overrides: Record<string, unknown> = {}): typeof env {
  const full: Record<string, unknown> = { ...env, WEB_ANIMATION: namespace, HARNESS_OPENROUTER_API_KEY: "test-openrouter-key", ...overrides };
  for (const name of without) delete full[name];
  return full as unknown as typeof env;
}

/**
 * Send one request to the Worker.
 * @param bindings - The env to run against.
 * @param path - The path.
 * @param init - The request.
 * @param withSecret - Whether it carries our secret.
 * @returns The response.
 */
async function call(bindings: typeof env, path: string, init: RequestInit, withSecret = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (withSecret) headers.set("x-ingest-secret", env.INGEST_SHARED_SECRET);
  return worker.fetch(new Request(`https://ingest.example.com${path}`, { ...init, headers }), bindings, createExecutionContext());
}

const submit = (bindings: typeof env, body: unknown = JOB): Promise<Response> =>
  call(bindings, "/jobs", { method: "POST", body: JSON.stringify(body) });
const read = (bindings: typeof env): Promise<Response> => call(bindings, JOB_PATH, { method: "GET" });
const cancel = (bindings: typeof env, body: unknown = { deadlineAt: JOB.deadlineAt }): Promise<Response> =>
  call(bindings, `${JOB_PATH}/cancel`, { method: "POST", body: JSON.stringify(body) });

describe("the WebAnimationContainer class", () => {
  it("is exported from the Worker's entry, so wrangler can bind it", () => {
    expect(typeof (entry as Record<string, unknown>)["WebAnimationContainer"]).toBe("function");
  });
});

describe("POST /jobs for WebAnimationContainer", () => {
  it("hands a valid job to the object named by its job id and answers its report", async () => {
    const { namespace, stub } = standIn();
    const res = await submit(configured(namespace));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(RUNNING);
    expect(namespace.idFromName).toHaveBeenCalledWith(JOB.jobId);
    expect(stub.submit).toHaveBeenCalledWith(JOB);
  });

  it("refuses a body that does not satisfy the web-animation job schema", async () => {
    const { namespace, stub } = standIn();
    for (const body of [
      { ...JOB, packageKey: "video/out.mp4" },
      { ...JOB, maxTokens: 0 },
      { ...JOB, fps: { num: 24 } },
      { containerClass: "WebAnimationContainer", jobId: JOB.jobId },
    ]) {
      const res = await submit(configured(namespace), body);
      expect(res.status).toBe(400);
    }
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("answers 410 when the job was cancelled before it was submitted", async () => {
    const { namespace } = standIn({ submit: async () => ({ kind: "cancelled_before_submit" }) });
    const res = await submit(configured(namespace));

    expect(res.status).toBe(410);
  });

  it("answers 503 when the container could not start, so the worker submits again later", async () => {
    const { namespace } = standIn({
      submit: async () => {
        throw Object.assign(new Error("the container could not start"), { name: "JobStartFailed" });
      },
    });
    const res = await submit(configured(namespace));

    expect(res.status).toBe(503);
  });

  it("refuses a caller without our secret", async () => {
    const { namespace, stub } = standIn();
    const res = await call(configured(namespace), "/jobs", { method: "POST", body: JSON.stringify(JOB) }, false);

    expect(res.status).toBe(401);
    expect(stub.submit).not.toHaveBeenCalled();
  });
});

describe("GET /jobs/WebAnimationContainer/<id>", () => {
  it("answers the object's report", async () => {
    const { namespace } = standIn();
    const res = await read(configured(namespace));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(RUNNING);
    expect(namespace.idFromName).toHaveBeenCalledWith(JOB.jobId);
  });

  it("answers 404 when the object holds no job", async () => {
    const { namespace } = standIn({ report: async () => null });
    const res = await read(configured(namespace));

    expect(res.status).toBe(404);
  });
});

describe("POST /jobs/WebAnimationContainer/<id>/cancel", () => {
  it("asks the object named by the job id to cancel until the body's deadline and answers its report", async () => {
    const { namespace, stub } = standIn();
    const res = await cancel(configured(namespace));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: "stopping" });
    expect(namespace.idFromName).toHaveBeenCalledWith(JOB.jobId);
    expect(stub.cancel).toHaveBeenCalledWith(JOB.deadlineAt);
  });

  it("answers the cancelled_before_submit marker for a job never submitted", async () => {
    const { namespace } = standIn({ cancel: async () => BEFORE_SUBMIT });
    const res = await cancel(configured(namespace));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(BEFORE_SUBMIT);
  });

  it("refuses a body that is not a cancel", async () => {
    const { namespace, stub } = standIn();
    for (const body of [{}, { deadlineAt: 0 }, { deadlineAt: "soon" }]) {
      const res = await cancel(configured(namespace), body);
      expect(res.status).toBe(400);
    }
    expect(stub.cancel).not.toHaveBeenCalled();
  });

  it("refuses a caller without our secret", async () => {
    const { namespace, stub } = standIn();
    const res = await call(configured(namespace), `${JOB_PATH}/cancel`, {
      method: "POST", body: JSON.stringify({ deadlineAt: JOB.deadlineAt }),
    }, false);

    expect(res.status).toBe(401);
    expect(stub.cancel).not.toHaveBeenCalled();
  });
});

describe("a Worker without web-animation execution configured", () => {
  const missing: Array<[string, string[], Record<string, unknown>]> = [
    ["the OpenRouter key", ["HARNESS_OPENROUTER_API_KEY"], {}],
    ["an empty OpenRouter key", [], { HARNESS_OPENROUTER_API_KEY: "" }],
    ["the WEB_ANIMATION binding", ["WEB_ANIMATION"], {}],
    ["both", ["HARNESS_OPENROUTER_API_KEY", "WEB_ANIMATION"], {}],
  ];

  it.each(missing)("answers submit, read and cancel 501 feature_disabled without touching the namespace when %s is missing", async (_label, without, overrides) => {
    const { namespace, stub } = standIn();
    const bindings = configured(namespace, without, overrides);

    for (const res of [await submit(bindings), await read(bindings), await cancel(bindings)]) {
      expect(res.status).toBe(501);
      await expect(res.text()).resolves.toBe("feature_disabled");
    }
    expect(namespace.get).not.toHaveBeenCalled();
    expect(namespace.idFromName).not.toHaveBeenCalled();
    expect(stub.submit).not.toHaveBeenCalled();
    expect(stub.report).not.toHaveBeenCalled();
    expect(stub.cancel).not.toHaveBeenCalled();
  });

  it("still refuses a caller without our secret before saying the feature is off", async () => {
    const res = await call(env, "/jobs", { method: "POST", body: JSON.stringify(JOB) }, false);

    expect(res.status).toBe(401);
  });

  it("keeps serving uploads, so neither setting joined REQUIRED_SETTINGS", async () => {
    const res = await worker.fetch(
      new Request("https://ingest.example.com/uploads", { method: "POST" }),
      env,
      createExecutionContext(),
    );

    // The test env binds neither; a request with no ticket gets the answer every such request gets.
    expect(res.status).toBe(401);
  });

  it("keeps routing mini-tool jobs", async () => {
    const res = await submit(env, {
      jobId: "task:t1",
      containerClass: "MiniToolContainerStd1",
      deadlineAt: Date.now() + 60_000,
      op: "melt",
      params: {},
      input: { storageKey: "video/in.mp4" },
      outputs: [{ storageKey: "video/out.mp4", contentType: "video/mp4" }],
    });

    // A malformed mini-tool job is refused by its own schema, not by the web-animation switch.
    expect(res.status).toBe(400);
  });
});
