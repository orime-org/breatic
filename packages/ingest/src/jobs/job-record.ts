// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { IngestMeasurements, MiniToolJobRequest, MiniToolPlanJobRequest } from "@breatic/shared";
import type { ContainerReportBody, MediaOfOutput, PlanContainerReportBody } from "@ingest/jobs/container-report.js";
import type { JobState } from "@ingest/jobs/transition.js";

/** The one durable record shared by all of a job object's mutation paths. */
export const JOB_RECORD_KEY = "job";
/** Byte facts computed from the object stored in R2. */
export type JobWritten = Pick<IngestMeasurements, "sha256" | "sizeBytes" | "contentType">;
/** Monotonic application observations, distinct from provider billing or measured usage. */
export interface PlannedStartFacts {
  startRequested: boolean;
  startResolved: boolean;
  runningObserved: boolean;
  runDispatchAttempted: boolean;
  runAcknowledged: boolean;
}
/** The persisted job and its immutable byte observations. */
export interface StoredMiniToolJob {
  state: JobState;
  request: MiniToolJobRequest | MiniToolPlanJobRequest;
  reported?: ContainerReportBody | PlanContainerReportBody;
  written: Record<string, JobWritten>;
  media: Record<string, MediaOfOutput>;
  cpuUsec: number | null;
  writeClaims?: Record<string, string>;
  startFacts?: PlannedStartFacts;
}
