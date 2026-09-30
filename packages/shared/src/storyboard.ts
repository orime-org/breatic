// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a model says about its storyboard, and which storyboard tier a run
 * actually uses (#2218).
 *
 * A node keeps one storyboard per mode, and its tier stays as stored while the
 * reader moves between models of that mode. Only a model declaring the
 * storyboard params can use it, so the tier a run goes by is the stored one on
 * such a model and off on every other. The gate, the payload, the attach
 * snapshot and the agent's checks all read it through
 * {@link effectiveStoryboardKind}.
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
