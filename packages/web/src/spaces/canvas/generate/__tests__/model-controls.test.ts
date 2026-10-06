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

import { modelControls, ownControlSummary, ownControlValues } from '@web/spaces/canvas/generate/model-controls';
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
      't2i',
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
      't2i',
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
      't2i',
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
      't2i',
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
      't2i',
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
      't2i',
    );
    expect(controls).toEqual([]);
  });

  it('leaves out a control declared only for other modes', () => {
    const auto = {
      description: '',
      label: 'Auto multi-shot',
      values: [true, false],
      default: false,
      modes: ['t2v'],
      fill: 'panel' as const,
    };
    expect(modelControls(model({ auto_shots: auto }), 't2v')).toEqual([{ kind: 'toggle', name: 'auto_shots' }]);
    expect(modelControls(model({ auto_shots: auto }), 'multi_shot')).toEqual([]);
    expect(ownControlSummary(model({ auto_shots: auto }), 'multi_shot', { auto_shots: true }, (k) => k)).toEqual([]);
  });

  it('keeps the order the model declares its params in', () => {
    const controls = modelControls(
      model({
        weird: { description: '', label: 'Weird', min: 0, max: 3000, default: 0, fill: 'panel' },
        chaos: { description: '', label: 'Chaos', min: 0, max: 100, default: 0, fill: 'panel' },
      }),
      't2i',
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
  const t = (key: string): string => `t:${key}`;

  it('says what each choice and range stands on in a freshly resolved record', () => {
    expect(ownControlSummary(OWN, 't2i', resolveParamsForModel(OWN, {}), t)).toEqual(['Low', '20']);
  });

  it('names a text param only while it holds something', () => {
    expect(ownControlSummary(OWN, 't2i', { quality: 'low', chaos: 5, negative_prompt: 'blur' }, t)).toEqual([
      'Low',
      '5',
      't:canvas.generatePanel.param.negative_prompt',
    ]);
    expect(ownControlSummary(OWN, 't2i', { quality: 'low', chaos: 5, negative_prompt: '' }, t)).toEqual(['Low', '5']);
  });

  it('reads what the node holds, and names a switch only while it is on', () => {
    expect(ownControlSummary(OWN, 't2i', { quality: 'xhigh', chaos: 5, transparency: true }, t)).toEqual([
      'XHigh',
      '5',
      't:canvas.generatePanel.param.transparency',
    ]);
  });
});

describe('a model whose three params set one camera pose', () => {
  const ANGLES = {
    ...model({
      quality: { description: '', label: 'Quality', values: ['low', 'high'], default: 'low', fill: 'panel' },
      distance: { description: '', label: 'Distance', min: 0, max: 2, step: 1, default: 1, fill: 'panel' },
      horizontal_angle: { description: '', label: 'Horizontal angle', min: 0, max: 315, step: 45, default: 0, fill: 'panel' },
      vertical_angle: { description: '', label: 'Vertical angle', min: -30, max: 60, step: 30, default: 0, fill: 'panel' },
    }),
    camera_angle: { azimuth: 'horizontal_angle', elevation: 'vertical_angle', distance: 'distance' },
  };
  const t = (key: string): string => `t:${key}`;

  it('draws the three as one camera-angle control where the first of them is declared', () => {
    expect(modelControls(ANGLES, 't2i')).toEqual([
      { kind: 'choice', name: 'quality', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
      {
        kind: 'cameraAngle',
        name: 'camera_angle',
        params: { azimuth: 'horizontal_angle', elevation: 'vertical_angle', distance: 'distance' },
      },
    ]);
  });

  it('hands the picker all three values, so a committed pose redraws it', () => {
    expect(
      ownControlValues(ANGLES, 't2i', { quality: 'low', horizontal_angle: 90, vertical_angle: 30, distance: 2 }),
    ).toEqual({ quality: 'low', horizontal_angle: 90, vertical_angle: 30, distance: 2 });
  });

  it('names the pose in the pill by its azimuth, elevation and distance', () => {
    expect(
      ownControlSummary(ANGLES, 't2i', { quality: 'low', horizontal_angle: 45, vertical_angle: -30, distance: 2 }, t),
    ).toEqual([
      'Low',
      't:canvas.generatePanel.cameraAngle.azimuth.45',
      't:canvas.generatePanel.cameraAngle.elevation.low',
      't:canvas.generatePanel.cameraAngle.distance.2',
    ]);
  });

  it('leaves the three as plain sliders on a model that does not declare them a pose', () => {
    const plain = { ...ANGLES, camera_angle: undefined };
    expect(modelControls(plain, 't2i').map((c) => c.kind)).toEqual(['choice', 'range', 'range', 'range']);
  });
});

describe('every camera-angle word has words in every locale', () => {
  const keys = [
    'title',
    'reset',
    'loadFailed',
    ...[0, 45, 90, 135, 180, 225, 270, 315].map((v) => `azimuth.${v}`),
    ...['low', 'eye', 'elevated', 'high'].map((v) => `elevation.${v}`),
    ...[0, 1, 2].map((v) => `distance.${v}`),
  ];

  it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'])('%s names every pose word', (lang) => {
    const json = JSON.parse(readFileSync(resolve(process.cwd(), `../../locales/${lang}.json`), 'utf8')) as {
      canvas: { generatePanel: { cameraAngle?: Record<string, unknown> } };
    };
    const words = json.canvas.generatePanel.cameraAngle ?? {};
    /**
     * The word under a dotted key, or undefined.
     * @param key - The key below cameraAngle.
     * @returns The word.
     */
    const at = (key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], words);
    expect(keys.filter((key) => typeof at(key) !== 'string' || at(key) === '')).toEqual([]);
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
