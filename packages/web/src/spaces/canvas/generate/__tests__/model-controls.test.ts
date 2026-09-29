// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The controls only one model has, drawn by the shape it declares (#2156,
 * design §12): values → a row of options, true/false → a switch, a range → a
 * slider, text → a text box. Lists are an editor of their own and not here.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { GENERATION_NODE_BUCKETS, type ModelEntry, type ParamDescriptor } from '@breatic/shared';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

import { modelControls, ownControlSummary } from '@web/spaces/canvas/generate/model-controls';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';

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
      { kind: 'toggle', name: 'transparency' },
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
      { kind: 'range', name: 'chaos', min: 0, max: 100, step: 1 },
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
      { kind: 'text', name: 'negative_prompt' },
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

describe('ownControlSummary', () => {
  const OWN = model({
    quality: { description: '', label: 'Quality', values: ['low', 'xhigh'], value_labels: { xhigh: 'XHigh' }, default: 'low', fill: 'panel' },
    chaos: { description: '', label: 'Chaos', min: 0, max: 100, step: 1, default: 20, fill: 'panel' },
    transparency: { description: '', label: 'Transparent', values: [false, true], default: false, fill: 'panel' },
    negative_prompt: { description: '', label: 'Negative', type: 'text', default: null, fill: 'panel' },
  });
  const nameOf = (name: string): string => `name:${name}`;

  it('says what each choice and range stands on in a freshly resolved record', () => {
    expect(ownControlSummary(OWN, resolveParamsForModel(OWN, {}), nameOf)).toEqual(['Low', '20']);
  });

  it('names a text param only while it holds something', () => {
    expect(ownControlSummary(OWN, { quality: 'low', chaos: 5, negative_prompt: 'blur' }, nameOf)).toEqual([
      'Low',
      '5',
      'name:negative_prompt',
    ]);
    expect(ownControlSummary(OWN, { quality: 'low', chaos: 5, negative_prompt: '' }, nameOf)).toEqual(['Low', '5']);
  });

  it('reads what the node holds, and names a switch only while it is on', () => {
    expect(ownControlSummary(OWN, { quality: 'xhigh', chaos: 5, transparency: true }, nameOf)).toEqual([
      'XHigh',
      '5',
      'name:transparency',
    ]);
  });
});

describe('every param a panel names has words in every locale', () => {
  // Read as written, the way the icon test reads it: the catalog projection
  // drops a model whose provider key is unset, so under CI it would have
  // nothing to walk. Every bucket a generate panel reads.
  const root = resolve(process.cwd(), '../../config/models');
  const buckets = [...new Set(Object.values(GENERATION_NODE_BUCKETS).flat())];
  const models = buckets
    .map((bucket) => resolve(root, bucket))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => extname(file) === '.yaml' && file !== 'providers.yaml')
        .map((file) => resolve(dir, file)),
    )
    .flatMap((file) => {
      const doc: unknown = parse(readFileSync(file, 'utf8'));
      const list = Array.isArray(doc) ? doc : ((doc as { models?: unknown[] } | null)?.models ?? []);
      return list as Array<{ name: string; params?: Record<string, ParamDescriptor> }>;
    });
  const labelled = models.flatMap((m) =>
    Object.entries(m.params ?? {})
      .filter(([, spec]) => spec.fill === 'panel' && typeof spec.label === 'string')
      .map(([name, spec]) => ({ model: m.name, name, spec })),
  );
  const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'].map((lang) => {
    const json = JSON.parse(readFileSync(resolve(process.cwd(), `../../locales/${lang}.json`), 'utf8')) as {
      canvas: { generatePanel: { param?: Record<string, string>; paramField?: Record<string, string> } };
    };
    return { lang, panel: json.canvas.generatePanel };
  });

  it('names each labelled param', () => {
    expect(labelled.length).toBeGreaterThan(0);
    const missing = locales.flatMap(({ lang, panel }) =>
      labelled.filter(({ name }) => !panel.param?.[name]).map(({ model, name }) => `${lang}: ${model}.${name}`),
    );
    expect(missing).toEqual([]);
  });

  it('names each field of a list of entries', () => {
    const fields = [...new Set(labelled.flatMap(({ spec }) => Object.keys(spec.fields ?? {})))];
    const missing = locales.flatMap(({ lang, panel }) =>
      fields.filter((field) => !panel.paramField?.[field]).map((field) => `${lang}: ${field}`),
    );
    expect(missing).toEqual([]);
  });
});
