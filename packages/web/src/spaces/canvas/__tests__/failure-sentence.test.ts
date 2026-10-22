// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A run on the sound of a source with none says what the source is
 * (inner#1305 §7.5): a video "has no audio track", an audio clip "has no
 * sound to read", in the reader's language.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { failureSentence } from '@web/spaces/canvas/failure-sentence';

afterEach(() => setLocale('en'));

describe('no_audio_track', () => {
  it('names the source a video or an audio clip as the node holds it', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    expect(failureSentence('no_audio_track', t, 'video')).toBe('This video has no audio track.');
    expect(failureSentence('no_audio_track', t, 'audio')).toBe('This audio has no sound to read.');
  });

  it('says so in each language', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'ja', 'ko']) {
      setLocale(locale);
      const t = renderHook(() => useTranslation()).result.current;
      const video = failureSentence('no_audio_track', t, 'video');
      const audio = failureSentence('no_audio_track', t, 'audio');
      expect(audio, locale).not.toBe(video);
      expect(audio, locale).not.toMatch(/no_audio_track|\{/);
    }
  });
});
