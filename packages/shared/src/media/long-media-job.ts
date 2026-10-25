// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

import type { LongMediaJobPayload, LongMediaJobRequest } from "@shared/media/long-media-job-types.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);

const limitsSnapshot = z.object({
  maxSourceBytes: z.number().int().positive(),
  maxSources: z.number().int().positive(),
  maxSegmentBytes: z.number().int().positive(),
  audioCoreSeconds: z.number().int().positive(),
  videoCoreSeconds: z.number().int().positive(),
  maxActiveLeaves: z.number().int().positive(),
}).strict();

const encodingProfile = z.object({
  audioCodec: z.string().min(1).max(32),
  audioBitrate: z.string().min(1).max(16),
  videoCodec: z.string().min(1).max(32),
  videoCrf: z.number().int().min(0).max(51),
  videoAudioCodec: z.string().min(1).max(32),
  videoAudioBitrate: z.string().min(1).max(16),
}).strict();

/** The immutable source and processing budget submitted to one media job. */
export const LongMediaJobRequestSchema = z.object({
  protocolVersion: z.literal(1),
  jobId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  sourceIndex: z.number().int().nonnegative(),
  source: z.object({
    key: z.string().min(1).max(500),
    sha256,
    sizeBytes: z.number().int().positive(),
  }).strict(),
  profileId: z.string().min(1).max(64),
  profileVersion: z.string().min(1).max(64),
  encodingProfile,
  limitsSnapshot,
  deadlineAt: z.number().int().positive(),
  requestDigest: sha256,
}).strict().superRefine((request, context) => {
  if (request.sourceIndex >= request.limitsSnapshot.maxSources) {
    context.addIssue({ code: "custom", path: ["sourceIndex"], message: "The source index exceeds the frozen source limit." });
  }
  if (request.source.sizeBytes > request.limitsSnapshot.maxSourceBytes) {
    context.addIssue({ code: "custom", path: ["source", "sizeBytes"], message: "The source exceeds the frozen byte limit." });
  }
});

export type { LongMediaJobPayload, LongMediaJobRequest, LongMediaSourceReference } from "@shared/media/long-media-job-types.js";

/**
 * Compute the digest over the immutable job payload in schema field order.
 * @param request - The validated payload without its digest.
 * @returns A lowercase SHA-256 digest.
 * @throws {DOMException} When the runtime cannot compute SHA-256.
 */
export async function computeLongMediaJobRequestDigest(request: LongMediaJobPayload): Promise<string> {
  const canonical = {
    protocolVersion: request.protocolVersion,
    jobId: request.jobId,
    operationId: request.operationId,
    sourceIndex: request.sourceIndex,
    source: {
      key: request.source.key,
      sha256: request.source.sha256.toLowerCase(),
      sizeBytes: request.source.sizeBytes,
    },
    profileId: request.profileId,
    profileVersion: request.profileVersion,
    encodingProfile: {
      audioCodec: request.encodingProfile.audioCodec,
      audioBitrate: request.encodingProfile.audioBitrate,
      videoCodec: request.encodingProfile.videoCodec,
      videoCrf: request.encodingProfile.videoCrf,
      videoAudioCodec: request.encodingProfile.videoAudioCodec,
      videoAudioBitrate: request.encodingProfile.videoAudioBitrate,
    },
    limitsSnapshot: {
      maxSourceBytes: request.limitsSnapshot.maxSourceBytes,
      maxSources: request.limitsSnapshot.maxSources,
      maxSegmentBytes: request.limitsSnapshot.maxSegmentBytes,
      audioCoreSeconds: request.limitsSnapshot.audioCoreSeconds,
      videoCoreSeconds: request.limitsSnapshot.videoCoreSeconds,
      maxActiveLeaves: request.limitsSnapshot.maxActiveLeaves,
    },
    deadlineAt: request.deadlineAt,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse an untrusted job request.
 * @param value - The request body.
 * @returns The validated request.
 * @throws {Error} When its version, shape, identity, fingerprint, or limits are invalid.
 */
export function readLongMediaJobRequest(value: unknown): LongMediaJobRequest {
  const parsed = LongMediaJobRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error("The long media job request is invalid");
  return parsed.data;
}

/**
 * Parse a request and verify that its digest binds every immutable field.
 * @param value - The request body.
 * @returns The validated request with a matching digest.
 * @throws {Error} When its shape is invalid or its digest does not match.
 * @throws {DOMException} When the runtime cannot compute SHA-256.
 */
export async function verifyLongMediaJobRequest(value: unknown): Promise<LongMediaJobRequest> {
  const request = readLongMediaJobRequest(value);
  const { requestDigest, ...payload } = request;
  const expected = await computeLongMediaJobRequestDigest(payload);
  if (requestDigest.toLowerCase() !== expected) {
    throw new Error("The long media job request digest does not match its payload");
  }
  return request;
}
