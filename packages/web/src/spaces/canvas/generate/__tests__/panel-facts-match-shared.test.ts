// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel's own tables against the ones the agent's answer reads (#261).
 *
 * Which parameters a mode fills by pointing at a node, and which of the rest
 * the panel draws a control for, are stated once in `@breatic/shared` so that
 * the panel and the answer offer a reader the same thing. These derive the
 * same facts from the panel's own definitions.
 *
 * Every row of all three shared tables is pinned here, and every pin but one
 * derives its panel side from the panel's own definitions. The exception is
 * named where it sits: the image mode options carry no slot registry to read,
 * so that one row is written out and only the mode keys come from the panel.
 *
 * Rows went unpinned twice, and both times the unpinned row was wrong: the
 * video row lost the two audio switches, the audio row lost the lyrics box,
 * and the keep-original-sound switch was reported as unconditional while the
 * panel mounts it on a slot. A row without a case below is a row nothing
 * holds.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTROL_NEEDS_SOURCE,
  MODE_SOURCE_FIELDS,
  PANEL_PARAM_CONTROLS,
} from '@breatic/shared';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { PARAMS as AUDIO_PARAMS } from '@web/spaces/canvas/generate/audio-params';
import { CAMERA_PARAMS } from '@web/spaces/canvas/generate/CameraPicker';
import { IMAGE_MODE_OPTIONS } from '@web/spaces/canvas/generate/image-mode-selection';
import { RATIO_RESOLUTION_PARAMS } from '@web/spaces/canvas/generate/RatioResolutionPicker';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { VIDEO_MODE_OPTIONS } from '@web/spaces/canvas/generate/video-mode-options';
import {
  EDITED_PARAMS,
  SLOT_GATED_PARAMS,
} from '@web/spaces/canvas/generate/VideoParamsPicker';

/** The reference list is one relationship, named the same on every mode. */
const REFERENCE_PARAM = 'images';

/** The style slot renders in both image modes, from the Generate toolbar. */
const STYLE_SLOT_PARAM = 'style_images';


describe('what a mode fills from the canvas', () => {
  it('matches the image panel', () => {
    for (const option of IMAGE_MODE_OPTIONS) {
      const fromPanel = [
        ...(option.value === 'i2i' ? [REFERENCE_PARAM] : []),
        STYLE_SLOT_PARAM,
      ].sort();
      expect(
        [...(MODE_SOURCE_FIELDS.image[option.value] ?? [])].sort(),
        `image ${option.value}`,
      ).toEqual(fromPanel);
    }
  });

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

  it('names a mode for every mode each panel offers, and no others', () => {
    expect(Object.keys(MODE_SOURCE_FIELDS.image).sort()).toEqual(
      IMAGE_MODE_OPTIONS.map((o) => o.value).sort(),
    );
    expect(Object.keys(MODE_SOURCE_FIELDS.video).sort()).toEqual(
      VIDEO_MODE_OPTIONS.map((o) => o.value).sort(),
    );
    expect(Object.keys(MODE_SOURCE_FIELDS.audio).sort()).toEqual(
      AUDIO_MODE_OPTIONS.map((o) => o.value).sort(),
    );
  });
});

describe('what a panel draws a control for', () => {
  it('matches the image panel, control for control', () => {
    expect([...PANEL_PARAM_CONTROLS.image].sort()).toEqual(
      [...RATIO_RESOLUTION_PARAMS, ...CAMERA_PARAMS].sort(),
    );
  });

  it('matches the video panel, control for control', () => {
    expect([...PANEL_PARAM_CONTROLS.video].sort()).toEqual([...EDITED_PARAMS].sort());
  });

  it('matches the audio panel, control for control', () => {
    // The voice choice is absent from the shared row on purpose: the picker
    // finds it by its `remote_source` marker, so the answer reads the marker
    // too and there is no name for either side to hold.
    const lyrics = AUDIO_MODE_OPTIONS.some((option) => option.lyrics) ? ['lyrics'] : [];
    expect([...PANEL_PARAM_CONTROLS.audio].sort()).toEqual(
      [...Object.keys(AUDIO_PARAMS), ...lyrics].sort(),
    );
  });
});

describe('what a panel mounts on a slot', () => {
  it('matches the video panel, condition for condition', () => {
    expect(CONTROL_NEEDS_SOURCE.video).toEqual(
      Object.fromEntries(
        Object.entries(SLOT_GATED_PARAMS).map(([param, slot]) => [
          param,
          VIDEO_SLOTS[slot].param,
        ]),
      ),
    );
  });

  it('leaves the image and audio panels unconditional', () => {
    // Neither picker takes the node's slots at all, so no control it draws can
    // wait on one. Asserted rather than left out: an entry landing in either
    // row would tell a reader to fill a slot that decides nothing.
    expect(CONTROL_NEEDS_SOURCE.image).toEqual({});
    expect(CONTROL_NEEDS_SOURCE.audio).toEqual({});
  });
});
