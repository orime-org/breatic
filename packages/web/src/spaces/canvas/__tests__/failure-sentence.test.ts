// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A run on the sound of a source with none says what the source is
 * (inner#1305 §7.5): a video "has no audio track", an audio clip "has no
 * sound to read", in the user's language.
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

// inner#856: the row and history name the reading that failed.
describe('a transcription that failed', () => {
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
        encodeTaskFailure('understand_over_cap', { reading: 'transcribe', file: 'a.mp3', bytes: 9 }),
        encodeTaskFailure('understand_over_cap', { file: 'a.mp3', bytes: 9 }),
        'cut_short',
      ]) {
        expect(failureSentence(stored, t), `${locale} ${stored}`).not.toMatch(/cut_short|\{/);
      }
    }
  });
});

// #1521: a model run refused here is said in the viewer's own language.
describe('a model run refused here', () => {
  const limit = { field: 'prompt', measure: 'characters', max: 8000 } as const;

  it('names the limit a refused input broke, in each language the viewer reads', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    const stored = encodeTaskFailure('input_refused', { model: 'Gemini 3.8 Flash TTS', limit });
    expect(failureSentence(stored, t)).toBe('Gemini 3.8 Flash TTS takes at most 8,000 characters in the text.');
    setLocale('zh-CN');
    expect(failureSentence(stored, t)).toBe('Gemini 3.8 Flash TTS 的文本最多 8,000 个字符。');
  });

  it('says the general sentence when the refusal states no limit', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    expect(failureSentence(encodeTaskFailure('input_refused', { model: 'Gemini 3.8 Flash TTS' }), t))
      .toBe('Gemini 3.8 Flash TTS can’t take this run as set up. Change the settings or pick another model.');
  });

  it('names the variables a deployment is missing', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    expect(failureSentence(encodeTaskFailure('model_not_configured', { model: 'Voice Model', envVars: ['WAVESPEED_API_KEY', 'FAL_KEY'] }), t))
      .toBe('Voice Model is not set up on this deployment: it needs WAVESPEED_API_KEY, FAL_KEY.');
  });
});
