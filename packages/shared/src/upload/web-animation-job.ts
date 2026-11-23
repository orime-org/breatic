// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The web-animation container job protocol between our worker and the ingest Worker (inner#1711 design §3.7). Both
 * ends read these shapes on two runtimes, so the request, the cancel body and the report live here once.
 */

import { z } from "zod";

import { TimelineRateSchema } from "@shared/timeline/schema.js";

/**
 * Why an upstream refused the payer's own key, as a job report names it (inner#1953): `ACCOUNT_KEY_FAILURE_REASONS` of
 * the main entry, written here because this module ships through `space-content`, and importing what web calls from
 * the main entry would move that into the chunk the Timeline schemas share with Yjs. A test holds the two equal.
 */
export const JOB_KEY_FAILURE_REASONS = ["invalid", "no_balance", "model_not_found", "rate_limited"] as const;

/** The container class `POST /jobs` dispatches web-animation jobs to. */
export const WEB_ANIMATION_CONTAINER_CLASS = "WebAnimationContainer";

const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();
/** Package and Manifest stay under the private prefix, never on the public asset domain. */
const webAnimationKey = z.string().min(1).max(500).startsWith("web-animation/");

/**
 * A JSON value with every object's keys in sorted order.
 * @param value - The value.
 * @returns The same value, its keys sorted at every depth.
 * @throws {never} Never.
 */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]));
}

/**
 * Where the job's model calls go, in order: the plan provider's `messagesPlan` made on the worker, which the ingest
 * Worker hands to provider's Messages relay. shared imports no provider, so a direct upstream's prices pass through
 * as provider wrote them.
 */
const messagesPlan = z.object({
  model: z.string().min(1).max(200),
  /** Set when the plan was made on the payer's own keys (inner#1953): the relay then ends the job on a refused key. */
  keysOwner: z.literal("account").optional(),
  candidates: z.array(z.object({
    upstream: z.string().min(1),
    kind: z.string().min(1),
    baseUrl: z.string().min(1),
    vendorModel: z.string().min(1),
    keyEnv: z.string().min(1),
    // jsonb does not keep key order, and the prices are no fixed shape a schema could restore it from: sorting them
    // makes a request read back from its stored step submit the same bytes as the first submission.
    prices: z.array(z.record(z.string(), z.unknown())).transform((entries) => entries.map((entry) => sortedKeys(entry) as Record<string, unknown>)).optional(),
  })).min(1),
});

/** What the worker submits; every limit is read from yaml by the worker, because the ingest Worker cannot read it. */
export const webAnimationJobRequestSchema = z.object({
  containerClass: z.literal(WEB_ANIMATION_CONTAINER_CLASS),
  jobId: z.string().min(1).max(200),
  /** Epoch ms; the job expires when it is reached. */
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
  /**
   * The keys the job's model calls run on, `{ [upstream]: key }` sealed to the Worker's public key (inner#1953): the
   * payer's own when the plan was made on them, ours otherwise. Added by the worker at each submit and never stored;
   * the Worker opens it into the job object's memory only. Absent only from a backend deployed before it.
   */
  sealedKeys: z.string().min(1).max(16_384).optional(),
  /**
   * Absent only from a backend deployed before the plan (inner#1743): a Worker deployed after it answers such a
   * submit 501 `feature_disabled`; remove the optional once every job submitted without it is past its deadline.
   */
  messagesPlan: messagesPlan.optional(),
});

/** What the worker submits. */
export type WebAnimationJobRequest = z.infer<typeof webAnimationJobRequestSchema>;

/** A cancel body; with no job record yet, the pre-submit cancel marker lives until `deadlineAt`. */
export const webAnimationJobCancelSchema = z.object({ deadlineAt: positiveInteger });

/** A cancel body. */
export type WebAnimationJobCancel = z.infer<typeof webAnimationJobCancelSchema>;

const call = z.object({
  seq: positiveInteger,
  /** Who served the call; null when no upstream did. */
  upstream: z.string().min(1).nullable().optional(),
  /** The id `message_start` named; null when the stream never named one. */
  messageId: z.string().min(1).nullable().optional(),
  tokens: z.object({
    input: nonnegativeInteger, output: nonnegativeInteger, reasoning: nonnegativeInteger, cacheRead: nonnegativeInteger,
  }).nullable(),
  /** provider's `Cost` as the relay gave it, read by the worker with provider's `costSchema`; null for no cost. */
  cost: z.unknown().optional(),
  /**
   * What a Worker deployed before the plan reports instead of the three fields above (inner#1743); remove both once
   * every job such a Worker ran is past its deadline.
   */
  generationId: z.string().min(1).nullable().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
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
  /**
   * The upstream a refused key read named (inner#1953); null when the failure names none, absent from a Worker
   * deployed before it.
   */
  failureUpstream: z.string().min(1).nullable().optional(),
  /** Why the upstream refused the payer's own key (`account_key_failed`); null otherwise, absent from an older Worker. */
  failureKeyReason: z.enum(JOB_KEY_FAILURE_REASONS).nullable().optional(),
});

/** What a job answers. */
export type WebAnimationJobReport = z.infer<typeof webAnimationJobReportSchema>;

/** One model call a job made. */
export type WebAnimationJobCall = z.infer<typeof call>;
