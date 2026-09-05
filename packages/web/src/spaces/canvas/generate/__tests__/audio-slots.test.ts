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
 * audio node whitelists TEXT — the panel would light up exactly the nodes the
 * pick cannot take and dim the ones it wants. Both failures compile. (The
 * video panel's two call sites test the result against `VIDEO_SLOTS` before
 * using it, so they were never the exposed ones.)
 *
 * That is why the lookup is tested directly rather than only through the panel:
 * this is the one call whose wrong answer is silent everywhere downstream.
 */

import { describe, it, expect } from 'vitest';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import type { AudioSlot } from '@web/spaces/canvas/generate/audio-slots';
import { refusalToastKey } from '@web/spaces/canvas/generate/generate-guards';
import type { ExecuteRefusal } from '@web/spaces/canvas/generate/generate-guards';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { allSlotSpecs, slotForPurpose } from '@web/spaces/canvas/generate/slots';
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
    expect(slotForPurpose('style')).toBeUndefined();
  });
});

describe('allSlotSpecs', () => {
  it('carries every slot from both registries', () => {
    const specs = allSlotSpecs();
    const fields = specs.map((s) => s.field).sort();
    const expected = [
      ...Object.values(VIDEO_SLOTS).map((s) => s.field),
      ...Object.values(AUDIO_SLOTS).map((s) => s.field),
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
 * The three music reference slots (#1960 A6).
 *
 * Reference to music takes a whole song, a vocal line and a backing track, and
 * the vendor reads each under its own name. They ride the same registry as the
 * voice sample so the two lookups above reach them for free — a slot missing
 * from `slotForPurpose` wires an edge instead of filling the slot, and one
 * missing from `allSlotSpecs` makes a still-held asset look unheld when its
 * source node is deleted. Both failures compile.
 */
describe('the music reference slots', () => {
  const MUSIC_SLOTS = ['musicSong', 'musicVoice', 'musicInstrumental'] as const;

  it('takes an audio node in each, under the name the vendor reads', () => {
    // minimax/music-01 names them `song`, `voice` and `instrumental`
    // (measured against the gateway 2026-09-05).
    expect(AUDIO_SLOTS.musicSong.param).toBe('song');
    expect(AUDIO_SLOTS.musicVoice.param).toBe('voice');
    expect(AUDIO_SLOTS.musicInstrumental.param).toBe('instrumental');
    for (const slot of MUSIC_SLOTS) {
      expect(AUDIO_SLOTS[slot].accepts, slot).toBe('audio');
    }
  });

  it('names its node field after itself, as the voice sample does', () => {
    for (const slot of MUSIC_SLOTS) {
      expect(AUDIO_SLOTS[slot].field, slot).toBe(slot);
      expect(AUDIO_SLOTS[slot].purpose, slot).toBe(slot);
    }
  });

  it('stores a cover alongside the URL, since audio paints no thumbnail', () => {
    for (const slot of MUSIC_SLOTS) {
      expect(AUDIO_SLOTS[slot].storesCover, slot).toBe(true);
    }
  });

  it('gives each one its own test ids, so the three are distinguishable', () => {
    const ids = MUSIC_SLOTS.flatMap((slot) => [
      AUDIO_SLOTS[slot].testId,
      AUDIO_SLOTS[slot].thumbnailTestId,
      AUDIO_SLOTS[slot].clearTestId,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names messages all five catalogs answer', () => {
    for (const slot of MUSIC_SLOTS) {
      const spec = AUDIO_SLOTS[slot];
      const keys = [spec.labelKey, spec.tipKey, spec.clearLabelKey];
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

  // No audio slot carries a refusal sentence of its own: on this panel the
  // sentence is reached through `refusalToastKey`, the way every other execute
  // refusal is, and a copy on the slot is one nothing reads and everything can
  // drift from. The video panel keeps its own because its container looks one
  // up directly.
  it('states no refusal of its own, the way this panel refuses', () => {
    for (const slot of Object.keys(AUDIO_SLOTS) as AudioSlot[]) {
      expect(AUDIO_SLOTS[slot], slot).not.toHaveProperty('errorKey');
    }
  });

  // Walked rather than hand-listed: `i18n-no-missing-keys` only reads keys
  // spelled inside a `t("…")` call, and every one of these is table data —
  // returned from `refusalToastKey`, held on a mode option, held on a param
  // spec. A key added to one of those tables and to no catalog is invisible to
  // CI and shows up as the key itself on screen.
  it('answers every execute refusal in all five catalogs', () => {
    const refusals: ExecuteRefusal[] = [
      'node-gone',
      'no-model',
      'submitting',
      'prompt-missing',
      'prompt-too-long',
      'voice-missing',
      'ref-audio-missing',
      'reference-missing',
      'lyrics-missing',
    ];
    for (const refusal of refusals) {
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
    const keys = [
      ...AUDIO_MODE_OPTIONS.map((o) => o.placeholderKey),
      'canvas.generatePanel.musicStyleLabel',
      'canvas.generatePanel.musicLyricsLabel',
      'canvas.generatePanel.musicLyricsPlaceholder',
      'canvas.generatePanel.musicInstrumentalOnly',
      'canvas.generatePanel.musicWithVocals',
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
    for (const slot of MUSIC_SLOTS) {
      expect(slotForPurpose(slot), slot).toBe(slot);
    }
  });

  it('reaches allSlotSpecs, which the delete accounting walks', () => {
    const fields = allSlotSpecs().map((s) => s.field);
    for (const slot of MUSIC_SLOTS) {
      expect(fields, slot).toContain(slot);
    }
  });
});
