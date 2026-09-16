// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many pieces of material a mode asks for, derived from the panels (#229).
 *
 * `MODE_MATERIAL_COUNT` lives in shared so an answer about a mode can be given
 * without a panel around -- the check that decides whether a proposed group
 * can be generated runs on the backend and has no panel to ask. That makes it
 * a second copy of something the panels already decide, and this file is what
 * keeps the two from drifting: every number is recomputed here from the
 * panels' own definitions, and a slot added or marked optional fails this
 * rather than reaching a reader as a group they cannot generate.
 *
 * The three panels count differently, which is why the table cannot be one
 * rule applied to one list of slots:
 *
 * video     refuses on EVERY empty slot that is not marked optional
 * audio     takes ANY ONE of the slots it offers
 * the pool  takes at least one reference, whatever else the mode offers
 */

import { describe, it, expect } from 'vitest';
import { MODE_MATERIAL_COUNT, MODE_SOURCE_FIELDS, REFERENCE_POOL_PARAM } from '@breatic/shared';

import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { VIDEO_MODE_OPTIONS } from '@web/spaces/canvas/generate/video-mode-options';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';

/**
 * Whether this mode's material arrives through the reference pool.
 * @param nodeType - The node the mode belongs to.
 * @param mode - The mode being asked about.
 * @returns True when an edge feeds it rather than a slot.
 * @throws {never} Never.
 */
function pooled(nodeType: 'image' | 'video' | 'audio', mode: string): boolean {
  return (MODE_SOURCE_FIELDS[nodeType]?.[mode] ?? []).includes(REFERENCE_POOL_PARAM);
}

describe('what the shared table says a mode asks for', () => {
  it('matches what the video panel will refuse to generate without', () => {
    // VideoGeneratePanelContainer finds the first slot that is not optional
    // and has nothing in it, and refuses by that slot's own name. A mode fed
    // by the pool refuses separately, on an empty pool, which is one piece.
    const derived = Object.fromEntries(
      VIDEO_MODE_OPTIONS.map((option) => [
        option.value,
        option.slots.filter((slot) => !('optional' in VIDEO_SLOTS[slot])).length +
          (pooled('video', option.value) ? 1 : 0),
      ]),
    );

    expect(derived).toEqual(MODE_MATERIAL_COUNT.video);
  });

  it('matches what the audio panel will refuse to generate without', () => {
    // `evaluateExecute` asks `required.some((slot) => filled.includes(slot))`,
    // so a mode offering three slots is satisfied by one of them.
    const derived = Object.fromEntries(
      AUDIO_MODE_OPTIONS.map((option) => [option.value, option.slots.length > 0 ? 1 : 0]),
    );

    expect(derived).toEqual(MODE_MATERIAL_COUNT.audio);
  });

  it('matches what the image panel will refuse to generate without', () => {
    // The image panel has no slots of its own: image-to-image takes its
    // material through the pool, and text-to-image asks for nothing. The
    // style reference both offer is optional (#266).
    const derived = Object.fromEntries(
      Object.keys(MODE_SOURCE_FIELDS.image).map((mode) => [
        mode,
        pooled('image', mode) ? 1 : 0,
      ]),
    );

    expect(derived).toEqual(MODE_MATERIAL_COUNT.image);
  });

  it('answers for every mode the panels offer', () => {
    // A mode added to a panel and left out of the table would be answered
    // with nothing, and the check would let any number of empty nodes past.
    const offered = {
      video: VIDEO_MODE_OPTIONS.map((o) => o.value).sort(),
      audio: AUDIO_MODE_OPTIONS.map((o) => o.value).sort(),
      image: Object.keys(MODE_SOURCE_FIELDS.image).sort(),
    };
    const answered = {
      video: Object.keys(MODE_MATERIAL_COUNT.video).sort(),
      audio: Object.keys(MODE_MATERIAL_COUNT.audio).sort(),
      image: Object.keys(MODE_MATERIAL_COUNT.image).sort(),
    };

    expect(answered).toEqual(offered);
  });
});
