// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A param that stands in for another (#2156, design §16.2).
 *
 * Gemini reads its script either in one voice or as a dialogue between named
 * speakers, and ignores the voice once speakers are given. Its yaml says so
 * with `replaces` on `speakers`; the panel offers the two as a switch, and
 * only the side the user is on goes to the upstream.
 *
 * Which side that is lives in the model's own param record under
 * {@link STAND_IN_ON}, so leaving the dialogue keeps the speakers the user
 * wrote (the approved demo: switching back to a single voice keeps them, and
 * they are simply not sent).
 */

import { isStandInOn, standInOf, STAND_IN_ON, type ModelEntry } from '@breatic/shared';

export { isStandInOn, speakersShort, standInOf, STAND_IN_ON, withStandInOn, type StandIn } from '@breatic/shared';

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
