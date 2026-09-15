// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel's own tables against the ones the agent's answer reads (#261).
 *
 * Which parameters a mode fills by pointing at a node, and which of the rest
 * the panel draws a control for, are stated once in `@breatic/shared` so that
 * the panel and the answer offer a reader the same thing. These derive the
 * same facts from the panel's own definitions: a slot moved to another mode
 * or a control added shows up here until the shared table follows.
 */

import { describe, it, expect } from 'vitest';
import { MODE_SOURCE_FIELDS, PANEL_PARAM_CONTROLS } from '@breatic/shared';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { PARAMS as AUDIO_PARAMS } from '@web/spaces/canvas/generate/audio-params';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { VIDEO_MODE_OPTIONS } from '@web/spaces/canvas/generate/video-mode-options';

/** The reference list is one relationship, named the same on every mode. */
const REFERENCE_PARAM = 'images';

describe('what a mode fills from the canvas', () => {
  it('matches the video panel, slot for slot', () => {
    for (const option of VIDEO_MODE_OPTIONS) {
      const fromPanel = [
        ...option.slots.map((slot) => VIDEO_SLOTS[slot].param),
        ...(option.takesReferences ? [REFERENCE_PARAM] : []),
      ].sort();
      expect(
        [...(MODE_SOURCE_FIELDS.video[option.value] ?? [])].sort(),
        `video ${option.value}`,
      ).toEqual(fromPanel);
    }
  });

  it('matches the audio panel, slot for slot', () => {
    for (const option of AUDIO_MODE_OPTIONS) {
      const fromPanel = option.slots.map((slot) => AUDIO_SLOTS[slot].param).sort();
      expect(
        [...(MODE_SOURCE_FIELDS.audio[option.value] ?? [])].sort(),
        `audio ${option.value}`,
      ).toEqual(fromPanel);
    }
  });

  it('names a mode for every mode each panel offers', () => {
    expect(Object.keys(MODE_SOURCE_FIELDS.video).sort()).toEqual(
      VIDEO_MODE_OPTIONS.map((o) => o.value).sort(),
    );
    expect(Object.keys(MODE_SOURCE_FIELDS.audio).sort()).toEqual(
      AUDIO_MODE_OPTIONS.map((o) => o.value).sort(),
    );
  });
});

describe('what a panel draws a control for', () => {
  it('matches the audio panel, control for control', () => {
    expect([...PANEL_PARAM_CONTROLS.audio].sort()).toEqual(
      [...Object.keys(AUDIO_PARAMS), 'voice_id', 'reference_id'].sort(),
    );
  });
});
