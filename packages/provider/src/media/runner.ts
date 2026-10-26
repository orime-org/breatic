// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Cost } from "@provider/cost.js";
import type { Provider } from "@provider/provider.js";
import type { Route } from "@provider/routing/route.js";

/**
 * Everything provider knows about one media run. The caller stores it as JSON
 * and hands it back; only `version` is the caller's to read, for a
 * compare-and-set write (design 12.2).
 */
export interface MediaTicket {
  readonly version: number;
  readonly [key: string]: unknown;
}

/** What one step of a run does. */
export type StepKind = "generate" | "upload_reference" | "upload_melody" | "vocal" | "voice" | "speak" | "element" | "describe";

/** One output of a finished run (design 3.4, S5). */
export type MediaOutput =
  | { kind: "url"; url: string; contentType?: string }
  | { kind: "bytes"; bytes: Uint8Array; contentType: string };

/** One cached clone, as the caller stores it. */
export interface MediaClone {
  upstream: string;
  kind: "voice" | "vocal" | "element";
  /** The source asset's sha256, with a suffix for an element. */
  sourceKey: string;
  upstreamId: string;
}

/** Something provider wants the caller to log (design 3.7). */
export interface MediaWarning {
  code: string;
  detail: Record<string, unknown>;
}

/** What every answer carries. */
interface AnswerCommon {
  /** Clones this answer made. */
  clones: MediaClone[];
  /** Cached clones the upstream said are gone. */
  retiredClones: MediaClone[];
  warnings: MediaWarning[];
}

/** Where a run is after one call (design 3.4). */
export type MediaAnswer = AnswerCommon &
  (
    | { state: "send"; ticket: MediaTicket; step: { kind: StepKind } }
    | { state: "running"; ticket: MediaTicket; askAgainAt: number }
    | { state: "done"; outputs: MediaOutput[]; costs: Cost[]; servedBy: string }
    | { state: "failed"; reason: Error; costs: Cost[] }
  );

/** What the run is asked to make. */
export interface MediaInput {
  prompt: string;
  /** Our params, in our names. */
  params: Record<string, unknown>;
}

/** What `plan` needs beyond the input. */
export interface PlanOptions {
  /** Unique per task; client keys are derived from it. */
  idempotencyKey: string;
  /** Source url to the sha256 of the asset behind it, from the caller's asset table. */
  sourceKeys: Record<string, string>;
  /** Live clones of these sources on every upstream. */
  clones: MediaClone[];
}

/** The bounds of one call. */
export interface CallBounds {
  /** The task's deadline, in epoch milliseconds. */
  deadlineAt: number;
  signal?: AbortSignal;
}

/** The bounds of one poll. */
export interface PollOptions extends CallBounds {
  /** The last question after the deadline: the status and billing reads are not cut by it. */
  finalAsk?: boolean;
}

/** One `task_upstream_steps` row written before the provider layer (design 3.4, X3). */
export interface LegacyStep {
  position: number;
  kind: Exclude<StepKind, "describe">;
  endpoint: string;
  itemIndex: number | null;
  status: "pending" | "submitted" | "done" | "failed";
  predictionId: string | null;
  output: Record<string, unknown>;
  inlineCostUsd: number;
}

/** What a task in flight at deploy left behind. */
export interface LegacyRows {
  providerTaskId?: string | null;
  steps?: LegacyStep[];
}

/** Media runs as tickets (design 3.4). */
export interface MediaRunner {
  plan(model: string, input: MediaInput, route: Route, options: PlanOptions): Promise<MediaAnswer>;
  send(ticket: MediaTicket, bounds: CallBounds): Promise<MediaAnswer>;
  poll(ticket: MediaTicket, options: PollOptions): Promise<MediaAnswer>;
  recover(ticket: MediaTicket, bounds: CallBounds): Promise<MediaAnswer>;
  ticketFromLegacy(model: string, input: MediaInput, route: Route, options: PlanOptions, legacy: LegacyRows): Promise<MediaAnswer>;
}

/** Limits on the media provider reads itself. */
export interface MediaRunnerOptions {
  mediaLimits: { maxMediaBytes: number };
}

/**
 * Build the media runner for one provider instance.
 * @param provider - The instance.
 * @param options - Limits on the media it reads.
 * @returns The runner.
 */
export function createMediaRunner(provider: Provider, options: MediaRunnerOptions): MediaRunner {
  void provider; void options;
  throw new Error("createMediaRunner is not implemented");
}
