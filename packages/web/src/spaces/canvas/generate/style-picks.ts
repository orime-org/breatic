// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the style slot contributes to a run, for whichever panel builds it
 * (inner#826, inner#828).
 */

import type { ModelEntry } from '@breatic/shared';

import { readSlotPicks } from '@web/spaces/canvas/generate/slots';
import { STYLE_SLOT, styleCapFor } from '@web/spaces/canvas/generate/style-slot';

/** The style slot's part of a view model. */
export interface StyleRun {
  /** How many style images the model takes here, or undefined for none. */
  styleCap: number | undefined;
  /** Every style image the node holds, in pick order; at most `styleCap` are sent. */
  styleImages: readonly string[];
  /** The params with the sent style images under `style_images`, when there are any. */
  params: Record<string, unknown>;
}

/**
 * Adds a node's style images to a run's params.
 * @param model - The model the run names, or undefined before one resolves.
 * @param mode - The mode it is set to.
 * @param stored - The node's `styleImageUrls`; collaborative data, untrusted.
 * @param params - The run's params so far.
 * @returns The cap, the held images and the params to send.
 */
export function withStyleImages(
  model: ModelEntry | undefined,
  mode: string,
  stored: unknown,
  params: Record<string, unknown>,
): StyleRun {
  const styleCap = styleCapFor(model, mode);
  const styleImages = readSlotPicks(STYLE_SLOT, stored).map((p) => p.url);
  const sent = styleCap === undefined ? [] : styleImages.slice(0, styleCap);
  return {
    styleCap,
    styleImages,
    params: sent.length > 0 ? { ...params, [STYLE_SLOT.param]: sent } : params,
  };
}
