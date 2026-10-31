// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { LongMediaJobRequest } from "@breatic/shared";
import { objectUrlOn } from "@ingest/object-url.js";
import type { LongMediaSegmentSnapshot } from "@ingest/jobs/long-media-container.js";

/** One authenticated-by-interception request for a planned segment. */
export interface LongMediaSegmentContainerRequest {
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
 * Build the Container request from the immutable job and durable segment facts.
 * @param job - The verified immutable long-media request.
 * @param segment - The persisted segment and its Node-issued output key.
 * @param hosts - The intercepted output and report hostnames.
 * @returns The strict Container request body.
 * @throws {RangeError} When the segment cannot be run from its current durable state.
 */
export function longMediaSegmentContainerRequest(
  job: LongMediaJobRequest,
  segment: LongMediaSegmentSnapshot,
  hosts: { output: string; report: string },
): LongMediaSegmentContainerRequest {
  const mediaKind = segment.descriptor.mediaKind;
  if (segment.status !== "encoding" || segment.storageKey === null ||
      (mediaKind !== "audio" && mediaKind !== "video")) {
    throw new RangeError("A long-media Container request requires an encoding segment with an authorized output key.");
  }
  return {
    objectUrl: objectUrlOn("r2.local", job.source.key),
    outputUrl: objectUrlOn(hosts.output, segment.storageKey),
    reportUrl: `http://${hosts.report}/segment-report/${encodeURIComponent(segment.id)}`,
    mediaKind,
    interval: segment.decode,
    profile: job.encodingProfile,
    maxOutputBytes: job.limitsSnapshot.maxSegmentBytes,
    deadlineAt: job.deadlineAt,
  };
}
