// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import type { ModelEntry } from '@breatic/shared';

import {
  STAND_IN_ON,
  speakersShort,
  standInOf,
  wireParams,
} from '@web/spaces/canvas/generate/stand-in';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';

const GEMINI = {
  name: 'gemini',
  params: {
    language: { fill: 'panel', default: 'English (United States)', values: ['English (United States)'] },
    speakers: {
      fill: 'panel',
      type: 'items',
      default: null,
      min_items: 2,
      max_items: 2,
      replaces: 'voice_id',
      fields: { speaker: { type: 'text' }, voice: { values: ['Kore', 'Puck'] } },
    },
    voice_id: { fill: 'remote', remote_source: 'voices', default: 'Kore' },
  },
} as unknown as ModelEntry;

const PLAIN = {
  name: 'plain',
  params: { voice_id: { fill: 'remote', remote_source: 'voices', default: null } },
} as unknown as ModelEntry;

const PAIR = [
  { speaker: 'Ada', voice: 'Kore' },
  { speaker: 'Bo', voice: 'Puck' },
];

describe('standInOf', () => {
  it('names the param that stands in for another, with its floor', () => {
    expect(standInOf(GEMINI)).toMatchObject({ name: 'speakers', replaces: 'voice_id', min: 2 });
  });

  it('answers null for a model with none', () => {
    expect(standInOf(PLAIN)).toBeNull();
  });
});

describe('the reading mode kept in the record', () => {
  it('survives reconciliation on a model with a stand-in', () => {
    const kept = resolveParamsForModel(GEMINI, { speakers: PAIR, [STAND_IN_ON]: true });
    expect(kept[STAND_IN_ON]).toBe(true);
  });

  it('is dropped on a model without one', () => {
    expect(resolveParamsForModel(PLAIN, { [STAND_IN_ON]: true })).not.toHaveProperty(STAND_IN_ON);
  });
});

describe('wireParams', () => {
  it('sends the speakers and not the voice in a dialogue', () => {
    const sent = wireParams(GEMINI, { voice_id: 'Kore', speakers: PAIR, [STAND_IN_ON]: true });
    expect(sent).toEqual({ speakers: PAIR });
  });

  it('keeps the speakers written but unsent when reading alone', () => {
    const sent = wireParams(GEMINI, { voice_id: 'Kore', speakers: PAIR });
    expect(sent).toEqual({ voice_id: 'Kore' });
  });

  it('leaves a model without a stand-in as it was', () => {
    expect(wireParams(PLAIN, { voice_id: 'x' })).toEqual({ voice_id: 'x' });
  });
});

describe('speakersShort', () => {
  it('counts only complete speakers against the floor, and only in a dialogue', () => {
    const half = [{ speaker: 'Ada', voice: 'Kore' }, { speaker: '', voice: 'Puck' }];
    expect(speakersShort(GEMINI, { speakers: half, [STAND_IN_ON]: true })).toBe(true);
    expect(speakersShort(GEMINI, { speakers: PAIR, [STAND_IN_ON]: true })).toBe(false);
    expect(speakersShort(GEMINI, { speakers: half })).toBe(false);
  });
});
