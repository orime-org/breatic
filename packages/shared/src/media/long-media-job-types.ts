// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Immutable identity and resource limits for one long-media job. */
export interface LongMediaJobRequest {
  protocolVersion: 1;
  jobId: string;
  operationId: string;
  sourceIndex: number;
  source: {
    key: string;
    sha256: string;
    sizeBytes: number;
  };
  profileId: string;
  profileVersion: string;
  encodingProfile: {
    audioCodec: string;
    audioBitrate: string;
    videoCodec: string;
    videoCrf: number;
    videoAudioCodec: string;
    videoAudioBitrate: string;
  };
  limitsSnapshot: {
    maxSourceBytes: number;
    maxSources: number;
    maxSegmentBytes: number;
    audioCoreSeconds: number;
    videoCoreSeconds: number;
    maxActiveLeaves: number;
  };
  deadlineAt: number;
  requestDigest: string;
}

/** Registered source facts resolved before a long-media job is submitted. */
export type LongMediaSourceReference = LongMediaJobRequest["source"] & { mimeType: string };

/** Canonical request fields before adding the digest. */
export type LongMediaJobPayload = Omit<LongMediaJobRequest, "requestDigest">;
