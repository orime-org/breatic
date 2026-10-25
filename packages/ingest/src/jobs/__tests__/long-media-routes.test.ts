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

const probeReport = {
  version: 1 as const,
  sourceFingerprint: payload.source.sha256,
  selectedVideoStreamIndex: null,
  streams: [{
    index: 0,
    kind: "audio" as const,
    codec: "aac",
    channels: 2,
    channelLayout: "stereo",
    channelMembers: [
      { channelIndex: 0, member: "FL" },
      { channelIndex: 1, member: "FR" },
    ],
    sampleRate: 48000,
    startUs: "0",
    endUs: "10000000",
    timeBase: { numerator: "1", denominator: "48000" },
  }],
  mediaInputs: [0, 1].map((audioChannelIndex) => ({
    mediaInputId: `audio-0-${audioChannelIndex}`,
    descriptor: { inputKind: "audio_channel" as const, audioStreamIndex: 0, audioChannelIndex },
    sourceRange: { startUs: "0", endUs: "10000000" },
    audioRange: { startUs: "0", endUs: "10000000" },
  })),
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

  it("persists lifecycle changes and their recoverable effects atomically", async () => {
    const lifecyclePayload = { ...payload, jobId: "operation-lifecycle:source-0", operationId: "operation-lifecycle" };
    const accepted = await call("/long-media/jobs", { method: "POST", body: await requestBody(lifecyclePayload) });
    expect(accepted.status).toBe(202);
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(lifecyclePayload.jobId));

    await expect(stub.transition({ type: "start" }, Date.now())).resolves.toMatchObject({
      snapshot: { phase: "probing", version: 1 },
      effects: ["startProbe"],
    });
    await expect(stub.pendingEffects()).resolves.toEqual(["startProbe"]);
  });

  it("persists attempt epochs and fences stale Container receipts", async () => {
    const attemptPayload = { ...payload, jobId: "operation-attempt:source-0", operationId: "operation-attempt" };
    const accepted = await call("/long-media/jobs", { method: "POST", body: await requestBody(attemptPayload) });
    expect(accepted.status).toBe(202);
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(attemptPayload.jobId));

    await expect(stub.startAttempt("attempt-1", Date.now())).resolves.toEqual({
      state: { attemptId: "attempt-1", epoch: 1, phase: "starting" },
      effects: ["start"],
    });
    await expect(stub.applyAttemptEvent({ type: "accepted", attemptId: "attempt-1", epoch: 0 }, Date.now()))
      .resolves.toMatchObject({ state: { phase: "starting" }, effects: [] });
    await expect(stub.applyAttemptEvent({ type: "accepted", attemptId: "attempt-1", epoch: 1 }, Date.now()))
      .resolves.toMatchObject({ state: { phase: "running" } });
    await expect(stub.applyAttemptEvent({ type: "stop" }, Date.now()))
      .resolves.toMatchObject({ state: { phase: "stopping" }, effects: ["destroy"] });
    await expect(stub.applyAttemptEvent({ type: "gone", attemptId: "attempt-1", epoch: 1 }, Date.now()))
      .resolves.toMatchObject({ state: { phase: "stopped" } });
    await expect(stub.applyAttemptEvent({
      type: "restart", attemptId: "attempt-2", epoch: 2, jobLive: true,
    }, Date.now())).resolves.toMatchObject({ state: { attemptId: "attempt-2", epoch: 2, phase: "queued" } });
    await expect(stub.pendingAttemptEffects()).resolves.toEqual([
      { attemptId: "attempt-1", epoch: 1, effect: "destroy" },
      { attemptId: "attempt-1", epoch: 1, effect: "start" },
    ]);
  });

  it("commits validated probe facts only for the current running attempt and advances atomically", async () => {
    const probePayload = { ...payload, jobId: "operation-probe:source-0", operationId: "operation-probe" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(probePayload) });
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(probePayload.jobId));
    await stub.transition({ type: "start" }, Date.now());
    await stub.startAttempt("probe-attempt-1", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "probe-attempt-1", epoch: 1 }, Date.now());

    const accepted = await stub.applyProbeReport("probe-attempt-1", 1, probeReport, Date.now());
    expect(accepted).toMatchObject({
      kind: "accepted",
      report: { mediaInputs: [{ descriptor: { audioChannelIndex: 0 } }, { descriptor: { audioChannelIndex: 1 } }] },
      lifecycle: { snapshot: { phase: "planning", version: 2 } },
    });

    await expect(stub.applyProbeReport("probe-attempt-1", 1, {
      ...probeReport,
      sourceFingerprint: "b".repeat(64),
    }, Date.now())).resolves.toEqual({ kind: "conflict" });

    await expect(stub.applyProbeReport("probe-attempt-1", 1, probeReport, Date.now()))
      .resolves.toMatchObject({ kind: "replayed", lifecycle: { snapshot: { phase: "planning" }, effects: [] } });
    await expect(stub.applyProbeReport("probe-attempt-1", 0, probeReport, Date.now()))
      .resolves.toEqual({ kind: "stale" });
    await expect(stub.report()).resolves.toMatchObject({ phase: "planning", version: 2 });
    await expect(stub.pendingEffects()).resolves.toEqual(["startProbe"]);
  });

  it("rejects a job whose absolute deadline has already passed", async () => {
    const expired = { ...payload, jobId: "operation-expired:source-0", operationId: "operation-expired", deadlineAt: Date.now() - 1 };
    const response = await call("/long-media/jobs", { method: "POST", body: await requestBody(expired) });
    expect(response.status).toBe(410);
  });
});
