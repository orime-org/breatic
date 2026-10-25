// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { computeLongMediaInputsDigest, computeLongMediaJobRequestDigest, type LongMediaPlanRequest } from "@breatic/shared";
import {
  acceptLongMediaProbeReport,
  acceptLongMediaSegmentReport,
  serveLongMediaSource,
  writeLongMediaSegment,
} from "@ingest/jobs/long-media-routes.js";
import { head } from "@ingest/__tests__/helpers/encoder-heads.js";
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
  },
  profileId: "source-file-v1",
  profileVersion: "source-file-v1",
  encodingProfile: {
    audioCodec: "libmp3lame",
    audioBitrate: "128k",
    videoCodec: "libx264",
    videoCrf: 23,
    videoAudioCodec: "aac",
    videoAudioBitrate: "128k",
  },
  limitsSnapshot: {
    maxSourceBytes: 2_147_483_648,
    maxSources: 10,
    maxSegmentBytes: 20_000_000,
    audioCoreSeconds: 300,
    videoCoreSeconds: 60,
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
    startUs: "0",
    endUs: "10000000",
  }],
  mediaInputs: [{
    mediaInputId: "source-audio-0",
    descriptor: { inputKind: "source_file" as const, mediaKind: "audio" as const },
    sourceRange: { startUs: "0", endUs: "10000000" },
  }],
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

    const changed = { ...conflictPayload, source: { ...payload.source, sha256: "c".repeat(64) } };
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

  it("returns the validated probe report only to the backend", async () => {
    const reportPayload = { ...payload, jobId: "operation-probe-read:source-0", operationId: "operation-probe-read" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(reportPayload) });
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(reportPayload.jobId));
    await stub.startAttempt("probe-read-attempt", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "probe-read-attempt", epoch: 1 }, Date.now());
    await stub.applyProbeReport("probe-read-attempt", 1, probeReport, Date.now());

    const path = `/long-media/jobs/${encodeURIComponent(reportPayload.jobId)}/probe`;
    const unauthorized = await call(path, { method: "GET" }, false);
    const response = await call(path, { method: "GET" });

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(probeReport);
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
      report: { mediaInputs: [{ descriptor: { inputKind: "source_file", mediaKind: "audio" } }] },
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
    await expect(stub.transition({ type: "planAck", hasRunnableSegments: true }, Date.now())).resolves.toBeNull();
    const segments = [{
      id: `source-audio-0:0:10000000`,
      mediaInputId: "source-audio-0",
      descriptor: { inputKind: "source_file" as const, mediaKind: "audio" as const },
      core: { startUs: "0", endUs: "10000000" },
      decode: { startUs: "0", endUs: "10000000" },
    }];

    await expect(stub.seedSegmentPlan(segments, 0)).resolves.toMatchObject({ kind: "accepted", revision: 1 });
    await expect(stub.seedSegmentPlan(segments, 0)).resolves.toMatchObject({ kind: "replayed", revision: 1 });
    await expect(stub.readSegments()).resolves.toMatchObject(segments.map((segment) => ({ ...segment, status: "planned", version: 0 })));
    await expect(stub.transition({ type: "planAck", hasRunnableSegments: false }, Date.now())).resolves.toMatchObject({
      snapshot: { phase: "running" },
      effects: ["startMediaAttempt"],
    });
    await expect(stub.applySegmentEvent(segments[0]!.id, 0, { type: "run" })).resolves.toMatchObject({
      kind: "accepted",
      status: "encoding",
      version: 1,
    });
    const measured = { sha256: "b".repeat(64), sizeBytes: 4321, contentType: "audio/mpeg" };
    await expect(stub.applySegmentEvent(segments[0]!.id, 0, { type: "measured", measured })).resolves.toEqual({ kind: "stale" });
    await expect(stub.applySegmentEvent(segments[0]!.id, 1, { type: "measured", measured })).resolves.toEqual({ kind: "invalid" });
    await expect(stub.readSegments()).resolves.toMatchObject([
      { ...segments[0], status: "encoding", version: 1, measured: null },
    ]);
  });

  it("accepts one complete root plan for the source file timeline", async () => {
    const rootPayload = { ...payload, jobId: "operation-root-plan:source-0", operationId: "operation-root-plan" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(rootPayload) });
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(rootPayload.jobId));
    await stub.startAttempt("root-plan-probe", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "root-plan-probe", epoch: 1 }, Date.now());
    await stub.applyProbeReport("root-plan-probe", 1, probeReport, Date.now());
    const root = await rootInputPlan(0, 0);

    const unauthorized = await call(`/long-media/jobs/${encodeURIComponent(rootPayload.jobId)}/plan`, {
      method: "PUT",
      body: JSON.stringify(root),
    }, false);
    expect(unauthorized.status).toBe(401);
    const firstMutation = await call(`/long-media/jobs/${encodeURIComponent(rootPayload.jobId)}/plan`, {
      method: "PUT",
      body: JSON.stringify(root),
    });
    expect(firstMutation.status).toBe(200);
    await expect(firstMutation.json()).resolves.toMatchObject({ kind: "accepted", revision: 1, complete: true });
    const segmentsPath = `/long-media/jobs/${encodeURIComponent(rootPayload.jobId)}/segments`;
    const unauthenticatedSegments = await call(segmentsPath, { method: "GET" }, false);
    const segmentsResponse = await call(segmentsPath, { method: "GET" });
    expect(unauthenticatedSegments.status).toBe(401);
    expect(segmentsResponse.status).toBe(200);
    await expect(segmentsResponse.json()).resolves.toMatchObject(root.intervals.map((segment) => ({
      id: segment.id,
      core: segment.core,
      decode: segment.decode,
      status: "planned",
      storageKey: root.grants.find((grant) => grant.segmentId === segment.id)?.storageKey,
    })));
    await expect(stub.applyLongMediaPlan(root)).resolves.toMatchObject({ kind: "replayed", revision: 1 });
    await expect(stub.transition({ type: "planAck", hasRunnableSegments: false }, Date.now())).resolves.toMatchObject({
      snapshot: { phase: "running" },
      effects: ["startMediaAttempt"],
    });
    await expect(stub.segmentWritePermit("understand/root-0.mp3")).resolves.toBeNull();
    const segmentId = root.intervals[0]?.id;
    if (segmentId === undefined) throw new Error("The root segment is missing");
    await expect(stub.applySegmentEvent(segmentId, 0, { type: "run" })).resolves.toMatchObject({ status: "encoding" });
    await expect(stub.segmentWritePermit("understand/root-0.mp3")).resolves.toEqual({
      segmentId,
      storageKey: "understand/root-0.mp3",
      expectedVersion: 1,
      maxBytes: payload.limitsSnapshot.maxSegmentBytes,
      mediaKind: "audio",
    });
    const context = {
      className: "LongMediaContainer",
      containerId: env.LONG_MEDIA.idFromName(rootPayload.jobId).toString(),
      params: { jobId: rootPayload.jobId },
    };
    const refusedWrite = await writeLongMediaSegment(
      new Request("http://long-media-output.local/not-granted.mp4", { method: "PUT", body: head("m4a") }),
      env,
      context,
    );
    expect(refusedWrite.status).toBe(403);
    const acceptedWrite = await writeLongMediaSegment(
      new Request("http://long-media-output.local/understand/root-0.mp3", { method: "PUT", body: head("m4a") }),
      env,
      context,
    );
    expect(acceptedWrite.status).toBe(200);
    await expect(stub.readSegments()).resolves.toMatchObject([{
      id: segmentId,
      status: "stored",
      version: 2,
      measured: { sizeBytes: head("m4a").byteLength, contentType: "audio/mp4" },
    }]);
    await expect(stub.segmentWritePermit("understand/root-0.mp3")).resolves.toBeNull();
    await expect(stub.readSegments()).resolves.toHaveLength(1);
  });

  it("replaces only an oversize parent with an exact same-input child partition", async () => {
    const splitPayload = { ...payload, jobId: "operation-split-plan:source-0", operationId: "operation-split-plan" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(splitPayload) });
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(splitPayload.jobId));
    await stub.startAttempt("split-plan-probe", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "split-plan-probe", epoch: 1 }, Date.now());
    await stub.applyProbeReport("split-plan-probe", 1, probeReport, Date.now());
    const root = await rootInputPlan(0, 0);
    const accepted = await stub.applyLongMediaPlan(root);
    expect(accepted).toMatchObject({ kind: "accepted", revision: 1 });
    const parentId = root.intervals[0]?.id;
    if (parentId === undefined) throw new Error("The root segment is missing");
    await expect(stub.applySegmentEvent(parentId, 0, { type: "run" })).resolves.toMatchObject({ status: "encoding" });
    await expect(stub.applySegmentEvent(parentId, 1, { type: "oversize" })).resolves.toMatchObject({ status: "oversize" });
    const input = probeReport.mediaInputs[0];
    if (input === undefined) throw new Error("The probe input is missing");
    const child = (startUs: string, endUs: string, suffix: string) => ({
      id: `${input.mediaInputId}:${startUs}:${endUs}`,
      mediaInputId: input.mediaInputId,
      descriptor: input.descriptor,
      core: { startUs, endUs },
      decode: { startUs, endUs },
      mode: "prepare" as const,
      suffix,
    });
    const left = child("0", "5000000", "left");
    const right = child("5000000", "10000000", "right");
    const replacement: LongMediaPlanRequest = {
      ...root,
      expectedVersion: 1,
      mutationId: "split-audio-0",
      parentId,
      intervals: [left, right].map((segment) => ({
        id: segment.id,
        mediaInputId: segment.mediaInputId,
        descriptor: segment.descriptor,
        core: segment.core,
        decode: segment.decode,
        mode: segment.mode,
      })),
      grants: [left, right].map((segment) => ({
        segmentId: segment.id,
        candidateId: `candidate-${segment.suffix}`,
        grantId: `grant-${segment.suffix}`,
        storageKey: `understand/${segment.suffix}.mp3`,
      })),
    };

    await expect(stub.applyLongMediaPlan(replacement)).resolves.toMatchObject({
      kind: "accepted",
      revision: 2,
      complete: true,
    });
    await expect(stub.readSegments()).resolves.toMatchObject([
      { id: parentId, status: "superseded", version: 3 },
      { id: left.id, status: "planned", version: 0 },
      { id: right.id, status: "planned", version: 0 },
    ]);
  });

  it("marks only the current encoding segment failed from a Container report", async () => {
    const reportPayload = { ...payload, jobId: "operation-segment-report:source-0", operationId: "operation-segment-report" };
    await call("/long-media/jobs", { method: "POST", body: await requestBody(reportPayload) });
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(reportPayload.jobId));
    await stub.startAttempt("segment-report-probe", Date.now());
    await stub.applyAttemptEvent({ type: "accepted", attemptId: "segment-report-probe", epoch: 1 }, Date.now());
    await stub.applyProbeReport("segment-report-probe", 1, probeReport, Date.now());
    const plan = await rootInputPlan(0, 0);
    await stub.applyLongMediaPlan(plan);
    await stub.transition({ type: "planAck", hasRunnableSegments: true }, Date.now());
    const segmentId = plan.intervals[0]?.id;
    if (segmentId === undefined) throw new Error("The root segment is missing");
    await stub.applySegmentEvent(segmentId, 0, { type: "run" });
    const context = {
      className: "LongMediaContainer",
      containerId: env.LONG_MEDIA.idFromName(reportPayload.jobId).toString(),
      params: { jobId: reportPayload.jobId },
    };
    const malformed = await acceptLongMediaSegmentReport(
      new Request(`http://long-media.local/segment-report/${encodeURIComponent(segmentId)}`, {
        method: "POST",
        body: JSON.stringify({ outcome: "partial" }),
      }),
      env,
      context,
    );
    expect(malformed.status).toBe(400);
    const reported = await acceptLongMediaSegmentReport(
      new Request(`http://long-media.local/segment-report/${encodeURIComponent(segmentId)}`, {
        method: "POST",
        body: JSON.stringify({ outcome: "failed" }),
      }),
      env,
      context,
    );
    expect(reported.status).toBe(200);
    await expect(stub.readSegments()).resolves.toMatchObject([{ id: segmentId, status: "failed", version: 2 }]);
  });
});

/** Create one complete root interval mutation for a required media input. */
async function rootInputPlan(inputIndex: number, expectedVersion: number): Promise<LongMediaPlanRequest> {
  const input = probeReport.mediaInputs[inputIndex];
  if (input === undefined) throw new Error(`No probe input at index ${inputIndex}`);
  const segmentId = `${input.mediaInputId}:0:10000000`;
  return {
    expectedVersion,
    mutationId: `root-plan-${inputIndex}`,
    requiredMediaInputs: probeReport.mediaInputs,
    requiredMediaInputsDigest: await computeLongMediaInputsDigest(payload.source.sha256, payload.profileVersion, probeReport.mediaInputs),
    mediaInputId: input.mediaInputId,
    parentId: null,
    intervals: [{
      id: segmentId,
      mediaInputId: input.mediaInputId,
      descriptor: input.descriptor,
      core: { startUs: "0", endUs: "10000000" },
      decode: { startUs: "0", endUs: "10000000" },
      mode: "prepare",
    }],
    grants: [{
      segmentId,
      candidateId: `candidate-${inputIndex}`,
      grantId: `grant-${inputIndex}`,
      storageKey: `understand/root-${inputIndex}.mp3`,
    }],
  };
}
