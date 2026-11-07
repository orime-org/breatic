// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation container job protocol between our worker and the ingest Worker (inner#1711 design §3.7). Both
 * ends read these shapes on two runtimes, so the request, the cancel body and the report live here once.
 */

import { z } from "zod";

import { TimelineRateSchema } from "@shared/timeline/schema.js";

/** The container class `POST /jobs` dispatches web-animation jobs to. */
export const WEB_ANIMATION_CONTAINER_CLASS = "WebAnimationContainer";

const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();
/** Package and Manifest stay under the private prefix, never on the public asset domain. */
const webAnimationKey = z.string().min(1).max(500).startsWith("web-animation/");

/** What the worker submits; every limit is read from yaml by the worker, because the ingest Worker cannot read it. */
export const webAnimationJobRequestSchema = z.object({
  containerClass: z.literal(WEB_ANIMATION_CONTAINER_CLASS),
  jobId: z.string().min(1).max(200),
  /** Epoch ms; the job fails when it is reached. */
  deadlineAt: positiveInteger,
  prompt: z.string().min(1),
  viewport: z.object({ width: positiveInteger, height: positiveInteger }),
  fps: TimelineRateSchema,
  durationFrames: positiveInteger,
  packageKey: webAnimationKey,
  manifestKey: webAnimationKey,
  fontSetVersion: positiveInteger,
  maxPackageBytes: positiveInteger,
  maxTokens: positiveInteger,
  callTimeoutMs: positiveInteger,
  model: z.string().min(1).max(200),
});

/** What the worker submits. */
export type WebAnimationJobRequest = z.infer<typeof webAnimationJobRequestSchema>;

/** A cancel body; with no job record yet, the pre-submit cancel marker lives until `deadlineAt`. */
export const webAnimationJobCancelSchema = z.object({ deadlineAt: positiveInteger });

/** A cancel body. */
export type WebAnimationJobCancel = z.infer<typeof webAnimationJobCancelSchema>;

const call = z.object({
  seq: positiveInteger,
  /** Null when the upstream answered no generation. */
  generationId: z.string().min(1).nullable(),
  tokens: z.object({
    input: nonnegativeInteger, output: nonnegativeInteger, reasoning: nonnegativeInteger, cacheRead: nonnegativeInteger,
  }).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  outcome: z.enum(["completed", "upstream_error", "interrupted", "cut_off"]),
});

/** What a job answers. */
export const webAnimationJobReportSchema = z.object({
  state: z.enum(["running", "stopping", "done", "failed", "cancelled", "expired", "cancelled_before_submit"]),
  /** The user-visible phase; null before the container starts writing. */
  phase: z.enum(["writing", "validating", "saving"]).nullable(),
  /** Runtime tool calls and validation results, kept for the execution's details. */
  steps: z.array(z.unknown()),
  calls: z.array(call),
  /** What the container measured about its own run; null when it never started. */
  container: z.object({ wallMs: z.number().nonnegative(), cpuUsec: z.number().nonnegative().nullable() }).nullable(),
  outputs: z.array(z.object({
    key: webAnimationKey,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: nonnegativeInteger,
  })),
  failureReason: z.string().min(1).nullable(),
});

/** What a job answers. */
export type WebAnimationJobReport = z.infer<typeof webAnimationJobReportSchema>;

/** One model call a job made. */
export type WebAnimationJobCall = z.infer<typeof call>;
