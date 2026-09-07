// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many reference images the model in front of the user takes right now
 * (#1928) — the one number both readers of that question ask for.
 *
 * The panel refuses a submit carrying more; the canvas refuses to ADD one
 * past it, on a connection, a pick click or a focus crop. The canvas used to
 * ask a narrower question — its own site-wide sanity knob, which knows nothing
 * about models — so a cap that moves with another param would have let a
 * fifth image be connected and only said so at submit.
 *
 * The presence conditions come from the params this mode would actually send,
 * not from the raw slot values: a slot's pick stays on the node across a mode
 * switch by design, and a clip the vendor never receives lowers nothing.
 */

import type { ModelEntry } from '@breatic/shared';
import { effectiveItemCap } from '@breatic/shared';

import { positiveCap } from '@web/spaces/canvas/generate/reference-cap';
import { sourceParams } from '@web/spaces/canvas/generate/video-task-payload';
import type { VideoSlotUrls } from '@web/spaces/canvas/generate/video-slots';

/** The param a reference-image list travels under, in every catalog. */
const IMAGES_PARAM = 'images';

/**
 * The reference-image cap in force for one node's current model and picks.
 * @param model - The catalog entry the node has selected, or undefined while the catalog has not answered.
 * @param mode - The node's active generation mode.
 * @param slotUrls - What its slots currently hold.
 * @returns The cap, or undefined when the model is unknown or states none.
 */
export function modelReferenceCap(
  model: ModelEntry | undefined,
  mode: string,
  slotUrls: VideoSlotUrls,
): number | undefined {
  const descriptor = model?.params[IMAGES_PARAM];
  if (!descriptor) return undefined;
  return positiveCap(
    effectiveItemCap(descriptor, sourceParams(mode, slotUrls, [])),
  );
}
