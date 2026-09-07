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

import {
  positiveCap,
  referenceCapExceeded,
} from '@web/spaces/canvas/generate/reference-cap';
import { sourceParams } from '@web/spaces/canvas/generate/video-task-payload';
import type {
  VideoSlot,
  VideoSlotUrls,
} from '@web/spaces/canvas/generate/video-slots';

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

/**
 * Any URL: only its presence is read, so what it points at never matters.
 * Named rather than inlined so the hypothetical below reads as one.
 */
const ANY_URL = 'about:blank';

/**
 * Whether filling a slot would leave the node over the reference-image cap.
 *
 * Asked when the user reaches for the slot, not when they submit: a model may
 * take fewer reference images once another param carries a value, so a pick
 * that was fine to make can be the thing that puts an untouched set of images
 * over the line. Refusing at that moment keeps the images — the alternative,
 * dropping some to fit, throws away work the user did not offer up.
 *
 * Slot-agnostic on purpose. It asks what the cap WOULD be with this slot
 * filled, so any future slot a catalog names in `max_items_when_present` is
 * covered without being listed here.
 * @param model - The catalog entry the node has selected, or undefined while the catalog has not answered.
 * @param mode - The node's active generation mode.
 * @param slotUrls - What its slots hold right now, before this pick.
 * @param slot - The slot the user is reaching for.
 * @param pickedCount - How many reference images the node already carries.
 * @returns The cap it would fall to, or null when the pick is fine to start.
 */
export function slotFillLowersCapBelowPicks(
  model: ModelEntry | undefined,
  mode: string,
  slotUrls: VideoSlotUrls,
  slot: VideoSlot,
  pickedCount: number,
): { limit: number } | null {
  // A slot already holding something moved whatever cap it moves when it was
  // first filled; swapping its contents changes no number.
  if (slotUrls[slot]) return null;
  return referenceCapExceeded(
    pickedCount,
    modelReferenceCap(model, mode, { ...slotUrls, [slot]: ANY_URL }),
  );
}
