// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many reference images the model in front of the user takes right now
 * (#1928).
 *
 * Two readers ask it, both in the video Generate panel: the submit gate
 * refuses a submission carrying more, and the slot row refuses a clip pick
 * that would drop the cap below what is already picked. Adding a reference
 * image on the canvas asks a different question and gets a different answer —
 * the site-wide pool cap, which knows nothing about models (#2112).
 */

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import {
  modelReferenceCap,
  slotFillLowersCapBelowPicks,
} from '@web/spaces/canvas/generate/model-reference-cap';

/** A catalog entry declaring `images` the way `kling-o3-pro-ref` does. */
function refModel(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'kling-o3-pro-ref',
    display_name: 'Kling O3 Pro Ref',
    modality: 'video',
    mode: 'ref',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 56,
    generation_time: 120,
    takes_prompt: true,
    providers: [],
    params: {
      images: {
        description: 'Reference image URLs',
        type: 'list',
        max_items: 7,
        max_items_when_present: { video: 4 },
        default: null,
      },
      video: { description: 'Reference video URL', default: null },
    },
    ...over,
  } as ModelEntry;
}

describe('the reference-image cap the model is holding right now', () => {
  it('is the plain cap while the reference-video slot is empty', () => {
    expect(modelReferenceCap(refModel(), 'ref', {})).toBe(7);
  });

  it('drops once that slot is filled', () => {
    expect(
      modelReferenceCap(refModel(), 'ref', {
        referenceVideo: 'https://cdn/clip.mp4',
      }),
    ).toBe(4);
  });

  it('reads the slot through the mode, so a stale pick from another mode is ignored', () => {
    // A slot's value stays on the node across a mode switch by design. Under a
    // mode that does not collect it, the vendor never sees the clip, so the
    // cap it would have lowered does not apply either.
    expect(
      modelReferenceCap(refModel(), 't2v', {
        referenceVideo: 'https://cdn/clip.mp4',
      }),
    ).toBe(7);
  });

  it('is undefined when the model declares no image list', () => {
    const noImages = refModel({ params: { seed: { description: '', default: -1 } } });
    expect(modelReferenceCap(noImages, 'ref', {})).toBeUndefined();
  });

  it('is undefined when the catalog has not answered yet', () => {
    // The panel renders before the catalog query resolves, so this is the
    // ordinary case on a fresh space, not an edge: the callers fall back to
    // no cap rather than inventing a number.
    expect(modelReferenceCap(undefined, 'ref', {})).toBeUndefined();
  });

  it('treats a zero or absent max_items as uncapped', () => {
    const uncapped = refModel({
      params: { images: { description: '', type: 'list', default: null } },
    });
    expect(modelReferenceCap(uncapped, 'ref', {})).toBeUndefined();
  });
});

/**
 * Filling a slot can lower the cap under what is already picked (#1928, A6).
 *
 * `kling-o3-pro-ref` takes 7 reference images alone and 4 alongside a clip, so
 * picking the clip with 5 already chosen would put the node over a cap it was
 * within a moment ago. The pick is what gets refused: the images stay, and the
 * user is told which number to get down to.
 */
describe('whether filling a slot would drop the cap below what is picked', () => {
  const CLIP = 'https://cdn/clip.mp4';

  it('refuses the pick, naming the cap it would fall to', () => {
    expect(
      slotFillLowersCapBelowPicks(refModel(), 'ref', {}, 'referenceVideo', 5),
    ).toEqual({ limit: 4 });
  });

  it('allows it once the picked images are down to the new cap', () => {
    expect(
      slotFillLowersCapBelowPicks(refModel(), 'ref', {}, 'referenceVideo', 4),
    ).toBeNull();
  });

  it('allows a slot that moves no cap', () => {
    // Four of the five existing slots appear in no `max_items_when_present`,
    // so this must be a no-op for them however many images are picked.
    expect(
      slotFillLowersCapBelowPicks(refModel(), 'ref', {}, 'firstFrame', 7),
    ).toBeNull();
  });

  it('allows a re-pick of a slot already filled', () => {
    // The cap already dropped when it was first filled; swapping the clip
    // makes nothing worse, so refusing here would only trap a user who got
    // over the cap some other way (a collaborator's edit) with no way to swap.
    expect(
      slotFillLowersCapBelowPicks(
        refModel(),
        'ref',
        { referenceVideo: CLIP },
        'referenceVideo',
        5,
      ),
    ).toBeNull();
  });

  it('allows it under a mode that never sends the slot', () => {
    expect(
      slotFillLowersCapBelowPicks(refModel(), 't2v', {}, 'referenceVideo', 7),
    ).toBeNull();
  });

  it('allows it while the catalog has not answered', () => {
    expect(
      slotFillLowersCapBelowPicks(undefined, 'ref', {}, 'referenceVideo', 7),
    ).toBeNull();
  });
});
