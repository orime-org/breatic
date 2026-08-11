// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The predicate every slot pick shares (#1896 slice 2, #1904 slice 3).
 *
 * Three slots now copy an asset URL off a canvas node — the image panel's
 * style slot (#1664) and the video panel's first and end frames — and every
 * one of them asks the same two questions: is this the kind of node I take,
 * and does it actually hold something. Asking them once is what keeps the
 * slots from drifting into different answers for "can I pick this".
 *
 * WHICH kind it takes is the caller's to state, not this predicate's to
 * assume: a video slot reads it off the slot registry, so the registry stays
 * the one place a slot's accepted type is written. Baking `image` in here
 * would make the registry's `accepts` field a decoration the click path never
 * consults, and the two would disagree the day a slot takes audio.
 *
 * It judges the CLICKED NODE's own type. The reference rail is not consulted:
 * the rail only holds nodes already wired to the target, while a slot pick
 * roams the whole canvas, so a rail-based test would reject every candidate.
 */

import { describe, it, expect } from 'vitest';

import { pickedSlotUrl } from '@web/spaces/canvas/generate/slot-pick';

describe('pickedSlotUrl', () => {
  it('takes the URL off a filled node of the accepted type', () => {
    expect(
      pickedSlotUrl(
        { type: 'image', data: { content: 'https://cdn/a.png' } },
        'image',
      ),
    ).toBe('https://cdn/a.png');
  });

  it('takes the accepted type from the caller, not from a baked-in image', () => {
    // The talking-head slice (#1896) brings a slot that takes an audio track.
    // Asserted now because the failure is silent: a click on the right node
    // would do nothing while the candidate highlighting — which already reads
    // the registry — says it is selectable.
    expect(
      pickedSlotUrl(
        { type: 'audio', data: { content: 'https://cdn/v.m4a' } },
        'audio',
      ),
    ).toBe('https://cdn/v.m4a');
    expect(
      pickedSlotUrl(
        { type: 'image', data: { content: 'https://cdn/a.png' } },
        'audio',
      ),
    ).toBeNull();
  });

  it('refuses every modality the slot does not take', () => {
    // Acceptance ③: clicking an audio node during a first-frame pick does
    // nothing. Video and text are refused on the same grounds — the slot
    // means one still image to the model.
    for (const type of ['audio', 'video', 'text', '3d', 'web', 'annotation', 'group']) {
      expect(
        pickedSlotUrl({ type, data: { content: 'https://cdn/a.png' } }, 'image'),
      ).toBeNull();
    }
  });

  it('refuses a node of the right type with nothing in it', () => {
    // An empty image node is a placeholder awaiting an upload or a
    // generation. Copying its (absent) URL would fill the slot with nothing
    // and read as a successful pick.
    expect(pickedSlotUrl({ type: 'image', data: {} }, 'image')).toBeNull();
    expect(
      pickedSlotUrl({ type: 'image', data: { content: '' } }, 'image'),
    ).toBeNull();
  });

  it('refuses content that is not a string', () => {
    // Node data is a CRDT map any client may write; a non-string here means
    // the document is malformed, and coercing it would put "[object Object]"
    // in the slot and on the wire.
    expect(
      pickedSlotUrl({ type: 'image', data: { content: 42 } }, 'image'),
    ).toBeNull();
    expect(
      pickedSlotUrl({ type: 'image', data: { content: { url: 'x' } } }, 'image'),
    ).toBeNull();
  });

  it('refuses a node with no data at all', () => {
    expect(pickedSlotUrl({ type: 'image' }, 'image')).toBeNull();
    expect(pickedSlotUrl({ type: undefined }, 'image')).toBeNull();
  });
});
