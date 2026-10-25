// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { computeLongMediaJobRequestDigest } from "@breatic/shared";
import { acceptLongMediaProbeReport, serveLongMediaSource } from "@ingest/jobs/long-media-routes.js";
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
    await expect(second.json()).resolves.toMatchObject({ jobId: replayPayload.jobId, phase: "probing", version: 1 });
  });

  it("persists lifecycle changes and their recoverable effects atomically", async () => {
    const lifecyclePayload = { ...payload, jobId: "operation-lifecycle:source-0", operationId: "operation-lifecycle" };
    const accepted = await call("/long-media/jobs", { method: "POST", body: await requestBody(lifecyclePayload) });
    expect(accepted.status).toBe(202);
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(lifecyclePayload.jobId));

    await expect(accepted.json()).resolves.toMatchObject({ phase: "probing", version: 1 });
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

  it("acknowledges external start effects only for their durable revision and epoch", async () => {
    const effectPayload = { ...payload, jobId: "operation-effects:source-0", operationId: "operation-effects" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(effectPayload) });
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(effectPayload.jobId));
    const attempt = await stub.startAttempt("effect-attempt", Date.now());
    expect(attempt?.state).toMatchObject({ epoch: 1, phase: "starting" });

    await expect(stub.acknowledgeEffect(0, "startProbe")).resolves.toBe(false);
    await expect(stub.acknowledgeEffect(1, "startProbe")).resolves.toBe(true);
    await expect(stub.acknowledgeAttemptEffect(1, "effect-attempt", "start")).resolves.toBe(true);
    await expect(stub.pendingEffects()).resolves.toEqual([]);
    await expect(stub.pendingAttemptEffects()).resolves.toEqual([]);
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

  it("builds and accepts a fenced report from the container's raw ffprobe output", async () => {
    const probePayload = { ...payload, jobId: "operation-probe-callback:source-0", operationId: "operation-probe-callback" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(probePayload) });
    const id = env.LONG_MEDIA.idFromName(probePayload.jobId);
    const stub = env.LONG_MEDIA.get(id);
    await stub.transition({ type: "start" }, Date.now());
    await stub.startAttempt("probe-callback-attempt", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "probe-callback-attempt", epoch: 1 }, Date.now());
    const stdout = JSON.stringify({ streams: [{
      index: 0,
      codec_type: "audio",
      codec_name: "aac",
      channels: 1,
      channel_layout: "mono",
      sample_rate: "48000",
      start_pts: "0",
      duration_ts: "480000",
      time_base: "1/48000",
    }] });

    const response = await acceptLongMediaProbeReport(
      new Request("http://long-media.local/probe-report", { method: "POST", body: JSON.stringify({ stdout }) }),
      env,
      {
        className: "LongMediaContainer",
        containerId: id.toString(),
        params: {
          attemptId: "probe-callback-attempt",
          epoch: 1,
          sourceFingerprint: probePayload.source.sha256,
          profileVersion: probePayload.profileVersion,
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(stub.report()).resolves.toMatchObject({ phase: "planning", version: 2 });
  });

  it("serves only the one source key and measured size authorized for the probe", async () => {
    const key = "long-media-source-test/source.mp4";
    await env.BUCKET.put(key, new Uint8Array([1, 2, 3]));
    const context = { containerId: "source-test", className: "LongMediaContainer", params: { key, sizeBytes: 3 } };

    const refused = await serveLongMediaSource(new Request("http://r2.local/other.mp4"), env, context);
    const accepted = await serveLongMediaSource(new Request(`http://r2.local/${key}`), env, context);

    expect(refused.status).toBe(403);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("content-length")).toBe("3");
    await accepted.body?.cancel();
  });

  it("persists an attempt-fenced ffprobe failure and requests Container shutdown", async () => {
    const failurePayload = { ...payload, jobId: "operation-probe-failure:source-0", operationId: "operation-probe-failure" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(failurePayload) });
    const id = env.LONG_MEDIA.idFromName(failurePayload.jobId);
    const stub = env.LONG_MEDIA.get(id);
    await stub.startAttempt("probe-failure-attempt", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "probe-failure-attempt", epoch: 1 }, Date.now());
    await stub.transition({ type: "containerStarted" }, Date.now());

    const response = await acceptLongMediaProbeReport(
      new Request("http://long-media.local/probe-report", {
        method: "POST",
        body: JSON.stringify({ failure: "probe_failed" }),
      }),
      env,
      {
        className: "LongMediaContainer",
        containerId: id.toString(),
        params: {
          attemptId: "probe-failure-attempt",
          epoch: 1,
          sourceFingerprint: failurePayload.source.sha256,
          profileVersion: failurePayload.profileVersion,
        },
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(stub.report()).resolves.toMatchObject({ phase: "stopping", terminalIntent: "failed" });
    await expect(stub.pendingAttemptEffects()).resolves.toContainEqual({
      attemptId: "probe-failure-attempt",
      epoch: 1,
      effect: "destroy",
    });
  });

  it("rejects a job whose absolute deadline has already passed", async () => {
    const expired = { ...payload, jobId: "operation-expired:source-0", operationId: "operation-expired", deadlineAt: Date.now() - 1 };
    const response = await call("/long-media/jobs", { method: "POST", body: await requestBody(expired) });
    expect(response.status).toBe(410);
  });

  it("persists a planned segment and fences competing lifecycle updates", async () => {
    const segmentPayload = { ...payload, jobId: "operation-segment:source-0", operationId: "operation-segment" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(segmentPayload) });
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(segmentPayload.jobId));
    await stub.startAttempt("segment-probe", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "segment-probe", epoch: 1 }, Date.now());
    await stub.applyProbeReport("segment-probe", 1, probeReport, Date.now());
    const segments = [0, 1].map((audioChannelIndex) => ({
      id: `audio-0-${audioChannelIndex}:0:10000000`,
      mediaInputId: `audio-0-${audioChannelIndex}`,
      descriptor: { inputKind: "audio_channel" as const, audioStreamIndex: 0, audioChannelIndex },
      core: { startUs: "0", endUs: "10000000" },
      decode: { startUs: "0", endUs: "10000000" },
    }));

    await expect(stub.seedSegmentPlan(segments.slice(0, 1), 0)).resolves.toEqual({ kind: "invalid" });
    await expect(stub.seedSegmentPlan(segments, 0)).resolves.toMatchObject({ kind: "accepted", revision: 1 });
    await expect(stub.seedSegmentPlan(segments, 0)).resolves.toMatchObject({ kind: "replayed", revision: 1 });
    await expect(stub.readSegments()).resolves.toMatchObject(segments.map((segment) => ({ ...segment, status: "planned", version: 0 })));
    await expect(stub.applySegmentEvent(segments[0]!.id, 0, { type: "run" })).resolves.toMatchObject({
      kind: "accepted",
      status: "encoding",
      version: 1,
    });
    await expect(stub.applySegmentEvent(segments[0]!.id, 0, { type: "measured" })).resolves.toEqual({ kind: "stale" });
    await expect(stub.applySegmentEvent(segments[0]!.id, 1, { type: "measured" })).resolves.toMatchObject({
      kind: "accepted",
      status: "stored",
      version: 2,
    });
    await expect(stub.readSegments()).resolves.toMatchObject([
      { ...segments[0], status: "stored", version: 2 },
      { ...segments[1], status: "planned", version: 0 },
    ]);
  });
});
