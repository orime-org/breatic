// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A param that stands in for another (#2156, design §16.2).
 *
 * Gemini reads its script either in one voice or as a dialogue between named
 * speakers, and ignores the voice once speakers are given. Its yaml says so
 * with `replaces` on `speakers`; the panel offers the two as a switch, and
 * only the side the reader is on goes to the upstream.
 *
 * Which side that is lives in the model's own param record under
 * {@link STAND_IN_ON}, so leaving the dialogue keeps the speakers the reader
 * wrote (the approved demo: switching back to a single voice keeps them, and
 * they are simply not sent).
 */

import { completeEntries, type ModelEntry } from '@breatic/shared';

/**
 * The record key holding whether the stand-in is the side in use.
 *
 * Not a catalog param: {@link wireParams} takes it off before anything leaves
 * the browser, and the reconciler keeps it only on a model that has a stand-in.
 */
export const STAND_IN_ON = '_stand_in_on';

/** The stand-in a model declares. */
export interface StandIn {
  /** The param that stands in, e.g. `speakers`. */
  readonly name: string;
  /** The param it replaces, e.g. `voice_id`. */
  readonly replaces: string;
  /** The fewest complete entries a run takes. */
  readonly min: number;
}

/**
 * The stand-in this model declares, if any.
 * @param model - The active model, or undefined before one resolves.
 * @returns The stand-in, or null when the model declares none.
 */
export function standInOf(model: ModelEntry | undefined): StandIn | null {
  if (!model) return null;
  for (const [name, spec] of Object.entries(model.params)) {
    if (typeof spec.replaces === 'string' && spec.replaces in model.params) {
      return { name, replaces: spec.replaces, min: spec.min_items ?? 1 };
    }
  }
  return null;
}

/**
 * Whether the record has the stand-in side switched on.
 * @param params - The model's param record.
 * @returns True only for an explicit true.
 */
export function isStandInOn(params: Readonly<Record<string, unknown>>): boolean {
  return params[STAND_IN_ON] === true;
}

/**
 * The params that leave the browser: the side not in use is dropped, and the
 * switch itself never goes.
 * @param model - The model the params belong to.
 * @param params - Its param record.
 * @returns The record as the run and the estimate read it.
 */
export function wireParams(
  model: ModelEntry,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { [STAND_IN_ON]: _switch, ...rest } = params;
  const standIn = standInOf(model);
  if (!standIn) return rest;
  const { [isStandInOn(params) ? standIn.replaces : standIn.name]: _dropped, ...sent } = rest;
  return sent;
}

/**
 * Whether a dialogue holds fewer complete entries than the model takes.
 * @param model - The active model.
 * @param params - Its param record.
 * @returns True only on the stand-in side and below its floor.
 */
export function speakersShort(
  model: ModelEntry | undefined,
  params: Readonly<Record<string, unknown>>,
): boolean {
  const standIn = standInOf(model);
  if (!model || !standIn || !isStandInOn(params)) return false;
  const fields = model.params[standIn.name]?.fields ?? {};
  return completeEntries(params[standIn.name], fields).length < standIn.min;
}
