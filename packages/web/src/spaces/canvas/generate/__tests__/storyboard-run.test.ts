// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the multi-shot mode's shots add to a run: Kling's go out in their own
 * field, another model's are written into the prompt.
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
    modes: ['multi_shot'],
    fill: 'storyboard',
    fields: { prompt: { type: 'text', max_chars: 512 }, duration: { values: [1, 2, 3, 4, 5] } },
  },
  shot_type: { description: '', default: null, values: ['customize'], modes: ['multi_shot'], fill: 'storyboard' },
};
const WAN: Record<string, ParamDescriptor> = {
  duration: { description: '', default: 5, min: 2, max: 30, fill: 'panel' },
  shots: {
    description: '',
    default: null,
    type: 'items',
    modes: ['multi_shot'],
    into_prompt: 'Shot {n} [{start}-{end}s]: {prompt}',
    fill: 'storyboard',
    fields: { prompt: { type: 'text' }, duration: { values: [1, 2, 3, 4, 5] } },
  },
};

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
const GATE = {
  shots: [{ text: 'a paper boat', duration: 2 }, { text: 'the pond', duration: 3 }],
  total: 5,
  maxShots: 6,
};

describe('the shots part of a run', () => {
  it('adds nothing and keeps the main prompt outside the multi-shot mode', () => {
    expect(storyboardRun(storyboardSpec(KLING, 't2v'), SHOTS, 5, [], {})).toEqual({
      sendsPrompt: true,
      writtenPrompt: undefined,
      params: {},
      gate: undefined,
    });
  });

  it('sends Kling every shot in its own field in place of the prompt, and hands the gate the same shots', () => {
    expect(storyboardRun(storyboardSpec(KLING, 'multi_shot'), SHOTS, 5, [], {})).toEqual({
      sendsPrompt: false,
      writtenPrompt: undefined,
      params: {
        shot_type: 'customize',
        multi_prompt: [{ prompt: 'a paper boat', duration: 2 }, { prompt: 'the pond', duration: 3 }],
      },
      gate: { ...GATE, maxChars: 512 },
    });
  });

  it('writes the shots into the prompt for a model with no field for them', () => {
    expect(storyboardRun(storyboardSpec(WAN, 'multi_shot'), SHOTS, 5, [], {})).toEqual({
      sendsPrompt: false,
      writtenPrompt: 'Shot 1 [0-2s]: a paper boat\nShot 2 [2-5s]: the pond',
      params: {},
      gate: { ...GATE, maxChars: undefined },
    });
  });
});
