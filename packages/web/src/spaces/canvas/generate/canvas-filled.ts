// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a param is filled off the canvas, for whichever panel is asking (#269).
 *
 * Both source registries ask it, and they were asking it twice: the video one
 * read `optional` and the audio one did not return it at all, so a model
 * saying a place may be left empty was obeyed under one modality and refused
 * under the other.
 */

import type { ParamDescriptor } from '@breatic/shared';

/** What a param filled off the canvas says about itself here. */
export interface CanvasFill {
  /** Which gesture puts material there: a slot pick, or the reference pool. */
  fill: 'canvas' | 'pool';
  /** Whether a run may go without it. */
  optional: boolean;
}

/**
 * How this mode fills a param off the canvas.
 * @param spec - What the model declares about the param.
 * @param mode - The mode being asked about.
 * @returns How the param is filled here, or undefined when nothing fills it.
 */
export function filledFromCanvas(
  spec: ParamDescriptor | undefined,
  mode: string,
): CanvasFill | undefined {
  if (spec?.fill !== 'canvas' && spec?.fill !== 'pool') return undefined;
  // `modes` narrows a param to some of the model's modes; absent means all.
  if (spec.modes !== undefined && !spec.modes.includes(mode)) return undefined;
  return { fill: spec.fill, optional: spec.optional === true };
}
