// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The controls only one model has, drawn by the shape it declares (#2156,
 * design §12): values → a row of options, true/false → a switch, a range → a
 * slider, text → a text box. Lists are an editor of their own and not here.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import {
  GENERATION_NODE_BUCKETS,
  MINI_TOOLS,
  toolParamKeys,
  type ModelEntry,
  type ParamDescriptor,
} from '@breatic/shared';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

import {
  cameraAngleNames,
  controlsForKeys,
  modelControls,
  ownControlSummary,
  ownControlValues,
} from '@web/spaces/canvas/generate/model-controls';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';

import { CAMERA_PARAMS, CAMERA_SPECS } from './camera-angle-specs';

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
    expect(ownControlSummary(model({ auto_shots: auto }), 'multi_shot', { auto_shots: true }, (n) => n)).toEqual([]);
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
  const nameOf = (name: string): string => `name:${name}`;

  it('says what each choice and range stands on in a freshly resolved record', () => {
    expect(ownControlSummary(OWN, 't2i', resolveParamsForModel(OWN, {}), nameOf)).toEqual(['Low', '20']);
  });

  it('names a text param only while it holds something', () => {
    expect(ownControlSummary(OWN, 't2i', { quality: 'low', chaos: 5, negative_prompt: 'blur' }, nameOf)).toEqual([
      'Low',
      '5',
      'name:negative_prompt',
    ]);
    expect(ownControlSummary(OWN, 't2i', { quality: 'low', chaos: 5, negative_prompt: '' }, nameOf)).toEqual(['Low', '5']);
  });

  it('names a range by its value_labels where one names the step it stands on', () => {
    const named = model({
      strength: { description: '', label: 'Strength', min: 0, max: 1, step: 0.5, value_labels: { '1': 'Full', '0': 'Off' }, default: 0, fill: 'panel' },
    });
    expect(modelControls(named, 't2i')).toEqual([
      { kind: 'range', name: 'strength', min: 0, max: 1, step: 0.5, stops: [{ value: 0, label: 'Off' }, { value: 1, label: 'Full' }] },
    ]);
    expect(ownControlSummary(named, 't2i', { strength: 1 }, nameOf)).toEqual(['Full']);
    expect(ownControlSummary(named, 't2i', { strength: 0.5 }, nameOf)).toEqual(['0.5']);
  });

  it('reads what the node holds, and names a switch only while it is on', () => {
    expect(ownControlSummary(OWN, 't2i', { quality: 'xhigh', chaos: 5, transparency: true }, nameOf)).toEqual([
      'XHigh',
      '5',
      'name:transparency',
    ]);
  });
});

describe('a model whose three params set one camera pose', () => {
  const ANGLES = {
    ...model({
      quality: { description: '', label: 'Quality', values: ['low', 'high'], default: 'low', fill: 'panel' },
      ...CAMERA_SPECS,
    }),
    camera_angle: { azimuth: 'horizontal_angle', elevation: 'vertical_angle', distance: 'distance' },
  };
  const nameOf = (name: string): string => `name:${name}`;

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
      ownControlSummary(ANGLES, 't2i', { quality: 'low', horizontal_angle: 45, vertical_angle: -30, distance: 2 }, nameOf),
    ).toEqual([
      'Low',
      'Front right',
      'Low angle',
      'Wide shot',
    ]);
  });

  it('names a pose off the grid by its nearest step', () => {
    expect(cameraAngleNames(CAMERA_SPECS, CAMERA_PARAMS, { azimuth: 100, elevation: 50, distance: 0 })).toEqual([
      'Right',
      'High angle',
      'Close-up',
    ]);
  });

  it('leaves the three as plain sliders on a model that does not declare them a pose', () => {
    const plain = { ...ANGLES, camera_angle: undefined };
    expect(modelControls(plain, 't2i').map((c) => c.kind)).toEqual(['choice', 'range', 'range', 'range']);
  });
});

describe('the camera-angle control\'s own words in every locale', () => {
  it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'])('%s has the title, reset and load failure, and no pose names', (lang) => {
    const json = JSON.parse(readFileSync(resolve(process.cwd(), `../../locales/${lang}.json`), 'utf8')) as {
      canvas: { generatePanel: { cameraAngle?: Record<string, unknown> } };
    };
    const words = json.canvas.generatePanel.cameraAngle ?? {};
    expect(Object.keys(words).sort()).toEqual(['loadFailed', 'reset', 'title']);
    expect(Object.values(words).every((w) => typeof w === 'string' && w !== '')).toBe(true);
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

// inner#888 §5: a model tool's panel draws the params it lists, read from the
// pinned model's declaration, whether the generation panel draws them or not.
describe('controlsForKeys', () => {
  const pinned = model({
    target_megapixels: { description: '', default: 4, values: [4, 16, 36], fill: 'tool' },
    creativity: { description: '', default: 0, min: 0, max: 10, step: 1, fill: 'panel', label: 'Creativity' },
    image: { description: '', default: null, fill: 'tool' },
    seed: { description: '', default: null, fill: 'hidden' } as unknown as ParamDescriptor,
  });

  it('draws the listed tool and panel params in the order they are listed', () => {
    const controls = controlsForKeys(pinned, ['creativity', 'target_megapixels']);
    expect(controls.map((control) => [control.kind, control.name])).toEqual([
      ['range', 'creativity'],
      ['choice', 'target_megapixels'],
    ]);
  });

  it('draws nothing for a param of another fill, or one the model does not declare', () => {
    expect(controlsForKeys(pinned, ['seed', 'absent'])).toEqual([]);
  });
});

describe('every param a model tool shows is named in every locale', () => {
  const keys = [...new Set(MINI_TOOLS.flatMap((tool) => toolParamKeys(tool)))];
  it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'])('%s', (lang) => {
    const json = JSON.parse(readFileSync(resolve(process.cwd(), `../../locales/${lang}.json`), 'utf8')) as {
      canvas: { generatePanel: { param?: Record<string, string> } };
    };
    expect(keys.filter((key) => !json.canvas.generatePanel.param?.[key])).toEqual([]);
  });
});
