// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether a 3D generation holds together (inner#1691 design 4.2 steps 2 and
 * 3): the model is a 3D entry serving the mode, the prompt and the number of
 * images are what the entry takes, and the settings break no rule of the
 * entry. The submit route and the agent's proposal tool both ask it, so a
 * proposal the tool lets through is one the route admits.
 *
 * It answers with facts, not sentences: the route says them in the user's
 * language, the tool says them to the agent.
 */

import {
  checkParamCombination,
  modesOf,
  picturesOf,
  extractPromptText,
  resolveParams,
  type ModelEntry,
  type ParamViolation,
} from "@breatic/shared";

import { getModelCatalog } from "@domain/model-catalog/model-catalog.js";

/** What a 3D generation asks for, before anything is resolved. */
export interface SceneGenerationAsk {
  mode: string;
  model: string;
  /** Text to 3D only. */
  prompt?: string | null;
  /** The settings, keyed by the catalog's names; `negative_prompt` among them. */
  params: Readonly<Record<string, unknown>>;
  /** How many images were given, in view order. */
  imageCount: number;
}

/** Why a 3D generation does not hold together. */
export type SceneGenerationProblem =
  | { kind: "model"; model: string; mode: string }
  | { kind: "prompt"; model: string; takesPrompt: boolean }
  | { kind: "image_count"; model: string; min: number; max: number; actual: number }
  | { kind: "not_a_setting"; model: string; param: string }
  | { kind: "violation"; violation: ParamViolation };

/** A 3D generation that holds together. */
export interface SceneGenerationPlan {
  ok: true;
  entry: ModelEntry;
  /** The settings `resolveParams` leaves: what the run sends. */
  params: Record<string, unknown>;
  /** The prompt once cleaned; null on an image run. */
  prompt: string | null;
  /** The param the images go in, single (`image`) or a list (`images`); null on a text run. */
  imageParam: { name: string; list: boolean } | null;
}

/**
 * Check a 3D generation and resolve its settings.
 * @param ask - What the submission or proposal asks for.
 * @returns The resolved run, or the first thing that does not hold.
 */
export function planSceneGeneration(ask: SceneGenerationAsk): SceneGenerationPlan | { ok: false; problem: SceneGenerationProblem } {
  const entry = getModelCatalog().three_d.find((candidate) => candidate.name === ask.model);
  const modes = entry === undefined ? [] : modesOf(entry);
  if (entry === undefined || !modes.includes(ask.mode)) {
    return { ok: false, problem: { kind: "model", model: ask.model, mode: ask.mode } };
  }
  const prompt = entry.takes_prompt ? extractPromptText(ask.prompt ?? "").trim() : null;
  const promptGiven = (ask.prompt ?? "").trim() !== "";
  if ((entry.takes_prompt && prompt === "") || (!entry.takes_prompt && promptGiven)) {
    return { ok: false, problem: { kind: "prompt", model: entry.name, takesPrompt: entry.takes_prompt } };
  }
  const pictures = picturesOf(entry);
  const min = pictures?.min ?? 0;
  const max = pictures?.max ?? 0;
  if (ask.imageCount < min || ask.imageCount > max) {
    return { ok: false, problem: { kind: "image_count", model: entry.name, min, max, actual: ask.imageCount } };
  }
  for (const param of Object.keys(ask.params)) {
    const spec = entry.params[param];
    if (spec === undefined || spec.fill !== "panel") {
      return { ok: false, problem: { kind: "not_a_setting", model: entry.name, param } };
    }
  }
  const [violation] = checkParamCombination(entry, { ...ask.params, ...(ask.prompt ? { prompt: ask.prompt } : {}) });
  if (violation !== undefined) return { ok: false, problem: { kind: "violation", violation } };
  return {
    ok: true,
    entry,
    params: resolveParams(entry, ask.params),
    prompt,
    imageParam: pictures === null ? null : { name: pictures.name, list: pictures.list },
  };
}
