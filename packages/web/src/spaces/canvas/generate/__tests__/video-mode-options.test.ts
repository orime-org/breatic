// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  VIDEO_MODE_OPTIONS,
  slotsForMode,
  modeTakesReferences,
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
  it('offers the six modes built so far, text-to-video first', () => {
    expect(VIDEO_MODE_OPTIONS.map((o) => o.value)).toEqual([
      't2v',
      'i2v',
      'first_last',
      'animate',
      'ref',
      'talking_head',
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
    expect(slotsForMode('talking_head')).toEqual([
      'characterImage',
      'drivingAudio',
    ]);
  });

  it('reuses the character image for the talking head (#1935)', () => {
    // The registry's own list of roles anticipated exactly this slot before it
    // existed ("and later a driving audio track", since rewritten to name the
    // slot outright), and a slot shared across modes is how the first frame
    // already works (image-to-video and first-last). Both modes want the same
    // thing of it: a picture of a person.
    expect(slotsForMode('talking_head')[0]).toBe('characterImage');
    expect(slotsForMode('animate')[0]).toBe('characterImage');
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

/**
 * #1927 — reference-to-video collects its sources from the reference rail,
 * not from slots, so the mode has to say so on the option itself.
 *
 * Every mode before it took its sources through slots, and the four
 * consumers — the toolbar, the payload, the execute gate and the rail's
 * dimming — all read `slots`. This one collects nothing that way: its
 * sources are the images the prompt `@`-mentions. Stating that appetite on
 * the option keeps it in the same one list, so adding a mode still cannot
 * forget to say what it takes.
 */
describe('reference-to-video (#1927)', () => {
  it('collects no slots — its sources come from the rail', () => {
    expect(slotsForMode('ref')).toEqual([]);
  });

  it('is the only mode that takes @-mentioned reference images', () => {
    // The four before it collect through slots. Letting one of them take
    // rail references too would put a second, unasked-for source on the
    // payload of three modes that have already shipped.
    expect(modeTakesReferences('ref')).toBe(true);
    expect(modeTakesReferences('t2v')).toBe(false);
    expect(modeTakesReferences('i2v')).toBe(false);
    expect(modeTakesReferences('first_last')).toBe(false);
    expect(modeTakesReferences('animate')).toBe(false);
    expect(modeTakesReferences('talking_head')).toBe(false);
  });

  it('takes no references for a mode this panel does not offer', () => {
    // Same reason `slotsForMode` answers empty: the node's `mode` field is
    // shared with the image panel and can hold a value this panel never shows.
    expect(modeTakesReferences('t2i')).toBe(false);
  });

  it('states the appetite on every option, so adding a mode cannot forget', () => {
    for (const option of VIDEO_MODE_OPTIONS) {
      expect(typeof option.takesReferences, option.value).toBe('boolean');
    }
  });
});
