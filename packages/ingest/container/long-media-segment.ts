// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { LongMediaJobRequest } from "@shared/media/long-media-job.js";
import { longMediaSegmentArgs } from "@ingest/probe-command.js";
import { runToolBounded } from "./run-tool.js";

/** The Container's request to encode and write one source-time segment. */
export interface LongMediaSegmentRunRequest {
  objectUrl: string;
  outputUrl: string;
  reportUrl: string;
  mediaKind: "audio" | "video";
  interval: { startUs: string; endUs: string };
  profile: LongMediaJobRequest["encodingProfile"];
  maxOutputBytes: number;
  deadlineAt: number;
}

/**
 * Read one strict Container segment request.
 * @param value - The untrusted request body.
 * @returns The validated segment request, or null when any field is malformed.
 * @throws {never} This parser returns null for invalid input.
 */
export function readLongMediaSegmentRunRequest(value: unknown): LongMediaSegmentRunRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sent = value as Record<string, unknown>;
  const expectedKeys = [
    "objectUrl", "outputUrl", "reportUrl", "mediaKind", "interval", "profile", "maxOutputBytes", "deadlineAt",
  ];
  if (Object.keys(sent).length !== expectedKeys.length || expectedKeys.some((key) => !(key in sent))) return null;
  if (typeof sent.objectUrl !== "string" || typeof sent.outputUrl !== "string" || typeof sent.reportUrl !== "string" ||
      (sent.mediaKind !== "audio" && sent.mediaKind !== "video") ||
      !Number.isSafeInteger(sent.maxOutputBytes) || (sent.maxOutputBytes as number) < 1 ||
      !Number.isSafeInteger(sent.deadlineAt) || (sent.deadlineAt as number) < 1) return null;
  if (typeof sent.interval !== "object" || sent.interval === null || Array.isArray(sent.interval)) return null;
  const interval = sent.interval as Record<string, unknown>;
  if (Object.keys(interval).length !== 2 || typeof interval.startUs !== "string" || typeof interval.endUs !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(interval.startUs) || !/^(0|[1-9][0-9]*)$/u.test(interval.endUs) ||
      BigInt(interval.startUs) >= BigInt(interval.endUs)) return null;
  if (typeof sent.profile !== "object" || sent.profile === null || Array.isArray(sent.profile)) return null;
  const profile = sent.profile as Record<string, unknown>;
  const profileKeys = ["audioCodec", "audioBitrate", "videoCodec", "videoCrf", "videoAudioCodec", "videoAudioBitrate"];
  if (Object.keys(profile).length !== profileKeys.length || profileKeys.some((key) => !(key in profile)) ||
      typeof profile.audioCodec !== "string" || profile.audioCodec.length < 1 || profile.audioCodec.length > 32 ||
      typeof profile.audioBitrate !== "string" || profile.audioBitrate.length < 1 || profile.audioBitrate.length > 16 ||
      typeof profile.videoCodec !== "string" || profile.videoCodec.length < 1 || profile.videoCodec.length > 32 ||
      !Number.isInteger(profile.videoCrf) || (profile.videoCrf as number) < 0 || (profile.videoCrf as number) > 51 ||
      typeof profile.videoAudioCodec !== "string" || profile.videoAudioCodec.length < 1 || profile.videoAudioCodec.length > 32 ||
      typeof profile.videoAudioBitrate !== "string" || profile.videoAudioBitrate.length < 1 || profile.videoAudioBitrate.length > 16) return null;

  return {
    objectUrl: sent.objectUrl,
    outputUrl: sent.outputUrl,
    reportUrl: sent.reportUrl,
    mediaKind: sent.mediaKind,
    interval: { startUs: interval.startUs, endUs: interval.endUs },
    profile: {
      audioCodec: profile.audioCodec,
      audioBitrate: profile.audioBitrate,
      videoCodec: profile.videoCodec,
      videoCrf: profile.videoCrf as number,
      videoAudioCodec: profile.videoAudioCodec,
      videoAudioBitrate: profile.videoAudioBitrate,
    },
    maxOutputBytes: sent.maxOutputBytes as number,
    deadlineAt: sent.deadlineAt as number,
  };
}

/** Dependencies that let the segment protocol run without a real Container. */
export interface LongMediaSegmentRunDeps {
  now(): number;
  encode(
    objectUrl: string,
    mediaKind: "audio" | "video",
    interval: LongMediaSegmentRunRequest["interval"],
    profile: LongMediaJobRequest["encodingProfile"],
    maxOutputBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer | "over_cap" | null>;
  write(outputUrl: string, bytes: Buffer, signal: AbortSignal): Promise<number>;
  report(reportUrl: string, result: "oversize" | "failed"): Promise<void>;
}

/**
 * Encode one source-time interval and send its complete bytes to the authorized Worker output.
 * @param request - Source, output, profile, interval and operation deadline.
 * @param deps - The encoder, intercepted Worker routes and clock.
 * @returns Nothing; a complete output or its measured state is persisted by the Worker route.
 */
export async function runLongMediaSegment(
  request: LongMediaSegmentRunRequest,
  deps: LongMediaSegmentRunDeps = LONG_MEDIA_SEGMENT_DEPS,
): Promise<void> {
  const remainingMs = request.deadlineAt - deps.now();
  if (remainingMs <= 0) {
    await deps.report(request.reportUrl, "failed");
    return;
  }
  const signal = AbortSignal.timeout(remainingMs);
  let encoded: Buffer | "over_cap" | null;
  try {
    encoded = await deps.encode(
      request.objectUrl,
      request.mediaKind,
      request.interval,
      request.profile,
      request.maxOutputBytes,
      signal,
    );
  } catch {
    encoded = null;
  }
  if (encoded === "over_cap") {
    await deps.report(request.reportUrl, "oversize");
    return;
  }
  if (encoded === null) {
    await deps.report(request.reportUrl, "failed");
    return;
  }

  let status: number;
  try {
    status = await deps.write(request.outputUrl, encoded, signal);
  } catch {
    await deps.report(request.reportUrl, "failed");
    return;
  }
  if (status === 200 || status === 409 || status === 413) return;
  await deps.report(request.reportUrl, "failed");
}

/** The production encoder and intercepted Worker calls. */
const LONG_MEDIA_SEGMENT_DEPS: LongMediaSegmentRunDeps = {
  now: () => Date.now(),
  encode: async (objectUrl, mediaKind, interval, profile, maxOutputBytes, signal) => runToolBounded(
    "ffmpeg",
    longMediaSegmentArgs(objectUrl, mediaKind, interval, profile),
    { maxBytes: maxOutputBytes, signal },
  ),
  write: async (outputUrl, bytes, signal) => {
    const response = await fetch(outputUrl, { method: "PUT", body: bytes, signal });
    await response.body?.cancel();
    return response.status;
  },
  report: async (reportUrl, outcome) => {
    const response = await fetch(reportUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The long media segment report was answered ${response.status}`);
  },
};
