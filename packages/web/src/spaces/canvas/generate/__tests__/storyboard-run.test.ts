// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the storyboard adds to a run, by the tier in effect (#2218, design §6).
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { storyboardSpec, type ParamDescriptor } from '@breatic/shared';

import { storyboardRun } from '@web/spaces/canvas/generate/storyboard-run';

const KLING: Record<string, ParamDescriptor> = {
  duration: { description: '', default: 5, values: [3, 5, 10], fill: 'panel' },
  multi_prompt: {
    description: '',
    default: null,
    type: 'items',
    max_items: 6,
    fill: 'storyboard',
    fields: { prompt: { type: 'text', max_chars: 512 }, duration: { values: [1, 2, 3, 4, 5] } },
  },
  shot_type: { description: '', default: null, values: ['intelligence', 'customize'], fill: 'storyboard' },
};
const spec = storyboardSpec(KLING);

/**
 * A shot holding one line.
 * @param id - Its id.
 * @param text - Its words.
 * @param duration - Its seconds.
 * @returns The shot.
 */
function shot(id: string, text: string, duration: number): { id: string; prompt: Y.XmlFragment; duration: number } {
  const doc = new Y.Doc();
  const prompt = doc.getXmlFragment(id);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  prompt.insert(0, [paragraph]);
  return { id, prompt, duration };
}

const SHOTS = [shot('a', 'a paper boat', 2), shot('b', 'the pond', 3)];

describe('the storyboard part of a run', () => {
  it('adds nothing and keeps the prompt when off', () => {
    expect(storyboardRun(spec, 'off', SHOTS, 5, [], {})).toEqual({ sendsPrompt: true, params: {}, gate: undefined });
  });

  it('names the automatic tier and keeps the prompt', () => {
    expect(storyboardRun(spec, 'auto', SHOTS, 5, [], {})).toEqual({
      sendsPrompt: true,
      params: { shot_type: 'intelligence' },
      gate: undefined,
    });
  });

  it('sends every shot in place of the prompt, and hands the gate the same shots', () => {
    expect(storyboardRun(spec, 'custom', SHOTS, 5, [], {})).toEqual({
      sendsPrompt: false,
      params: {
        shot_type: 'customize',
        multi_prompt: [{ prompt: 'a paper boat', duration: 2 }, { prompt: 'the pond', duration: 3 }],
      },
      gate: {
        shots: [{ text: 'a paper boat', duration: 2 }, { text: 'the pond', duration: 3 }],
        total: 5,
        maxShots: 6,
        maxChars: 512,
      },
    });
  });

  it('is off on a model with no storyboard, whatever tier is asked', () => {
    expect(storyboardRun(undefined, 'custom', SHOTS, 5, [], {})).toEqual({ sendsPrompt: true, params: {}, gate: undefined });
  });
});
