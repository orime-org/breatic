// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  VIDEO_MODE_OPTIONS,
  slotsForMode,
} from '@web/spaces/canvas/generate/video-mode-options';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';

/**
 * #1904 — a mode's source slots live on the mode itself.
 *
 * What a mode sends upstream is a fixed set of fields, and the panel builds
 * the payload from that set rather than collecting whatever is lying around
 * and then guarding it field by field (user 2026-08-10). Keeping the set on
 * the mode option means adding a mode cannot forget to state it.
 */
describe('video mode options (#1904)', () => {
  it('offers the four modes built so far, text-to-video first', () => {
    expect(VIDEO_MODE_OPTIONS.map((o) => o.value)).toEqual([
      't2v',
      'i2v',
      'first_last',
      'animate',
    ]);
  });

  it('gives every option a distinct test id', () => {
    const ids = VIDEO_MODE_OPTIONS.map((o) => o.testId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states the slots each mode collects, in the order they are shown', () => {
    expect(slotsForMode('t2v')).toEqual([]);
    expect(slotsForMode('i2v')).toEqual(['firstFrame']);
    expect(slotsForMode('first_last')).toEqual(['firstFrame', 'endFrame']);
    expect(slotsForMode('animate')).toEqual(['characterImage', 'drivingVideo']);
  });

  it('keeps the character image apart from the first frame (#1918)', () => {
    // Both travel as `image`, but they are different slots on purpose: a pick
    // survives a mode switch, so sharing one would turn the first frame the
    // user chose for image-to-video into the character animation drives.
    expect(VIDEO_SLOTS.characterImage.field).toBe('characterImageUrl');
    expect(VIDEO_SLOTS.firstFrame.field).toBe('firstFrameUrl');
    expect(VIDEO_SLOTS.characterImage.param).toBe('image');
    expect(VIDEO_SLOTS.firstFrame.param).toBe('image');
  });

  it('collects nothing for a mode it does not offer', () => {
    // A node can carry a mode this panel never shows (the field is shared with
    // the image panel). Collecting slots for it would render controls the
    // submit then ignores.
    expect(slotsForMode('t2i')).toEqual([]);
    expect(slotsForMode('talking_head')).toEqual([]);
  });

  it('names a slot registry entry for every slot a mode asks for', () => {
    // The registry holds each slot's node field, param name, pick purpose and
    // copy; a mode naming a slot with no entry would render nothing.
    for (const option of VIDEO_MODE_OPTIONS) {
      for (const slot of option.slots) {
        expect(VIDEO_SLOTS[slot], `${option.value} asks for ${slot}`).toBeTruthy();
      }
    }
  });

  it('keeps the two frames on separate node fields and separate params', () => {
    expect(VIDEO_SLOTS.firstFrame.field).toBe('firstFrameUrl');
    expect(VIDEO_SLOTS.endFrame.field).toBe('endFrameUrl');
    expect(VIDEO_SLOTS.firstFrame.param).toBe('image');
    expect(VIDEO_SLOTS.endFrame.param).toBe('end_image');
  });
});
