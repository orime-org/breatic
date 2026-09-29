// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upstream calls one run makes, in order (#2156, design §15.1): the
 * model's `extra_steps` placed before or after its own call, each taken only
 * when the param it serves carries something, one per item where the step is
 * per item.
 */

import type { FullModelEntry, upstreamStepRepo } from "@breatic/domain";
import { holds, type ExtraStep } from "@breatic/shared";


type PlannedStep = upstreamStepRepo.PlannedStep;
type StepKind = upstreamStepRepo.UpstreamStepKind;

/**
 * The kind of an extra step, by the endpoint it posts to and the param it
 * serves. The kind decides what the executor sends and reads back.
 * @param step - The declared extra step.
 * @returns Its kind.
 * @throws {Error} when the worker has no step that runs this endpoint.
 */
function kindOf(step: ExtraStep): StepKind {
  if (step.at === "after") return "speak";
  if (step.endpoint === "mureka-ai/create-upload-id") {
    if (step.for_param === "song") return "upload_reference";
    if (step.for_param === "melody") return "upload_melody";
  }
  if (step.endpoint === "mureka-ai/vocal-clone") return "vocal";
  if (step.endpoint === "kwaivgi/kling-elements") return "element";
  throw new Error(`No step runs ${step.endpoint}`);
}

/**
 * The steps an extra step expands into for this run.
 * @param step - The declared extra step.
 * @param params - The run's validated params.
 * @returns None when the param it serves carries nothing, one per item for a
 *   per-item step, otherwise one.
 */
function expand(step: ExtraStep, params: Readonly<Record<string, unknown>>): PlannedStep[] {
  const kind = kindOf(step);
  if (step.for_param === undefined) return [{ kind, endpoint: step.endpoint, itemIndex: null }];
  const value = params[step.for_param];
  if (!holds(value)) return [];
  if (step.per_item === true && Array.isArray(value)) {
    return value.map((_item, itemIndex) => ({ kind, endpoint: step.endpoint, itemIndex }));
  }
  return [{ kind, endpoint: step.endpoint, itemIndex: null }];
}

/**
 * The steps of the extra calls placed on one side of the model's own call.
 * @param steps - The model's declared extra steps.
 * @param at - Which side.
 * @param params - The run's validated params.
 * @returns Their steps, in declared order.
 * @throws {Error} when a step's endpoint has no step the worker can run.
 */
function placed(
  steps: readonly ExtraStep[],
  at: ExtraStep["at"],
  params: Readonly<Record<string, unknown>>,
): PlannedStep[] {
  return steps.filter((step) => step.at === at).flatMap((step) => expand(step, params));
}

/**
 * Plan a run's upstream calls.
 * @param entry - The model's catalog entry.
 * @param params - The run's validated params.
 * @returns The steps in order; the model's own call is a clone (`voice`) when
 *   the model declares which param it is reused by.
 * @throws {Error} when the model has no provider endpoint, or declares an
 *   extra step the worker cannot run.
 */
export function planSteps(entry: FullModelEntry, params: Readonly<Record<string, unknown>>): PlannedStep[] {
  const endpoint = entry.providers?.[0]?.model_id;
  if (endpoint === undefined) throw new Error(`Model '${entry.name}' has no provider endpoint`);
  const steps = entry.extra_steps ?? [];
  return [
    ...placed(steps, "before", params),
    { kind: entry.reused_by === undefined ? "generate" : "voice", endpoint, itemIndex: null },
    ...placed(steps, "after", params),
  ];
}
