// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The controls only one model has, drawn by the shape it declares (#2156,
 * design §12): values → a row of options, true/false → a switch, a range → a
 * slider, text → a text box. Lists are an editor of their own and not here.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import { describe, it, expect } from 'vitest';

import { modelControls } from '@web/spaces/canvas/generate/model-controls';

/**
 * A model declaring the given params.
 * @param params - What it declares.
 * @returns The catalog entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'a-model',
    display_name: 'A Model',
    modality: 'image',
    mode: 't2i',
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: true,
    params,
    providers: [],
  };
}

describe('modelControls', () => {
  it('draws a switch for a true/false choice', () => {
    const controls = modelControls(
      model({
        transparency: {
          description: '',
          label: 'Transparent background',
          values: [true, false],
          default: false,
          fill: 'panel',
        },
      }),
    );
    expect(controls).toEqual([
      { kind: 'toggle', name: 'transparency', label: 'Transparent background' },
    ]);
  });

  it('draws a row of options, each read by its declared label or itself capitalised', () => {
    const controls = modelControls(
      model({
        quality: {
          description: '',
          label: 'Quality',
          values: ['low', 'xhigh'],
          value_labels: { xhigh: 'XHigh' },
          default: 'low',
          fill: 'panel',
        },
      }),
    );
    expect(controls).toEqual([
      {
        kind: 'choice',
        name: 'quality',
        label: 'Quality',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'xhigh', label: 'XHigh' },
        ],
      },
    ]);
  });

  it('draws a slider for a range, stepping by one when no step is declared', () => {
    const controls = modelControls(
      model({
        chaos: { description: '', label: 'Chaos', min: 0, max: 100, default: 0, fill: 'panel' },
      }),
    );
    expect(controls).toEqual([
      { kind: 'range', name: 'chaos', label: 'Chaos', min: 0, max: 100, step: 1 },
    ]);
  });

  it('draws a text box for free text', () => {
    const controls = modelControls(
      model({
        negative_prompt: {
          description: '',
          label: 'Negative prompt',
          type: 'text',
          default: null,
          fill: 'panel',
        },
      }),
    );
    expect(controls).toEqual([
      { kind: 'text', name: 'negative_prompt', label: 'Negative prompt' },
    ]);
  });

  it('draws a list editor for a list of entries, each field by its own shape', () => {
    const controls = modelControls(
      model({
        speakers: {
          description: '',
          label: 'Speakers',
          type: 'items',
          max_items: 2,
          default: null,
          fill: 'panel',
          fields: { speaker: { type: 'text' }, voice: { values: ['Kore', 'Puck'] } },
        },
      }),
    );
    expect(controls).toEqual([
      {
        kind: 'items',
        name: 'speakers',
        label: 'Speakers',
        max: 2,
        fields: [
          { name: 'speaker', kind: 'text' },
          {
            name: 'voice',
            kind: 'choice',
            options: [
              { value: 'Kore', label: 'Kore' },
              { value: 'Puck', label: 'Puck' },
            ],
          },
        ],
      },
    ]);
  });

  it('leaves out the shared controls and anything not the panel\'s to fill', () => {
    const controls = modelControls(
      model({
        // A shared control carries no label: its panel draws it by name.
        aspect_ratio: { description: '', values: ['1:1'], default: '1:1', fill: 'panel' },
        seed: { description: '', label: 'Seed', min: 0, max: 9, default: 0, fill: 'none' },
      }),
    );
    expect(controls).toEqual([]);
  });

  it('keeps the order the model declares its params in', () => {
    const controls = modelControls(
      model({
        weird: { description: '', label: 'Weird', min: 0, max: 3000, default: 0, fill: 'panel' },
        chaos: { description: '', label: 'Chaos', min: 0, max: 100, default: 0, fill: 'panel' },
      }),
    );
    expect(controls.map((c) => c.name)).toEqual(['weird', 'chaos']);
  });
});
