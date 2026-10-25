// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { computeLongMediaJobRequestDigest } from "@breatic/shared";
import worker from "@ingest/index.js";

const payload = {
  protocolVersion: 1 as const,
  jobId: "operation-route-test:source-0",
  operationId: "operation-route-test",
  sourceIndex: 0,
  source: {
    key: "media/source.mp4",
    sha256: "a".repeat(64),
    sizeBytes: 1_000_000,
    etag: "etag-route-test",
  },
  profileId: "channel-v1",
  profileVersion: "channel-v1",
  limitsSnapshot: {
    maxSourceBytes: 2_147_483_648,
    maxSources: 10,
    maxSegmentBytes: 20_000_000,
    audioCoreSeconds: 300,
    videoCoreSeconds: 60,
    overlapSeconds: 2,
    maxActiveLeaves: 512,
  },
  deadlineAt: Date.now() + 60_000,
};

/** Send one authenticated long media request to the Worker. */
async function call(path: string, init: RequestInit, withSecret = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (withSecret) headers.set("x-ingest-secret", env.INGEST_SHARED_SECRET);
  return worker.fetch(new Request(`https://ingest.example.com${path}`, { ...init, headers }), env, createExecutionContext());
}

/** Add the canonical digest to a request payload. */
async function requestBody(jobPayload = payload): Promise<string> {
  return JSON.stringify({
    ...jobPayload,
    requestDigest: await computeLongMediaJobRequestDigest(jobPayload),
  });
}

describe("POST /long-media/jobs", () => {
  it("requires the backend secret", async () => {
    const response = await call("/long-media/jobs", { method: "POST", body: await requestBody() }, false);
    expect(response.status).toBe(401);
  });

  it("rejects a request whose digest does not match its immutable payload", async () => {
    const body = JSON.parse(await requestBody()) as Record<string, unknown>;
    const response = await call("/long-media/jobs", {
      method: "POST",
      body: JSON.stringify({ ...body, requestDigest: "c".repeat(64) }),
    });
    expect(response.status).toBe(400);
  });

  it("returns a conflict when a job id is reused for another request digest", async () => {
    const conflictPayload = { ...payload, jobId: "operation-conflict:source-0", operationId: "operation-conflict" };
    const first = await call("/long-media/jobs", { method: "POST", body: await requestBody(conflictPayload) });
    expect(first.status).toBe(202);

    const changed = { ...conflictPayload, source: { ...payload.source, etag: "etag-changed" } };
    const second = await call("/long-media/jobs", { method: "POST", body: await requestBody(changed) });
    expect(second.status).toBe(409);
  });

  it("replays the original job for the same id and digest", async () => {
    const replayPayload = { ...payload, jobId: "operation-replay:source-0", operationId: "operation-replay" };
    const body = await requestBody(replayPayload);
    const first = await call("/long-media/jobs", { method: "POST", body });
    const second = await call("/long-media/jobs", { method: "POST", body });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ jobId: replayPayload.jobId, phase: "accepted", version: 0 });
  });

  it("rejects a job whose absolute deadline has already passed", async () => {
    const expired = { ...payload, jobId: "operation-expired:source-0", operationId: "operation-expired", deadlineAt: Date.now() - 1 };
    const response = await call("/long-media/jobs", { method: "POST", body: await requestBody(expired) });
    expect(response.status).toBe(410);
  });
});
