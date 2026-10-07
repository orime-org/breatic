// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reference-audio slot, and the lookup that has to reach it (#1960 PR2).
 *
 * `slotForPurpose` used to close over `VIDEO_SLOTS` and return a `VideoSlot`,
 * so a `refAudio` pick got `undefined` back. Its two callers in `CanvasSpace`
 * read that as "this pick fills no slot" and carry on: the click handler falls
 * through to the reference branch, which wires an EDGE instead of filling the
 * slot, and the candidate dimming falls back to `canConnect`, which for an
 * audio node whitelists text and audio — the panel would light up exactly the
 * nodes the pick cannot take and dim the ones it wants. Both failures compile. (The
 * video panel's two call sites test the result against `VIDEO_SLOTS` before
 * using it, so they were never the exposed ones.)
 *
 * That is why the lookup is tested directly rather than only through the panel:
 * this is the one call whose wrong answer is silent everywhere downstream.
 */

import { describe, it, expect } from 'vitest';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import type { AudioSlot } from '@web/spaces/canvas/generate/audio-slots';
import {
  refusalToastKey,
  REFUSAL_TOAST_KEY,
  type ExecuteRefusal,
} from '@breatic/shared';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { PARAMS as AUDIO_PARAMS } from '@web/spaces/canvas/generate/audio-params';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { allSlotSpecs, slotForPurpose, type SlotSpec } from '@web/spaces/canvas/generate/slots';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

describe('the reference-audio slot', () => {
  it('takes an audio node and travels as the param the vendor names', () => {
    const spec = AUDIO_SLOTS.refAudio;
    expect(spec.accepts).toBe('audio');
    // qwen3-tts/voice-clone calls the reference URL `audio`.
    expect(spec.param).toBe('audio');
    expect(spec.field).toBe('refAudio');
    expect(spec.purpose).toBe('refAudio');
  });

  it('stores a cover alongside the URL, as every non-image slot does', () => {
    // The toolbar paints a filled slot with an <img>. An audio URL there
    // renders nothing at all, so the slot keeps `{url, cover}` and the button
    // covers itself with the audio node's icon.
    expect(AUDIO_SLOTS.refAudio.storesCover).toBe(true);
  });

  it('names messages all five catalogs answer', () => {
    const spec = AUDIO_SLOTS.refAudio;
    const keys = [spec.labelKey, spec.tipKey, spec.clearLabelKey];
    for (const [locale, catalog] of LOCALE_CATALOGS) {
      for (const key of keys) {
        expect(readPath(catalog, key), `${locale} is missing ${key}`).toBeTypeOf('string');
      }
    }
  });
});

describe('slotForPurpose reaches both registries', () => {
  it('answers refAudio for the audio slot', () => {
    // The whole point of the finding: this used to be undefined, and every
    // caller treated undefined as "not a slot pick" without complaining.
    expect(slotForPurpose('refAudio')).toBe('refAudio');
  });

  it('still answers the video slots it always did', () => {
    expect(slotForPurpose('drivingAudio')).toBe('drivingAudio');
    expect(slotForPurpose('firstFrame')).toBe('firstFrame');
  });

  it('answers undefined for a pick that fills no slot', () => {
    expect(slotForPurpose('reference')).toBeUndefined();
  });
});

describe('allSlotSpecs', () => {
  it('carries every slot from every registry', () => {
    const specs = allSlotSpecs();
    const fields = specs.map((s) => s.field).sort();
    const expected = [
      ...Object.values(VIDEO_SLOTS).map((s) => s.field),
      ...Object.values(AUDIO_SLOTS).map((s) => s.field),
      ...Object.values(IMAGE_SLOTS).map((s) => s.field),
    ].sort();
    expect(fields).toEqual(expected);
  });

  it('includes refAudio, which is what the delete accounting reads', () => {
    // `canvas-upload` walks this to answer "does any node still hold this
    // asset". A slot missing from the walk makes a still-referenced asset
    // look unheld when its source node is deleted.
    expect(allSlotSpecs().some((s) => s.field === 'refAudio')).toBe(true);
  });
});

/**
 * The audio slots (#1960 A6, #2156).
 *
 * Each rides the same registry as the voice sample so the two lookups above
 * reach it for free — a slot missing from `slotForPurpose` wires an edge
 * instead of filling the slot, and one missing from `allSlotSpecs` makes a
 * still-held asset look unheld when its source node is deleted. Both failures
 * compile.
 */
describe('the audio slots', () => {
  const ALL = Object.keys(AUDIO_SLOTS) as AudioSlot[];

  it('reads each under the name its vendor gives the field', () => {
    expect(Object.fromEntries(ALL.map((slot) => [slot, AUDIO_SLOTS[slot].param]))).toEqual({
      refAudio: 'audio',
      soundVideo: 'video',
      moodImage: 'image',
      musicSong: 'song',
      coverSong: 'audio',
      musicMelody: 'melody',
      musicVocal: 'vocal',
    });
  });

  it('names its node field and pick after itself, a bare URL field with Url', () => {
    for (const slot of ALL) {
      const spec = AUDIO_SLOTS[slot];
      expect(spec.field, slot).toBe(spec.accepts === 'image' ? `${slot}Url` : slot);
      expect(spec.purpose, slot).toBe(slot);
    }
  });

  it('stores a cover alongside the URL for anything that is not a picture', () => {
    for (const slot of ALL) {
      const spec: SlotSpec = AUDIO_SLOTS[slot];
      expect(spec.storesCover === true, slot).toBe(spec.accepts !== 'image');
    }
  });

  it('gives each one its own test ids', () => {
    const ids = ALL.flatMap((slot) => [
      AUDIO_SLOTS[slot].testId,
      AUDIO_SLOTS[slot].thumbnailTestId,
      AUDIO_SLOTS[slot].clearTestId,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names messages all five catalogs answer', () => {
    for (const slot of ALL) {
      const spec: SlotSpec = AUDIO_SLOTS[slot];
      const keys = [spec.labelKey, spec.tipKey, spec.clearLabelKey, spec.errorKey].filter(
        (key): key is string => key !== undefined,
      );
      for (const [locale, catalog] of LOCALE_CATALOGS) {
        for (const key of keys) {
          expect(
            readPath(catalog, key),
            `${locale} is missing ${key}`,
          ).toBeTypeOf('string');
        }
      }
    }
  });

  // Walked rather than hand-listed: `i18n-no-missing-keys` only reads keys
  // spelled inside a `t("…")` call, and every one of these is table data —
  // returned from `refusalToastKey`, held on a mode option, held on a param
  // spec. A key added to one of those tables and to no catalog is invisible to
  // CI and shows up as the key itself on screen.
  it('answers every execute refusal in all five catalogs', () => {
    // Walks the table itself: which refusals exist and which ones speak is
    // answered there alone, and a copy written out here would be a second
    // place — the hole this case guards was once reopened exactly that way.
    for (const refusal of Object.keys(REFUSAL_TOAST_KEY) as ExecuteRefusal[]) {
      const key = refusalToastKey(refusal);
      if (key === null) continue;
      for (const [locale, catalog] of LOCALE_CATALOGS) {
        expect(readPath(catalog, key), `${locale} is missing ${key}`).toBeTypeOf(
          'string',
        );
      }
    }
  });

  it('answers every mode placeholder and every param label in all five catalogs', () => {
    // Walked off the table rather than hand-listed: a param added later comes
    // with a label key, and a list written out here would not know about it —
    // the panel would print the raw key at whichever locale forgot it.
    const paramKeys = Object.values(AUDIO_PARAMS).map((spec) => spec.labelKey);
    const keys = [
      ...AUDIO_MODE_OPTIONS.map((o) => o.placeholderKey),
      ...paramKeys,
      // The panel's own words for the two music boxes, which belong to no param.
      'canvas.generatePanel.musicStyleLabel',
      'canvas.generatePanel.musicLyricsLabel',
      'canvas.generatePanel.musicLyricsPlaceholder',
    ];
    for (const key of keys) {
      for (const [locale, catalog] of LOCALE_CATALOGS) {
        expect(readPath(catalog, key), `${locale} is missing ${key}`).toBeTypeOf(
          'string',
        );
      }
    }
  });

  it('reaches slotForPurpose, the lookup whose wrong answer is silent', () => {
    for (const slot of ALL) {
      expect(slotForPurpose(slot), slot).toBe(slot);
    }
  });

  it('reaches allSlotSpecs, which the delete accounting walks', () => {
    const fields = allSlotSpecs().map((s) => s.field);
    for (const slot of ALL) {
      expect(fields, slot).toContain(AUDIO_SLOTS[slot].field);
    }
  });
});
