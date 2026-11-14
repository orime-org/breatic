// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A node saved on a model the catalog has since retired opens on its
 * replacement (#1521): its model, its per-mode memory and the key of its param
 * record all read the new name, and nothing it held is lost.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RETIRED_MODELS, currentModelName, withCurrentModelNames } from '@shared/canvas/retired-models.js';
import * as entry from '@shared/index.js';

const OLD = 'gemini-3.1-flash-text-to-speech';
const NEW = 'gemini-3.8-flash-text-to-speech';
const PAIR = [{ speaker: 'Ava', voice: 'Kore' }, { speaker: 'Leo', voice: 'Puck' }];

describe('the retired model table', () => {
  it('sends Gemini 3.1 Flash TTS to Gemini 3.8 Flash TTS', () => {
    expect(RETIRED_MODELS[OLD]).toBe(NEW);
  });

  it('is exported from the main entry with its helpers', () => {
    expect(entry.RETIRED_MODELS).toBe(RETIRED_MODELS);
    expect(entry.currentModelName).toBe(currentModelName);
    expect(entry.withCurrentModelNames).toBe(withCurrentModelNames);
  });

  it('never names a retired model as a replacement', () => {
    for (const replacement of Object.values(RETIRED_MODELS)) {
      expect(RETIRED_MODELS[replacement]).toBeUndefined();
    }
  });
});

describe('currentModelName', () => {
  it('gives the replacement of a retired name', () => {
    expect(currentModelName(OLD)).toBe(NEW);
  });

  it('gives any other name back as it is', () => {
    expect(currentModelName(NEW)).toBe(NEW);
    expect(currentModelName('minimax-speech-2.8-hd')).toBe('minimax-speech-2.8-hd');
  });
});

describe('withCurrentModelNames', () => {
  it('reads a node saved on the retired model as its replacement, its records whole', () => {
    const data = {
      mode: 'tts',
      model: OLD,
      modelByMode: { tts: OLD, music: 'mureka-v9.5-song' },
      paramsByModel: { [OLD]: { language: 'Japanese (Japan)', speakers: PAIR }, 'mureka-v9.5-song': { lyrics: 'la' } },
      prompts: { tts: 'Ava: Hi.' },
    };
    expect(withCurrentModelNames(data)).toEqual({
      mode: 'tts',
      model: NEW,
      modelByMode: { tts: NEW, music: 'mureka-v9.5-song' },
      paramsByModel: { [NEW]: { language: 'Japanese (Japan)', speakers: PAIR }, 'mureka-v9.5-song': { lyrics: 'la' } },
      prompts: { tts: 'Ava: Hi.' },
    });
  });

  it('keeps what the old record held under a newer record written beside it, the newer value winning', () => {
    const data = {
      model: NEW,
      paramsByModel: { [OLD]: { speakers: PAIR, voice_id: 'Kore' }, [NEW]: { voice_id: 'Puck' } },
    };
    expect(withCurrentModelNames(data).paramsByModel).toEqual({ [NEW]: { speakers: PAIR, voice_id: 'Puck' } });
  });

  it('gives the same object back when no name is retired', () => {
    const data = { model: NEW, modelByMode: { tts: NEW }, paramsByModel: { [NEW]: { voice_id: 'Kore' } } };
    expect(withCurrentModelNames(data)).toBe(data);
  });

  it('leaves a node without model fields alone', () => {
    const data = { content: 'text' };
    expect(withCurrentModelNames(data)).toBe(data);
  });

  it('ignores fields that are not what they claim to be, as collaborative data can be anything', () => {
    const data = { model: 7, modelByMode: 'x', paramsByModel: [1, 2] };
    expect(withCurrentModelNames(data as unknown as Record<string, unknown>)).toBe(data);
  });

  const name = fc.oneof(fc.constant(OLD), fc.constant(NEW), fc.constantFrom('a', 'b', 'mureka-v9.5-song'));
  const record = fc.dictionary(fc.constantFrom('speakers', 'voice_id', 'language', 'speed'), fc.oneof(fc.string(), fc.integer()));
  const node = fc.record(
    {
      model: name,
      modelByMode: fc.dictionary(fc.constantFrom('tts', 'music', 'sfx'), name),
      paramsByModel: fc.dictionary(name, record),
    },
    { requiredKeys: [] },
  );

  it('is idempotent', () => {
    fc.assert(fc.property(node, (data) => {
      const once = withCurrentModelNames(data);
      expect(withCurrentModelNames(once)).toEqual(once);
    }));
  });

  it('leaves no retired name anywhere it reads', () => {
    fc.assert(fc.property(node, (data) => {
      const out = withCurrentModelNames(data);
      const names = [out.model, ...Object.values(out.modelByMode ?? {}), ...Object.keys(out.paramsByModel ?? {})];
      for (const each of names) expect(RETIRED_MODELS[each as string]).toBeUndefined();
    }));
  });

  it('loses no param field a record held', () => {
    fc.assert(fc.property(node, (data) => {
      const out = withCurrentModelNames(data);
      for (const [model, params] of Object.entries(data.paramsByModel ?? {})) {
        const kept = out.paramsByModel?.[currentModelName(model)] ?? {};
        for (const field of Object.keys(params)) expect(kept).toHaveProperty(field);
      }
    }));
  });
});
