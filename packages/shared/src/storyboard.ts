// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The multi-shot mode's storyboard: what a model says about its
 * shots in that mode, and what a run sends for them.
 *
 * A node keeps one list of shots, and only the multi-shot mode uses it. A
 * model takes shots through a `fill: storyboard` list param declared for that
 * mode. Kling has a field for them upstream (`multi_prompt`, beside its tier
 * param `shot_type`); a model with no such field declares `into_prompt`, and
 * its shots are written into the prompt instead.
 */

import { appliesInMode } from "@shared/param-modes.js";
import type { ParamDescriptor } from "@shared/types/model-catalog.js";

/** The mode a node's shots belong to. */
export const MULTI_SHOT_MODE = "multi_shot";

/** The most shots the multi-shot mode takes, whatever a model allows. */
export const MULTI_SHOT_MAX_SHOTS = 6;

/** The tier Kling's shots go out under when each one is written by hand. */
const CUSTOM_TIER = "customize";

/** A model's storyboard in the multi-shot mode, as its catalog entry declares it. */
export interface StoryboardSpec {
  /** The list param the shots go out in, or are read from for the prompt. */
  readonly shotsParam: string;
  /** The param naming the tier upstream, when the model has one. */
  readonly tierParam: string | undefined;
  /** The field of a shot that carries its seconds, when a shot has one. */
  readonly secondsField: string | undefined;
  /**
   * The model's own param that each shot's seconds have to add up to: the
   * one named like the seconds field of a shot. Undefined when it has none.
   */
  readonly totalParam: string | undefined;
  /** The most shots it takes: its own limit, never above the mode's. */
  readonly maxShots: number;
  /** The most characters one shot's text takes; undefined when uncapped. */
  readonly maxChars: number | undefined;
  /** The template a shot is written into the prompt with, for a model with no field for shots. */
  readonly intoPrompt: string | undefined;
}

/**
 * The storyboard a model declares for a mode: its `fill: storyboard` list
 * param and the `fill: storyboard` param beside it that names the tier. Only
 * the multi-shot mode has one.
 * @param params - The model's params.
 * @param mode - The mode the panel is in.
 * @returns The spec, or undefined outside the multi-shot mode or for a model with no shots.
 */
export function storyboardSpec(
  params: Readonly<Record<string, ParamDescriptor>>,
  mode: string,
): StoryboardSpec | undefined {
  if (mode !== MULTI_SHOT_MODE) return undefined;
  const entries = Object.entries(params).filter(
    ([, spec]) => spec.fill === "storyboard" && appliesInMode(spec, mode),
  );
  const shots = entries.find(([, spec]) => spec.type === "items");
  if (shots === undefined) return undefined;
  const tier = entries.find(([name]) => name !== shots[0]);
  const [shotsParam, spec] = shots;
  const seconds = Object.keys(spec.fields ?? {}).find((field) => field !== "prompt");
  return {
    shotsParam,
    tierParam: tier?.[0],
    secondsField: seconds,
    totalParam: seconds !== undefined && seconds in params ? seconds : undefined,
    maxShots: Math.min(spec.max_items ?? MULTI_SHOT_MAX_SHOTS, MULTI_SHOT_MAX_SHOTS),
    maxChars: spec.fields?.prompt?.max_chars,
    intoPrompt: spec.into_prompt,
  };
}

/** One shot as a run sends it: its words as plain text and its seconds. */
export interface StoryboardShotInput {
  readonly prompt: string;
  readonly duration: number;
}

/** What a multi-shot run sends for its shots. */
export interface StoryboardSend {
  /** The params to merge into the run. */
  readonly params: Record<string, unknown>;
  /**
   * The prompt the run sends in place of the main prompt: the shots written
   * out for a model with no field for them, undefined for one that has one.
   */
  readonly prompt: string | undefined;
}

/**
 * Writes the shots into one prompt, each on its own line, with its place and
 * its running seconds.
 * @param template - The model's `into_prompt` template.
 * @param shots - The shots, in order.
 * @returns The prompt.
 */
function writeShots(template: string, shots: readonly StoryboardShotInput[]): string {
  let start = 0;
  return shots
    .map((shot, index) => {
      const end = start + shot.duration;
      const line = template
        // Function replacements: a string one reads `$&`, `$$` and the like
        // in the reader's words as patterns.
        .replaceAll("{n}", () => String(index + 1))
        .replaceAll("{start}", () => String(start))
        .replaceAll("{end}", () => String(end))
        .replaceAll("{prompt}", () => shot.prompt);
      start = end;
      return line;
    })
    .join("\n");
}

/**
 * What a multi-shot run sends: Kling its tier and each shot as a field, a
 * model with no field for shots one prompt that writes them all out.
 * @param spec - The model's storyboard.
 * @param shots - The shots, in order, with their words already plain text.
 * @returns The params to merge and the prompt to send in place of the main one.
 */
export function storyboardSend(spec: StoryboardSpec, shots: readonly StoryboardShotInput[]): StoryboardSend {
  if (spec.intoPrompt !== undefined) {
    return { params: {}, prompt: writeShots(spec.intoPrompt, shots) };
  }
  const tier = spec.tierParam === undefined ? {} : { [spec.tierParam]: CUSTOM_TIER };
  const seconds = spec.secondsField;
  return {
    params: {
      ...tier,
      [spec.shotsParam]: shots.map((shot) =>
        seconds === undefined ? { prompt: shot.prompt } : { prompt: shot.prompt, [seconds]: shot.duration },
      ),
    },
    prompt: undefined,
  };
}
