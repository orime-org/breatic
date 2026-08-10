// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The predicate every image slot pick shares (#1896 slice 2).
 *
 * Two slots now copy an image URL off a canvas node — the image panel's style
 * slot (#1664) and the video panel's first frame — and both accept exactly the
 * same thing. Asking the question once is what keeps them from drifting into
 * two different answers for "can I pick this".
 *
 * It judges the CLICKED NODE's own type. The reference rail is not consulted:
 * the rail only holds nodes already wired to the target, while a slot pick
 * roams the whole canvas, so a rail-based test would reject every candidate.
 */

import { describe, it, expect } from 'vitest';

import { pickedSlotImageUrl } from '@web/spaces/canvas/generate/slot-pick';

describe('pickedSlotImageUrl', () => {
  it('takes the URL off a filled image node', () => {
    expect(
      pickedSlotImageUrl({ type: 'image', data: { content: 'https://cdn/a.png' } }),
    ).toBe('https://cdn/a.png');
  });

  it('refuses every non-image modality', () => {
    // Acceptance ③: clicking an audio node during a first-frame pick does
    // nothing. Video and text are refused on the same grounds — the slot
    // means one still image to the model.
    for (const type of ['audio', 'video', 'text', '3d', 'web', 'annotation', 'group']) {
      expect(
        pickedSlotImageUrl({ type, data: { content: 'https://cdn/a.png' } }),
      ).toBeNull();
    }
  });

  it('refuses an image node with nothing in it', () => {
    // An empty image node is a placeholder awaiting an upload or a
    // generation. Copying its (absent) URL would fill the slot with nothing
    // and read as a successful pick.
    expect(pickedSlotImageUrl({ type: 'image', data: {} })).toBeNull();
    expect(pickedSlotImageUrl({ type: 'image', data: { content: '' } })).toBeNull();
  });

  it('refuses content that is not a string', () => {
    // Node data is a CRDT map any client may write; a non-string here means
    // the document is malformed, and coercing it would put "[object Object]"
    // in the slot and on the wire.
    expect(
      pickedSlotImageUrl({ type: 'image', data: { content: 42 } }),
    ).toBeNull();
    expect(
      pickedSlotImageUrl({ type: 'image', data: { content: { url: 'x' } } }),
    ).toBeNull();
  });

  it('refuses a node with no data at all', () => {
    expect(pickedSlotImageUrl({ type: 'image' })).toBeNull();
    expect(pickedSlotImageUrl({ type: undefined })).toBeNull();
  });
});
