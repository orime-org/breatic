// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Multi-shot, a control inside the video modes (inner#2192): which modes a
 * model can write shots in, which of single shot, multi-shot and auto
 * multi-shot a node is on, and what a run sends for the shots.
 *
 * A node keeps one list of shots across its modes. A model takes shots
 * through a `fill: storyboard` list param declared for the modes it takes them
 * in. Kling has a field for them upstream (`multi_prompt`, beside `shot_type`,
 * which offers the one value a run sends) and a `shots_auto` switch that lets
 * it plan the shots itself; a model with no field declares `into_prompt`, and
 * its shots are written into the prompt instead.
 */

import { appliesInMode } from "@shared/param-modes.js";
import type { ParamDescriptor } from "@shared/types/model-catalog.js";

/** The most shots a run takes, whatever a model allows. */
export const MULTI_SHOT_MAX_SHOTS = 6;

/** A model's storyboard in a mode, as its catalog entry declares it. */
export interface StoryboardSpec {
  /** The list param the shots go out in, or are read from for the prompt. */
  readonly shotsParam: string;
  /**
   * The values a run sends beside the shots, read off the model's other
   * `fill: storyboard` params that offer exactly one (Kling's `shot_type`).
   */
  readonly fixed: Readonly<Record<string, unknown>>;
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
  /**
   * The model's own switch for letting it plan the shots itself (Kling's
   * `auto_shots`, declared `shots_auto`). Undefined for a model without one.
   */
  readonly autoParam: string | undefined;
}

/**
 * The storyboard a model declares for a mode: its `fill: storyboard` list
 * param, the single-valued `fill: storyboard` params beside it and its
 * `shots_auto` switch. It says the model can write shots in this mode; whether
 * a node has them on is `effectiveShots`.
 * @param params - The model's params.
 * @param mode - The mode the panel is in.
 * @returns The spec, or undefined where the model takes no shots in this mode.
 */
export function storyboardSpec(
  params: Readonly<Record<string, ParamDescriptor>>,
  mode: string,
): StoryboardSpec | undefined {
  const entries = Object.entries(params).filter(
    ([, spec]) => spec.fill === "storyboard" && appliesInMode(spec, mode),
  );
  const shots = entries.find(([, spec]) => spec.type === "items");
  if (shots === undefined) return undefined;
  const [shotsParam, spec] = shots;
  const fixed = Object.fromEntries(
    entries.flatMap(([name, other]) =>
      name !== shotsParam && other.values?.length === 1 ? [[name, other.values[0]]] : [],
    ),
  );
  const seconds = Object.keys(spec.fields ?? {}).find((field) => field !== "prompt");
  return {
    shotsParam,
    fixed,
    secondsField: seconds,
    totalParam: seconds !== undefined && seconds in params ? seconds : undefined,
    maxShots: Math.min(spec.max_items ?? MULTI_SHOT_MAX_SHOTS, MULTI_SHOT_MAX_SHOTS),
    maxChars: spec.fields?.prompt?.max_chars,
    intoPrompt: spec.into_prompt,
    autoParam: Object.entries(params).find(([, other]) => other.shots_auto === true && appliesInMode(other, mode))?.[0],
  };
}

/** Which of the Shots control's three choices a node is on. */
export type ShotsChoice = "single" | "multi" | "auto";

/**
 * The Shots choice a node is on in a mode: multi-shot when the node has it on
 * and the model takes shots there; else auto when the model's own `shots_auto`
 * switch is on in its stored params; else single shot.
 * @param spec - The model's storyboard in this mode, undefined where it takes no shots.
 * @param multiShot - The node's `multiShot` field.
 * @param params - The params stored for the model.
 * @returns The choice.
 */
export function effectiveShots(
  spec: StoryboardSpec | undefined,
  multiShot: unknown,
  params: Readonly<Record<string, unknown>>,
): ShotsChoice {
  if (spec === undefined) return "single";
  if (multiShot === true) return "multi";
  if (spec.autoParam !== undefined && params[spec.autoParam] === true) return "auto";
  return "single";
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
        // in the user's words as patterns.
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
 * What a multi-shot run sends: Kling its fixed values and each shot as a field, a
 * model with no field for shots one prompt that writes them all out.
 * @param spec - The model's storyboard.
 * @param shots - The shots, in order, with their words already plain text.
 * @returns The params to merge and the prompt to send in place of the main one.
 */
export function storyboardSend(spec: StoryboardSpec, shots: readonly StoryboardShotInput[]): StoryboardSend {
  if (spec.intoPrompt !== undefined) {
    return { params: {}, prompt: writeShots(spec.intoPrompt, shots) };
  }
  const seconds = spec.secondsField;
  return {
    params: {
      ...spec.fixed,
      [spec.shotsParam]: shots.map((shot) =>
        seconds === undefined ? { prompt: shot.prompt } : { prompt: shot.prompt, [seconds]: shot.duration },
      ),
    },
    prompt: undefined,
  };
}
