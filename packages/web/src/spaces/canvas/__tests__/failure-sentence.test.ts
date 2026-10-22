// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A run on the sound of a source with none says what the source is
 * (inner#1305 §7.5): a video "has no audio track", an audio clip "has no
 * sound to read", in the reader's language.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeTaskFailure, setLocale } from '@breatic/shared';

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

// inner#856: a transcription's failure says "transcribe" and names the medium
// it heard nothing in, read off the record, so the row and the history agree.
describe('a transcription that failed', () => {
  it('says no one speaks in the medium the record names', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    const video = encodeTaskFailure('no_speech', { reading: 'transcribe', medium: 'video' });
    const audio = encodeTaskFailure('no_speech', { reading: 'transcribe', medium: 'audio' });
    expect(failureSentence(video, t)).toBe('No one speaks in this video.');
    expect(failureSentence(audio, t)).toBe('No one speaks in this audio.');
  });

  it('says a long transcript did not fit', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    expect(failureSentence('cut_short', t)).toBe('This is too long to transcribe in full.');
  });

  it('names transcribing in a format refusal, and understanding by default', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    const transcription = encodeTaskFailure('understand_unsupported_type', {
      reading: 'transcribe',
      file: 'a.ogg',
      type: 'OGG',
    });
    const reading = encodeTaskFailure('understand_unsupported_type', { file: 'a.ogg', type: 'OGG' });
    expect(failureSentence(transcription, t)).toBe('Cannot transcribe this file type (a.ogg, OGG).');
    expect(failureSentence(reading, t)).toBe('Cannot understand this file type (a.ogg, OGG).');
  });

  it('says so in each language without a placeholder left over', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'ja', 'ko']) {
      setLocale(locale);
      const t = renderHook(() => useTranslation()).result.current;
      for (const stored of [
        encodeTaskFailure('no_speech', { reading: 'transcribe', medium: 'video' }),
        encodeTaskFailure('understand_over_cap', { reading: 'transcribe', file: 'a.mp3', bytes: 9 }),
        encodeTaskFailure('understand_over_cap', { file: 'a.mp3', bytes: 9 }),
        'cut_short',
      ]) {
        expect(failureSentence(stored, t), `${locale} ${stored}`).not.toMatch(/no_speech|cut_short|\{/);
      }
    }
  });
});
