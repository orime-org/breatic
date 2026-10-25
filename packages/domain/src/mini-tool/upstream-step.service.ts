// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import type { UpstreamStep } from "@domain/task/upstreamStep.repo.js";
import type { MiniToolConsumptionRecord } from "@domain/mini-tool/consumption.types.js";

/** Finite owned JSON at the persistence boundary. */
export type MiniToolStepJson = null | boolean | number | string | MiniToolStepJson[] | { [key: string]: MiniToolStepJson };
/** A pure operation-owned result decoder; no provider or storage IO belongs here. */
export interface MiniToolStepResultParser {
  kind: "generate" | "container_job";
  parse: (value: unknown) => Record<string, MiniToolStepJson>;
}
/** A durable intent, distinct from proof that the provider accepted a request. */
export interface MiniToolStepAttempt {
  attemptId: string;
  preparedAt: string;
  requestFingerprint: string;
  resolution: { kind: "unresolved" } | { kind: "identity"; predictionId: string } | { kind: "rejected" | "not_sent"; error: Record<string, MiniToolStepJson> };
}
/** Internal submit inputs; first policy and request facts win on recovery. */
export interface BeginMiniToolStepAttemptInput {
  taskId: string; stepId: string; attemptId: string; deadlineAt: number;
  requestBody: Record<string, MiniToolStepJson>; chargeTo: "user" | "platform";
}
/** Only the first preparation of a new attempt can authorize the caller's POST. */
export interface BeginMiniToolStepAttemptResult { step: UpstreamStep; attempt: MiniToolStepAttempt | null; shouldSubmit: boolean }
/** A receipt is tied to an existing immutable submit intent. */
export interface RecordMiniToolStepIdentityInput { taskId: string; stepId: string; attemptId: string; predictionId: string }
/** A conflicting receipt preserves the canonical identity and never assigns replacement fees. */
export interface RecordMiniToolStepIdentityResult { step: UpstreamStep; consumption: MiniToolConsumptionRecord | null; conflict: boolean }
/** A decoded terminal result remains independent from its consumption's fee state. */
export interface RecordMiniToolStepResultInput {
  taskId: string; stepId: string; identity: MiniToolConsumptionIdentity;
  outcome: "done" | "failed"; result: unknown; error?: Record<string, MiniToolStepJson>;
}
/** Explicit attempt resolution can only describe that particular original request. */
export interface FailMiniToolStepInput {
  taskId: string; stepId: string; error: Record<string, MiniToolStepJson>;
  attempt?: { attemptId: string; proof: "not_sent" | "rejected" };
}

/**
 * Persist an owned request intent before the caller can submit it.
 * @param input - The owned scope and immutable request intent.
 * @throws {Error} When persistence, ownership or the original submit fence fails.
 */
export async function beginMiniToolStepAttempt(input: BeginMiniToolStepAttemptInput): Promise<BeginMiniToolStepAttemptResult> {
  void input;
  throw new Error("Planned step attempt persistence awaits independent RED");
}

/**
 * Save a matching prediction receipt and its pending expense in one transaction.
 * @param input - A receipt tied to the original durable intent.
 * @throws {Error} When no matching durable attempt authorizes this receipt.
 */
export async function recordMiniToolStepIdentity(input: RecordMiniToolStepIdentityInput): Promise<RecordMiniToolStepIdentityResult> {
  void input;
  throw new Error("Planned step identity persistence awaits independent RED");
}

/**
 * Save an operation-validated terminal result without rewriting fee or plan facts.
 * @param input - The original identity and operation result.
 * @param parser - A pure decoder for that operation and step kind.
 * @throws {Error} When parsing, identity, ownership or persistence fails.
 */
export async function recordMiniToolStepResult(input: RecordMiniToolStepResultInput, parser: MiniToolStepResultParser): Promise<UpstreamStep> {
  void input; void parser;
  throw new Error("Planned step result persistence awaits independent RED");
}

/**
 * Preserve the first failure and any explicit resolution of its own submit intent.
 * @param input - The failure and any specifically evidenced attempt resolution.
 * @throws {Error} When ownership, resolution proof or persistence fails.
 */
export async function failMiniToolStep(input: FailMiniToolStepInput): Promise<UpstreamStep> {
  void input;
  throw new Error("Planned step failure persistence awaits independent RED");
}
