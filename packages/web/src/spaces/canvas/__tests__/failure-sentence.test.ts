// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

// inner#1953: a run on the payer's own key that failed names the upstream as the user knows it, and whose key it was.
describe('a run on an account key that failed', () => {
  const names = { wavespeed: 'WaveSpeed Cloud' };
  const own = { payer: 'self', upstreamNames: names } as const;
  const admins = { payer: 'admin', upstreamNames: names } as const;
  const noBalance = encodeTaskFailure('account_key_failed', { upstream: 'wavespeed', keyReason: 'no_balance' });

  it('tells the payer it is their own key, by the upstream\'s name', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    expect(failureSentence(noBalance, t, undefined, own)).toBe('Your WaveSpeed Cloud key is out of balance. Top up at WaveSpeed Cloud.');
    expect(failureSentence('account_key_missing', t, undefined, own)).toBe('Your key for this run was replaced or deleted. Run it again.');
  });

  it('tells a member it is the Studio Admin\'s key, and to ask the Studio Admin', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    expect(failureSentence(noBalance, t, undefined, admins)).toBe(
      'The Studio Admin\'s WaveSpeed Cloud key is out of balance. Ask the Studio Admin to top up at WaveSpeed Cloud.',
    );
    expect(failureSentence('account_key_missing', t, undefined, admins)).toBe(
      'The Studio Admin\'s key for this run was replaced or deleted. Run it again.',
    );
  });

  it('names the upstream it could not reach', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    const stored = encodeTaskFailure('upstream_unavailable', { upstream: 'wavespeed' });
    expect(failureSentence(stored, t, undefined, own)).toBe('Couldn\'t reach WaveSpeed Cloud. Try again later.');
  });

  it('says whose key and which upstream in each language, for every reason', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      setLocale(locale);
      const t = renderHook(() => useTranslation()).result.current;
      for (const keyReason of ['invalid', 'no_balance', 'model_not_found', 'rate_limited', undefined] as const) {
        const stored = encodeTaskFailure('account_key_failed', { upstream: 'wavespeed', ...(keyReason === undefined ? {} : { keyReason }) });
        const mine = failureSentence(stored, t, undefined, own);
        const theirs = failureSentence(stored, t, undefined, admins);
        expect(mine, `${locale} ${keyReason}`).toContain('WaveSpeed Cloud');
        expect(theirs, `${locale} ${keyReason}`).toContain('Studio Admin');
        expect(mine, `${locale} ${keyReason}`).not.toContain('Studio Admin');
        expect(`${mine}${theirs}`, `${locale} ${keyReason}`).not.toMatch(/[{}]|account_key/);
      }
      const missingMine = failureSentence('account_key_missing', t, undefined, own);
      const missingTheirs = failureSentence('account_key_missing', t, undefined, admins);
      expect(missingTheirs, locale).toContain('Studio Admin');
      expect(missingMine, locale).not.toBe(missingTheirs);
    }
  });

  it('falls back to the upstream id and no owner while the key plan is not known', () => {
    setLocale('en');
    const t = renderHook(() => useTranslation()).result.current;
    expect(failureSentence(noBalance, t)).toBe('The wavespeed key is out of balance. Top up at wavespeed.');
  });
});
