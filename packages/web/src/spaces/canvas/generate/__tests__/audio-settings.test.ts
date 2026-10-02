// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import { choiceLabel, hasSettings, settingsLayout } from '@web/spaces/canvas/generate/audio-settings';
import { STAND_IN_ON } from '@web/spaces/canvas/generate/stand-in';

/**
 * A tts model declaring the given params.
 * @param params - The param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    generation_time: 30,
    takes_prompt: true,
    params,
    providers: [],
  };
}

const LANGUAGES = Array.from({ length: 24 }, (_, i) => `Language ${i}`);

const GEMINI = model({
  language: { description: '', label: 'Language', fill: 'panel', default: 'Language 0', values: LANGUAGES },
  speakers: {
    description: '',
    label: 'Speakers',
    fill: 'panel',
    default: null,
    type: 'items',
    min_items: 2,
    max_items: 2,
    replaces: 'voice_id',
    fields: { speaker: { type: 'text' }, voice: { values: ['Kore'] } },
  },
  voice_id: { description: '', default: 'Kore', remote_source: 'voices', fill: 'remote' },
});

const MINIMAX = model({
  emotion: { description: '', label: 'Emotion', fill: 'panel', default: 'happy', values: ['happy', 'sad'] },
  pronunciation_dict: {
    description: '',
    label: 'Pronunciations',
    fill: 'panel',
    default: null,
    type: 'items',
    fields: { text: { type: 'text' }, pronunciation: { type: 'text' } },
  },
  speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  voice_id: { description: '', default: null, remote_source: 'voices', fill: 'remote' },
});

describe('settingsLayout', () => {
  it('lays Gemini out as reading mode, then language, then voice', () => {
    const layout = settingsLayout(GEMINI, {});
    expect(layout.standIn?.name).toBe('speakers');
    expect(layout.rows).toEqual([
      { kind: 'choice', name: 'language' },
      { kind: 'voice', name: 'voice_id' },
    ]);
    expect(layout.inline).toEqual([]);
  });

  it('swaps the voice row for the speakers in a dialogue', () => {
    expect(settingsLayout(GEMINI, { [STAND_IN_ON]: true }).rows).toEqual([
      { kind: 'choice', name: 'language' },
      { kind: 'speaker', name: 'speakers', index: 0 },
      { kind: 'speaker', name: 'speakers', index: 1 },
    ]);
  });

  it('keeps a short choice in place and opens a list of entries beside', () => {
    const layout = settingsLayout(MINIMAX, {});
    expect(layout.rows).toEqual([
      { kind: 'items', name: 'pronunciation_dict' },
      { kind: 'voice', name: 'voice_id' },
    ]);
    expect(layout.inline.map((c) => c.name)).toEqual(['emotion']);
  });
});

describe('hasSettings', () => {
  it('is false only for a model with no voice and no control', () => {
    expect(hasSettings(model({}))).toBe(false);
    expect(hasSettings(GEMINI)).toBe(true);
  });
});

describe('choiceLabel', () => {
  const spec = { values: ['English (United States)', 'Japanese (Japan)'], value_locales: ['en-US', 'ja-JP'] };

  it('names a language in the reader\'s own language', () => {
    expect(choiceLabel(spec, 'Japanese (Japan)', 'zh-CN')).toBe(
      new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of('ja-JP'),
    );
    expect(choiceLabel(spec, 'Japanese (Japan)', 'en')).toBe(
      new Intl.DisplayNames(['en'], { type: 'language' }).of('ja-JP'),
    );
  });

  it('names a regional variant as language and region, like every other entry', () => {
    // User 2026-09-29: "American English" sat apart from "English (India)".
    const english = { values: ['English (United States)', 'English (India)'], value_locales: ['en-US', 'en-IN'] };
    expect(choiceLabel(english, 'English (United States)', 'en')).toBe('English (United States)');
    expect(choiceLabel(english, 'English (United States)', 'zh-CN')).toBe('英语（美国）');
  });

  it('falls back to the declared spelling without a tag', () => {
    expect(choiceLabel({ values: ['a'], value_labels: { a: 'Alpha' } }, 'a', 'en')).toBe('Alpha');
    expect(choiceLabel({ values: ['a'] }, 'a', 'en')).toBe('A');
  });
});
