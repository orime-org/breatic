// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import type { StoryboardControl } from '@web/spaces/canvas/generate/model-controls';
import { readShots, storyboardParams } from '@web/spaces/canvas/generate/storyboard';

/** Kling's storyboard: up to six shots of 1–15 seconds, 5 by default, 3–15 in all. */
const CONTROL: StoryboardControl = {
  name: 'multi_prompt',
  label: 'Storyboard',
  max: 6,
  fields: [
    { name: 'prompt', kind: 'text' },
    {
      name: 'duration',
      kind: 'choice',
      initial: 5,
      options: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) })),
    },
  ],
  lengths: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
};

describe('readShots', () => {
  it('reads each stored shot as a prompt and a length', () => {
    expect(
      readShots([{ prompt: 'a wide', duration: 3 }, { prompt: 'a close', duration: 2 }], CONTROL),
    ).toEqual([
      { prompt: 'a wide', duration: 3 },
      { prompt: 'a close', duration: 2 },
    ]);
  });

  it('reads what a collaborator could have stored as something a shot can hold', () => {
    // Node data is collaborative and untrusted: a missing prompt is an empty
    // one, and a length the model does not take is the one a new shot starts at.
    expect(
      readShots([{ duration: 99 }, 'stray', null, { prompt: 7, duration: '2' }], CONTROL),
    ).toEqual([
      { prompt: '', duration: 5 },
      { prompt: '', duration: 5 },
    ]);
    expect(readShots(undefined, CONTROL)).toEqual([]);
  });
});

describe('storyboardParams', () => {
  const params = { duration: 10, aspect_ratio: '16:9', multi_prompt: [{ prompt: 'old', duration: 4 }] };

  it('sends the shots and makes their total the run length while it is on', () => {
    const shots = [
      { prompt: 'a wide', duration: 3 },
      { prompt: 'a close', duration: 2 },
    ];
    expect(storyboardParams(params, { control: CONTROL, on: true, shots })).toEqual({
      duration: 5,
      aspect_ratio: '16:9',
      multi_prompt: shots,
    });
  });

  it('sends no shots while it is off, and leaves the chosen length alone', () => {
    const shots = readShots(params.multi_prompt, CONTROL);
    expect(storyboardParams(params, { control: CONTROL, on: false, shots })).toEqual({
      duration: 10,
      aspect_ratio: '16:9',
    });
  });

  it('passes a model without a storyboard through untouched', () => {
    expect(storyboardParams(params, undefined)).toBe(params);
  });
});
