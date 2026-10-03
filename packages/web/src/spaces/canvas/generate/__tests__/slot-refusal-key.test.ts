// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A refusal speaks in the words of the slot it names (#2156).
 */

import { describe, it, expect } from 'vitest';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import { slotRefusalKey } from '@web/spaces/canvas/generate/slots';

describe('slotRefusalKey', () => {
  it('words the refusal by the drawn slot that carries the empty param', () => {
    expect(
      slotRefusalKey(AUDIO_SLOTS, ['soundVideo'], { refusal: 'source-missing', slot: 'video' }),
    ).toBe('canvas.generatePanel.errorNoSourceVideo');
  });

  it('picks the slot the mode draws when two slots share a param', () => {
    // `audio` is the voice sample and the song to cover; only the drawn one speaks.
    expect(
      slotRefusalKey(AUDIO_SLOTS, ['coverSong'], { refusal: 'source-missing', slot: 'audio' }),
    ).toBe('canvas.generatePanel.errorNoMusicSong');
  });

  it('falls back to the gate sentence when no drawn slot answers', () => {
    expect(
      slotRefusalKey(AUDIO_SLOTS, ['musicSong'], { refusal: 'sources-missing' }),
    ).toBe('canvas.generatePanel.refuseExecuteNoReference');
  });

  it('asks for a style image when an empty style slot is what refuses the run (inner#826)', () => {
    expect(
      slotRefusalKey(IMAGE_SLOTS, ['style'], { refusal: 'source-missing', slot: 'style_images' }),
    ).toBe('canvas.generatePanel.errorNoStyleImage');
  });
});
