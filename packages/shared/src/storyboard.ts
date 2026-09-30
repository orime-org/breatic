// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a model says about its storyboard, and which storyboard tier a run
 * actually uses (#2218).
 *
 * A node keeps one storyboard per mode, and its tier stays as stored while the
 * reader moves between models of that mode. Only a model declaring the
 * storyboard params can use it, so the tier a run goes by is the stored one on
 * such a model and off on every other. The video panel (what it draws, what
 * its execute gate judges and what it sends) and the attach snapshot read it
 * through {@link effectiveStoryboardKind}.
 */

import type { ParamDescriptor } from "@shared/types/model-catalog.js";

/** The three storyboard tiers: none, the model splits the shots, the reader writes each. */
export type StoryboardKind = "off" | "auto" | "custom";

/** A model's storyboard, as its catalog entry declares it. */
export interface StoryboardSpec {
  /** The list param the shots go out in. */
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
  /** The most shots it takes; undefined when it declares no cap. */
  readonly maxShots: number | undefined;
  /** The most characters one shot's text takes; undefined when uncapped. */
  readonly maxChars: number | undefined;
}

/**
 * The storyboard a model declares: its `fill: storyboard` list param and the
 * `fill: storyboard` param beside it that names the tier.
 * @param params - The model's params.
 * @returns The spec, or undefined for a model with no storyboard.
 */
export function storyboardSpec(
  params: Readonly<Record<string, ParamDescriptor>>,
): StoryboardSpec | undefined {
  const entries = Object.entries(params).filter(([, spec]) => spec.fill === "storyboard");
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
    maxShots: spec.max_items,
    maxChars: spec.fields?.prompt?.max_chars,
  };
}

/**
 * The tier a run goes by: the stored one on a model with a storyboard, off on
 * any other.
 * @param params - The current model's params.
 * @param stored - The tier stored for the current mode, if any.
 * @returns The effective tier.
 */
export function effectiveStoryboardKind(
  params: Readonly<Record<string, ParamDescriptor>>,
  stored: StoryboardKind | undefined,
): StoryboardKind {
  return storyboardSpec(params) === undefined ? "off" : (stored ?? "off");
}

/**
 * The tier values the tier param takes upstream, in the catalog's vocabulary
 * (`config/models/video/models.yaml`).
 */
const TIER_VALUES: Readonly<Record<Exclude<StoryboardKind, "off">, string>> = {
  auto: "intelligence",
  custom: "customize",
};

/** One shot as a run sends it: its words as plain text and its seconds. */
export interface StoryboardShotInput {
  readonly prompt: string;
  readonly duration: number;
}

/**
 * The params a storyboard adds to a run. Off adds none; the automatic tier
 * names itself and leaves the shots to the model; the per-shot tier names
 * itself and sends every shot, whose words stand in for the main prompt.
 * @param spec - The model's storyboard.
 * @param kind - The effective tier.
 * @param shots - The shots, in order, with their words already plain text.
 * @returns The params to merge into the run.
 */
export function storyboardParams(
  spec: StoryboardSpec,
  kind: StoryboardKind,
  shots: readonly StoryboardShotInput[],
): Record<string, unknown> {
  if (kind === "off") return {};
  const tier = spec.tierParam === undefined ? {} : { [spec.tierParam]: TIER_VALUES[kind] };
  if (kind === "auto") return tier;
  const seconds = spec.secondsField;
  return {
    ...tier,
    [spec.shotsParam]: shots.map((shot) =>
      seconds === undefined ? { prompt: shot.prompt } : { prompt: shot.prompt, [seconds]: shot.duration },
    ),
  };
}
