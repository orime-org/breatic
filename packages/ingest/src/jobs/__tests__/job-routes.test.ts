// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mini-tool job endpoints refuse everything but our worker's well-formed
 * requests (inner#888 §8.1), before any container is reached. What happens
 * once a job object is reached needs a runtime with containers enabled, which
 * this pool does not have: the object's constructor refuses to run here.
 */

import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "@ingest/index.js";

const JOB = {
  jobId: "task:t1",
  containerClass: "MiniToolContainerStd1",
  deadlineAt: Date.now() + 60_000,
  op: "cut",
  params: { range: { start: 0, end: 1 } },
  input: { storageKey: "video/in.mp4" },
  outputs: [{ storageKey: "video/out.mp4", contentType: "video/mp4" }],
  limits: { runDeadlineMs: 1000, toolTimeoutMs: 1000 },
};

/**
 * Send one request to the Worker.
 * @param path - The path.
 * @param init - The request.
 * @param withSecret - Whether it carries our secret.
 * @returns The response.
 */
async function call(path: string, init: RequestInit, withSecret = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (withSecret) headers.set("x-ingest-secret", env.INGEST_SHARED_SECRET);
  return worker.fetch(new Request(`https://ingest.example.com${path}`, { ...init, headers }), env, createExecutionContext());
}

describe("POST /jobs", () => {
  it("refuses a caller without our secret", async () => {
    const res = await call("/jobs", { method: "POST", body: JSON.stringify(JOB) }, false);
    expect(res.status).toBe(401);
  });

  it("refuses a body that is not a job", async () => {
    const res = await call("/jobs", { method: "POST", body: JSON.stringify({ ...JOB, op: "melt" }) });
    expect(res.status).toBe(400);
  });

  it("refuses a class this Worker does not bind", async () => {
    const res = await call("/jobs", { method: "POST", body: JSON.stringify({ ...JOB, containerClass: "MediaContainer" }) });
    expect(res.status).toBe(400);
  });
});

describe("GET /jobs/<class>/<id>", () => {
  it("refuses a caller without our secret", async () => {
    const res = await call("/jobs/MiniToolContainerStd1/task%3At1", { method: "GET" }, false);
    expect(res.status).toBe(401);
  });

  it("answers 404 for a class this Worker does not bind", async () => {
    const res = await call("/jobs/MediaContainer/task%3At1", { method: "GET" });
    expect(res.status).toBe(404);
  });
});
