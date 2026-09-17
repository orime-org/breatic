// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel's own tables against the ones the agent's answer reads (#261, #229).
 *
 * Which parameters a mode fills by pointing at a node, and which of the rest
 * the panel draws a control for, are stated once in `@breatic/shared` so that
 * the panel and the answer offer a reader the same thing. These derive the
 * same facts from the panel's own definitions.
 *
 * Every row of all five shared tables is pinned here, and every pin derives
 * its panel side from the panel's own definitions except for three names it
 * has to write out: the image mode options carry no slot registry, so the
 * reference list and the style slot are literals here (the reference list is
 * read by the video row too), and the audio panel names its lyrics box by the
 * boolean on a mode rather than by a param, so that param name is one as well.
 *
 * Rows went unpinned twice, and both times the unpinned row was wrong: the
 * video row lost the two audio switches, the audio row lost the lyrics box,
 * and the keep-original-sound switch was reported as unconditional while the
 * panel mounts it on a slot. A row without a case below is a row nothing
 * holds.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTROL_GATES,
  MODE_LABELS,
  MODE_MATERIAL_COUNT,
  MODE_SOURCE_FIELDS,
  PANEL_PARAM_CONTROLS,
} from '@breatic/shared';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import {
  INSTRUMENTAL_PARAM,
  PARAMS as AUDIO_PARAMS,
} from '@web/spaces/canvas/generate/audio-params';
import {
  CAMERA_GATED_PARAMS,
  CAMERA_PARAMS,
  CAMERA_SWITCH_PARAM,
} from '@web/spaces/canvas/generate/CameraPicker';
import { IMAGE_MODE_OPTIONS } from '@web/spaces/canvas/generate/image-mode-selection';
import { RATIO_RESOLUTION_PARAMS } from '@web/spaces/canvas/generate/RatioResolutionPicker';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { VIDEO_MODE_OPTIONS } from '@web/spaces/canvas/generate/video-mode-options';
import {
  EDITED_PARAMS,
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
    // The pool is left out of both sides: whether a mode draws on it is the
    // model's to declare now, so the panel's table no longer says.
    for (const option of VIDEO_MODE_OPTIONS) {
      const fromPanel = option.slots.map((slot) => VIDEO_SLOTS[slot].param).sort();
      expect(
        [...(MODE_SOURCE_FIELDS.video[option.value] ?? [])]
          .filter((param) => param !== REFERENCE_PARAM)
          .sort(),
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

describe('how many pieces a mode asks the reader for', () => {
  // The three panels count differently, so the shared table cannot be one
  // rule over one list of slots:
  //
  //   video     refuses on EVERY empty slot that is not marked optional
  //   audio     takes ANY ONE of the slots it offers
  //   the pool  takes at least one reference, whatever else the mode offers
  //
  // A slot added or marked optional fails a case here rather than reaching a
  // reader as a group the generate button will not run.
  it('matches what the audio panel refuses to generate without', () => {
    // `evaluateExecute` asks `required.some((slot) => filled.includes(slot))`,
    // so a mode offering three slots is satisfied by one of them.
    for (const option of AUDIO_MODE_OPTIONS) {
      expect(MODE_MATERIAL_COUNT.audio[option.value], `audio ${option.value}`).toBe(
        option.slots.length > 0 ? 1 : 0,
      );
    }
  });

  it('matches what the image panel refuses to generate without', () => {
    // The image panel has no slots of its own: image-to-image takes its
    // material through the reference list, and text-to-image asks for
    // nothing. The style slot both offer is optional (#266).
    for (const option of IMAGE_MODE_OPTIONS) {
      expect(MODE_MATERIAL_COUNT.image[option.value], `image ${option.value}`).toBe(
        option.value === 'i2i' ? 1 : 0,
      );
    }
  });

  it('answers for every mode each panel offers, and no others', () => {
    // A mode added to a panel and left out of the table would be answered
    // with nothing, and the check would let any number of empty nodes past.
    expect(Object.keys(MODE_MATERIAL_COUNT.image).sort()).toEqual(
      IMAGE_MODE_OPTIONS.map((o) => o.value).sort(),
    );
    expect(Object.keys(MODE_MATERIAL_COUNT.video).sort()).toEqual(
      VIDEO_MODE_OPTIONS.map((o) => o.value).sort(),
    );
    expect(Object.keys(MODE_MATERIAL_COUNT.audio).sort()).toEqual(
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

describe('what has to hold before a control counts', () => {
  it('names a source this panel draws a slot for', () => {
    // The model names the PARAM its switch waits for, and this panel draws
    // that param under a slot of its own naming. A source no slot carries is
    // a control the panel would never mount.
    const carried = new Set<string>(Object.values(VIDEO_SLOTS).map((spec) => spec.param));

    expect([...new Set(Object.values(CONTROL_GATES.video).map((gate) => gate.param))]
      .filter((param) => !carried.has(param))).toEqual([]);
  });

  it('carries that source in one slot per mode, so filling it is one instruction', () => {
    // Two slots carry `video` — the driving clip in animate and the reference
    // clip in ref. "Fill video" and "fill this slot" are the same instruction
    // only while the mode drawing the control offers one of them.
    for (const gate of Object.values(CONTROL_GATES.video)) {
      for (const option of VIDEO_MODE_OPTIONS) {
        const carriers = option.slots.filter((s) => VIDEO_SLOTS[s].param === gate.param);
        expect(
          carriers.length,
          `video ${option.value} carries ${gate.param} at most once`,
        ).toBeLessThan(2);
      }
    }
  });

  it('matches the image panel, gate for gate', () => {
    expect(CONTROL_GATES.image).toEqual(
      Object.fromEntries(
        CAMERA_GATED_PARAMS.map((param) => [
          param,
          { kind: 'flagOn', param: CAMERA_SWITCH_PARAM },
        ]),
      ),
    );
  });

  it('matches the audio panel, gate for gate', () => {
    // The lyrics box is the audio panel's one gated control: a mode collecting
    // lyrics takes them away while the track is marked instrumental.
    const gated = AUDIO_MODE_OPTIONS.some((option) => option.lyrics)
      ? { lyrics: { kind: 'flagOff', param: INSTRUMENTAL_PARAM } }
      : {};
    expect(CONTROL_GATES.audio).toEqual(gated);
  });
});

describe('what each mode is called', () => {
  it('matches every picker, label for label', () => {
    // The only thing a reader can match an answer against: the mode code is
    // nowhere in the picker, which renders this string and nothing else.
    const fromPanel = {
      image: Object.fromEntries(IMAGE_MODE_OPTIONS.map((o) => [o.value, o.label])),
      video: Object.fromEntries(VIDEO_MODE_OPTIONS.map((o) => [o.value, o.label])),
      audio: Object.fromEntries(AUDIO_MODE_OPTIONS.map((o) => [o.value, o.label])),
    };
    expect(MODE_LABELS).toEqual(fromPanel);
  });
});
