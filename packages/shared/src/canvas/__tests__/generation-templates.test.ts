// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The template registry: what each generate panel lists and what a template
 * writes (inner#977), and the creative goal and triggers each carries
 * (inner#1807).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  GENERATION_TEMPLATES,
  TEMPLATE_GOALS,
  templateGoalsFor,
  templatesFor,
  type GenerationTemplate,
  type TemplateGenerateNode,
} from '@shared/canvas/generation-templates.js';
import { templateMarkTargets, templateSkeleton } from '@shared/canvas/template-expansion.js';
import { storyboardSpec, MULTI_SHOT_MODE } from '@shared/storyboard.js';
import type { ParamDescriptor } from '@shared/types/model-catalog.js';
import { TEMPLATE_GUIDE_KEY } from '@shared/types/canvas-proposal.js';
import { setLocale, setLocaleMessages } from '@shared/i18n/index.js';
import { MAX_NODE_NAME_LEN } from '@shared/types/canvas-node.js';
import { markedSegments } from '@shared/types/canvas-proposal.js';
import { parse } from 'yaml';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];

/**
 * A registered template by id.
 * @param id - The id.
 * @returns The template, or undefined.
 */
const byId = (id: string): GenerationTemplate | undefined => GENERATION_TEMPLATES.find((template) => template.id === id);

/** Each locale file as read, so a check sees what one language holds without the English fallback. */
const MESSAGES = new Map<string, Record<string, unknown>>();

beforeAll(() => {
  for (const locale of LOCALES) {
    const file = resolve(import.meta.dirname, `../../../../../locales/${locale}.json`);
    const messages = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    MESSAGES.set(locale, messages);
    setLocaleMessages(locale, messages);
  }
});

/**
 * A string as one locale file holds it, without falling back to English.
 * @param locale - The locale.
 * @param key - The dot-notation key.
 * @returns The string, or undefined when that file lacks it.
 */
function raw(locale: string, key: string): string | undefined {
  let at: unknown = MESSAGES.get(locale);
  for (const part of key.split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === 'string' ? at : undefined;
}

/** The generate nodes an input feeds: the anchor when it names none. */
const feedsOf = (template: GenerationTemplate, input: GenerationTemplate['inputs'][number]): readonly string[] =>
  input.feeds ?? [template.anchor];

/** A template's generate nodes. */
const generateNodes = (template: GenerationTemplate): TemplateGenerateNode[] =>
  template.nodes.filter((node): node is TemplateGenerateNode => node.role === 'generate');

/** A template's anchor node. */
const anchorOf = (template: GenerationTemplate): TemplateGenerateNode | undefined =>
  generateNodes(template).find((node) => node.key === template.anchor);

const textKey = (template: GenerationTemplate, rest: string): string => `canvas.template.${template.id}.${rest}`;

/**
 * Where a generate node's words live under the template's locale entry: one
 * key per shot (`shot.<n>`, from 1) for a node with shots, else its prompt;
 * the anchor's sit at the template's top, the others under `node.<key>`.
 * @param template - The template.
 * @param node - The generate node.
 * @returns The keys under `canvas.template.<id>`, in order.
 */
const wordKeysOf = (template: GenerationTemplate, node: TemplateGenerateNode): string[] => {
  const head = node.key === template.anchor ? '' : `node.${node.key}.`;
  return node.shots === undefined ? [`${head}prompt`] : node.shots.map((_, at) => `${head}shot.${String(at + 1)}`);
};

/**
 * A generate node's words in one language as the locale file holds them,
 * every shot's in order for a node with shots, else its prompt.
 * @param locale - The locale.
 * @param template - The template.
 * @param node - The generate node.
 * @returns Its segments.
 */
const wordsOf = (locale: string, template: GenerationTemplate, node: TemplateGenerateNode): ReturnType<typeof markedSegments> =>
  wordKeysOf(template, node).flatMap((rest) => markedSegments(raw(locale, textKey(template, rest)) ?? ''));

/**
 * The kinds of marks a prompt carries, in order.
 * @param text - The prompt.
 * @returns One entry per mark.
 */
const marksOf = (text: string): string[] => markedSegments(text).flatMap((s) => (s.slot ? [s.slot.kind] : []));

/**
 * The names a generate node's reference marks may use in one language: each
 * input feeding its pool (an input with `into` goes into a slot instead) and
 * each template node wired into its pool.
 * @param locale - The locale.
 * @param template - The template.
 * @param key - The generate node.
 * @returns The names.
 */
const poolNamesOf = (locale: string, template: GenerationTemplate, key: string): Array<string | undefined> => [
  ...template.inputs
    .filter((input) => feedsOf(template, input).includes(key) && input.into === undefined)
    .map((input) => raw(locale, textKey(template, `input.${input.key}.name`))),
  ...template.edges
    .filter((edge) => edge.to === key && (edge.into ?? 'pool') === 'pool')
    .map((edge) => raw(locale, textKey(template, `node.${edge.from}.name`))),
];

/**
 * A circle among a template's edges, walked depth first.
 * @param template - The template.
 * @returns The keys around the first circle found, back to where it starts, or undefined.
 */
function circleIn(template: GenerationTemplate): string[] | undefined {
  const done = new Set<string>();
  /**
   * Walk on from one key along the path that led to it.
   * @param path - The keys from the start to here.
   * @returns The circle, or undefined.
   */
  const walk = (path: string[]): string[] | undefined => {
    const at = path[path.length - 1] as string;
    for (const edge of template.edges.filter((one) => one.from === at)) {
      const back = path.indexOf(edge.to);
      if (back >= 0) return [...path.slice(back), edge.to];
      if (done.has(edge.to)) continue;
      const found = walk([...path, edge.to]);
      if (found) return found;
    }
    done.add(at);
    return undefined;
  };
  for (const edge of template.edges) {
    const found = done.has(edge.from) ? undefined : walk([edge.from]);
    if (found) return found;
  }
  return undefined;
}

afterEach(() => {
  setLocale('en');
});

/** The two templates that came over from the old preset shape: one anchor fed by one reference. */
const MIGRATED = ['costume-sheet', 'storyboard-grid-25'];

/** The social hook templates (inner#1816), in registry order. */
const SOCIAL_HOOKS = [
  'pet-selfie-vlog',
  'phone-vlog-realism',
  'retro-found-footage',
  'time-freeze-rewind',
  'bullet-time-mishap',
  'beat-sync-outfit-change',
  'pov-continuous-shot',
  'carried-object-transition',
  'fisheye-clone-pov',
  'flash-photo-dump-grid',
  'game-ui-livestream',
  'travel-city-walk',
  'twist-comedy-skit',
  'vertical-15s-quick-tip',
];

/** The social hook templates a video panel lists. */
const SOCIAL_HOOK_VIDEOS = SOCIAL_HOOKS.filter((id) => id !== 'fisheye-clone-pov' && id !== 'flash-photo-dump-grid');

/** The sound, music and voice templates (inner#1825), in registry order. */
const SOUND = [
  'ambience-sfx-bed',
  'voice-line',
  'two-voice-dialogue',
  'underscore-bgm',
  'voice-from-descriptor',
  'song-cover',
  'voice-clone-line',
  'score-for-my-video',
  'music-mood-from-image',
  'clip-ambience-foley',
  'section-mapped-score',
];

/** The sound templates an audio panel lists: all but the one anchored on its video. */
const SOUND_AUDIO = SOUND.filter((id) => id !== 'clip-ambience-foley');

/** The templates the plan's G13 and G19 give no case for offering unasked. */
const NEVER_OFFERED_UNASKED = ['retro-found-footage', 'pov-continuous-shot', 'fisheye-clone-pov', 'flash-photo-dump-grid', 'game-ui-livestream', 'song-cover'];

/**
 * The template nodes a generate node's words carry a note for, counted the
 * way the agent's check counts them (domain `notesAsked`): each generate node
 * wired into its pool, empty until it is generated, and each node wired into
 * one of its slots, which the user picks there.
 * @param template - The template.
 * @param key - The node.
 * @returns Their keys.
 */
const notedArrivals = (template: GenerationTemplate, key: string): string[] =>
  template.edges
    .filter((edge) => edge.to === key)
    .filter((edge) => (edge.into ?? 'pool') !== 'pool' || generateNodes(template).some((node) => node.key === edge.from))
    .map((edge) => edge.from);

/** The video and image models of the catalog, by name, as `config/models` declares them. */
const CATALOG = new Map(
  ['video', 'image'].flatMap((kind) => {
    const file = resolve(import.meta.dirname, `../../../../../config/models/${kind}/models.yaml`);
    const { models } = parse(readFileSync(file, 'utf-8')) as { models: Array<{ name: string; params: Record<string, ParamDescriptor> }> };
    return models.map((model): [string, Record<string, ParamDescriptor>] => [model.name, model.params]);
  }),
);

/** One catalog model as a template check reads it: the modes it runs in and its params. */
interface CatalogModel {
  mode: string | string[];
  params: Record<string, ParamDescriptor>;
}

/** Every model of the catalog, by name, as `config/models` declares them. */
const MODELS = new Map(
  ['video', 'image', 'audio', 'tts'].flatMap((kind) => {
    const file = resolve(import.meta.dirname, `../../../../../config/models/${kind}/models.yaml`);
    const { models } = parse(readFileSync(file, 'utf-8')) as { models: Array<CatalogModel & { name: string }> };
    return models.map((model): [string, CatalogModel] => [model.name, model]);
  }),
);

/**
 * Checks that a template has every string it needs in all five languages, the
 * names within the node name cap and a node with shots with no prompt.
 * @param template - The template.
 */
function expectEveryString(template: GenerationTemplate): void {
  const names = [
    'name',
    ...template.nodes.filter((node) => node.key !== template.anchor).map((node) => `node.${node.key}.name`),
    ...template.inputs.map((input) => `input.${input.key}.name`),
  ];
  const keys = [
    ...names,
    'description',
    ...generateNodes(template).flatMap((node) => wordKeysOf(template, node)),
    ...template.inputs.map((input) => `input.${input.key}.note`),
    ...template.steps.map((step) => `step.${step}`),
  ];
  for (const locale of LOCALES) {
    for (const key of keys) {
      const text = raw(locale, textKey(template, key));
      expect(typeof text === 'string' && text.length > 0, `${template.id} ${locale} ${key}`).toBe(true);
    }
    for (const key of names) {
      const length = [...(raw(locale, textKey(template, key)) ?? '')].length;
      expect(length, `${template.id} ${locale} ${key}`).toBeLessThanOrEqual(MAX_NODE_NAME_LEN);
    }
    // A node with shots has its words in the shots alone.
    for (const node of generateNodes(template).filter((one) => one.shots !== undefined)) {
      const prompt = node.key === template.anchor ? 'prompt' : `node.${node.key}.prompt`;
      expect(raw(locale, textKey(template, prompt)), `${template.id} ${locale} ${prompt}`).toBeUndefined();
    }
  }
}

describe('generation templates', () => {
  it('lists each node type its templates in registry order, the sound ones under audio and the foley clip under video', () => {
    expect(templatesFor('image').map((t) => t.id)).toEqual([
      'costume-sheet',
      'character-bible',
      'expression-sheet',
      'character-design-from-text',
      'storyboard-grid-25',
      'fisheye-clone-pov',
      'flash-photo-dump-grid',
    ]);
    expect(templatesFor('video').map((t) => t.id)).toEqual([
      'single-view-refs-scene',
      'identity-locked-sequence',
      'character-showcase-orbit',
      ...SOCIAL_HOOK_VIDEOS,
      'clip-ambience-foley',
    ]);
    // inner#1825 changes this contract: audio had no template until the sound goal.
    expect(templatesFor('audio').map((t) => t.id)).toEqual(SOUND_AUDIO);
  });

  it('fixes the mode, model and the params the real runs settled on', () => {
    const NANO = 'nano-banana-pro-edit-ultra';
    const MINIMAX = 'minimax-h3-reference-to-video';
    const QWEN = 'qwen-image-edit-multiple-angles';
    const T2V = 'seedance-2.5-text-to-video';
    const I2V = 'seedance-2.5-image-to-video';
    /**
     * A one-node text-to-video template's anchor, 9:16 with sound unless told otherwise.
     * @param duration - Its seconds.
     * @param aspect - Its ratio.
     * @returns The anchor's settings.
     */
    const t2v = (duration: number, aspect = '9:16'): Record<string, Pick<TemplateGenerateNode, 'type' | 'mode' | 'model' | 'params' | 'shots'>> => ({
      result: { type: 'video', mode: 't2v', model: T2V, params: { aspect_ratio: aspect, duration, generate_audio: true } },
    });
    const expected: Record<string, Record<string, Pick<TemplateGenerateNode, 'type' | 'mode' | 'model' | 'params' | 'shots'>>> = {
      'storyboard-grid-25': { result: { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '1:1', resolution: '4k' } } },
      'costume-sheet': { result: { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '16:9', resolution: '4k' } } },
      'character-bible': { result: { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '4:3', resolution: '4k' } } },
      'expression-sheet': { result: { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '16:9', resolution: '4k' } } },
      'character-design-from-text': {
        design: { type: 'image', mode: 't2i', model: 'gpt-image-2.5-sunburst-text-to-image', params: { aspect_ratio: '3:4' } },
        result: { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '4:3', resolution: '4k' } },
      },
      'single-view-refs-scene': {
        front: { type: 'image', mode: 'i2i', model: QWEN, params: { horizontal_angle: 0 } },
        side: { type: 'image', mode: 'i2i', model: QWEN, params: { horizontal_angle: 90 } },
        back: { type: 'image', mode: 'i2i', model: QWEN, params: { horizontal_angle: 180 } },
        result: {
          type: 'video',
          mode: 't2v',
          model: 'seedance-2.5-text-to-video',
          params: { aspect_ratio: '16:9', duration: 10, generate_audio: true },
        },
      },
      'identity-locked-sequence': { result: { type: 'video', mode: 'ref', model: MINIMAX, params: { aspect_ratio: '16:9', duration: 8 } } },
      'character-showcase-orbit': { result: { type: 'video', mode: 'ref', model: MINIMAX, params: { aspect_ratio: '16:9', duration: 6 } } },
      'pet-selfie-vlog': t2v(10),
      'phone-vlog-realism': t2v(15),
      'retro-found-footage': t2v(10, '4:3'),
      'time-freeze-rewind': t2v(20),
      'bullet-time-mishap': t2v(8),
      'beat-sync-outfit-change': t2v(12),
      'pov-continuous-shot': t2v(12),
      'carried-object-transition': {
        'scene-a': { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '9:16' } },
        'scene-b': { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '9:16' } },
        result: { type: 'video', mode: 'first_last', model: I2V, params: { duration: 5, generate_audio: true } },
      },
      'fisheye-clone-pov': { result: { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '4:5' } } },
      'flash-photo-dump-grid': { result: { type: 'image', mode: 'i2i', model: NANO, params: { aspect_ratio: '3:4' } } },
      'game-ui-livestream': t2v(12, '9:16'),
      'travel-city-walk': t2v(24),
      'twist-comedy-skit': t2v(15),
      'vertical-15s-quick-tip': {
        result: {
          type: 'video',
          mode: 'multi_shot',
          model: T2V,
          params: { aspect_ratio: '9:16', duration: 15, generate_audio: true },
          shots: [{ seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }],
        },
      },
    };
    // The sound templates' settings are checked key by key under their own describe below.
    expect(GENERATION_TEMPLATES.map((template) => template.id).sort()).toEqual([...Object.keys(expected), ...SOUND].sort());
    for (const template of GENERATION_TEMPLATES) {
      expect(template.anchor, template.id).toBe('result');
      if (SOUND.includes(template.id)) continue;
      const nodes = Object.fromEntries(
        generateNodes(template).map(({ key, type, mode, model, params, shots }) => [key, { type, mode, model, params, ...(shots === undefined ? {} : { shots }) }]),
      );
      expect(nodes, template.id).toEqual(expected[template.id]);
    }
  });

  it('feeds the single-view input into the three views and the scene, each view wired into the scene pool', () => {
    const scene = byId('single-view-refs-scene');
    if (!scene) throw new Error('template missing');
    expect(scene.inputs).toEqual([{ key: 'reference', type: 'image', feeds: ['front', 'side', 'back', 'result'] }]);
    expect(scene.edges).toEqual([
      { from: 'front', to: 'result', into: 'pool' },
      { from: 'side', to: 'result', into: 'pool' },
      { from: 'back', to: 'result', into: 'pool' },
    ]);
    const design = byId('character-design-from-text');
    if (!design) throw new Error('template missing');
    expect(design.inputs).toEqual([]);
    expect(design.edges).toEqual([{ from: 'design', to: 'result', into: 'pool' }]);
  });

  it('names the into of every template edge, as the anchor models take a picture more than one way', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const edge of template.edges) expect(edge.into, `${template.id} ${edge.from}`).toBeDefined();
    }
  });

  it('gives every generate node words in every interface language that @ everything wired into its pool at least once, with a note for each upstream generation in its pool and each node going into its slots', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of LOCALES) {
        for (const node of generateNodes(template)) {
          const words = wordsOf(locale, template, node);
          const slots = words.flatMap((s) => (s.slot ? [s.slot.kind] : []));
          const labels = new Set(words.flatMap((s) => (s.slot?.kind === 'asset' ? [s.slot.label] : [])));
          const where = `${template.id} ${locale} ${node.key}`;
          for (const name of poolNamesOf(locale, template, node.key)) expect(name !== undefined && labels.has(name), `${where} @s ${String(name)}`).toBe(true);
          expect(slots.filter((kind) => kind === 'note'), where).toHaveLength(notedArrivals(template, node.key).length);
          if (MIGRATED.includes(template.id) && node.key === template.anchor) expect(slots, where).toEqual(['asset', 'tweak']);
        }
      }
    }
  });

  it('writes the prompt in the user’s language', () => {
    const grid = byId('storyboard-grid-25');
    if (!grid) throw new Error('grid template missing');
    const anchor = anchorOf(grid);
    if (!anchor) throw new Error('grid anchor missing');
    const text = (locale: string): string =>
      wordsOf(locale, grid, anchor)
        .map((s) => s.text ?? '')
        .join('');
    expect(text('zh-CN')).toContain('5 行 5 列');
    expect(text('en')).toContain('5 rows and 5 columns');
  });

  it('migrates both templates to one anchor fed by one reference input, with no resource, edge or step', () => {
    for (const template of GENERATION_TEMPLATES.filter((one) => MIGRATED.includes(one.id))) {
      const skeleton = templateSkeleton(template);
      expect(skeleton.nodes, template.id).toEqual(new Map([[template.anchor, { role: 'generate', type: 'image' }]]));
      expect(skeleton.edges, template.id).toEqual([]);
      expect(skeleton.inputs, template.id).toEqual([{ key: 'reference', type: 'image', feeds: [template.anchor] }]);
      expect(skeleton.steps, template.id).toEqual([]);
    }
  });

  it('names the two migrated templates\' reference input after the label its mark carried', () => {
    expect(raw('en', 'canvas.template.storyboard-grid-25.input.reference.name')).toBe('Character or scene');
    expect(raw('en', 'canvas.template.costume-sheet.input.reference.name')).toBe('Character');
  });

  it('names in a generate node\'s reference marks only what is wired into its pool, by its name, in every language', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of LOCALES) {
        for (const node of generateNodes(template)) {
          const labels = new Set(wordsOf(locale, template, node).flatMap((s) => (s.slot?.kind === 'asset' ? [s.slot.label] : [])));
          const names = new Set(poolNamesOf(locale, template, node.key));
          expect([...labels].sort(), `${template.id} ${locale} ${node.key}`).toEqual([...names].sort());
        }
      }
    }
  });
});

describe('creative goals and triggers', () => {
  it('lists the goals the registry uses, in panel order', () => {
    expect([...TEMPLATE_GOALS]).toEqual(['character', 'comics-storyboards', 'social-hooks', 'sound']);
  });

  it('gives every template a known goal and words the user asks for it with, and words for when to offer it unless it has none', () => {
    const goals: Record<string, string> = {
      ...Object.fromEntries(SOCIAL_HOOKS.map((id) => [id, 'social-hooks'])),
      ...Object.fromEntries(SOUND.map((id) => [id, 'sound'])),
      'storyboard-grid-25': 'comics-storyboards',
      'costume-sheet': 'character',
      'character-bible': 'character',
      'expression-sheet': 'character',
      'character-design-from-text': 'character',
      'single-view-refs-scene': 'character',
      'identity-locked-sequence': 'character',
      'character-showcase-orbit': 'character',
    };
    for (const template of GENERATION_TEMPLATES) {
      expect(template.goal, template.id).toBe(goals[template.id]);
      expect(template.triggers.asks.length, `${template.id} asks`).toBeGreaterThan(0);
      // The plan's G13 and G19 write "none" for when to offer these unasked.
      expect(template.triggers.offerWhen.length === 0, `${template.id} offerWhen`).toBe(NEVER_OFFERED_UNASKED.includes(template.id));
      for (const words of [...template.triggers.asks, ...template.triggers.offerWhen]) {
        expect(words.trim().length, template.id).toBeGreaterThan(0);
      }
    }
  });

  it('uses every goal it lists, so no goal row opens on nothing', () => {
    for (const goal of TEMPLATE_GOALS) {
      expect(GENERATION_TEMPLATES.some((template) => template.goal === goal), goal).toBe(true);
    }
  });

  it('names every goal in all five languages', () => {
    for (const goal of TEMPLATE_GOALS) {
      for (const locale of LOCALES) {
        const name = raw(locale, `canvas.template.goal.${goal}`);
        expect(typeof name === 'string' && name.length > 0, `${goal} ${locale}`).toBe(true);
      }
    }
  });

  it('names the social hooks goal without a medium, as it holds image templates as well as video ones', () => {
    const NAMES: Record<string, string> = { en: 'Social hooks', 'zh-CN': '社媒钩子', 'zh-TW': '社群鉤子', ja: 'SNS フック', ko: 'SNS 후킹' };
    expect(Object.keys(NAMES).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) expect(raw(locale, 'canvas.template.goal.social-hooks'), locale).toBe(NAMES[locale]);
  });

  it('groups a node type\'s templates under their goals in goal order, leaving out goals with none', () => {
    expect(templateGoalsFor('image').map(({ goal, templates }) => [goal, templates.map((one) => one.id)])).toEqual([
      ['character', ['costume-sheet', 'character-bible', 'expression-sheet', 'character-design-from-text']],
      ['comics-storyboards', ['storyboard-grid-25']],
      ['social-hooks', ['fisheye-clone-pov', 'flash-photo-dump-grid']],
    ]);
    expect(templateGoalsFor('video').map(({ goal, templates }) => [goal, templates.map((one) => one.id)])).toEqual([
      ['character', ['single-view-refs-scene', 'identity-locked-sequence', 'character-showcase-orbit']],
      ['social-hooks', SOCIAL_HOOK_VIDEOS],
      ['sound', ['clip-ambience-foley']],
    ]);
    expect(templateGoalsFor('audio').map(({ goal, templates }) => [goal, templates.map((one) => one.id)])).toEqual([['sound', SOUND_AUDIO]]);
  });
});

describe('generation template registry checks', () => {
  it('carries the same marks in the same order in every language, for every template prompt', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const key of generateNodes(template).flatMap((node) => wordKeysOf(template, node).map((rest) => textKey(template, rest)))) {
        const reference = marksOf(raw('en', key) ?? '');
        for (const locale of LOCALES) expect(marksOf(raw(locale, key) ?? ''), `${key} ${locale}`).toEqual(reference);
      }
    }
  });

  it('names no frame in a template\'s agent note but the one its aspect ratio gives', () => {
    for (const template of GENERATION_TEMPLATES) {
      const anchor = template.nodes.find((node) => node.key === template.anchor);
      if (anchor?.role !== 'generate') continue;
      // With no ratio of its own, a video takes the frame of the node wired into its first frame.
      const first = anchor.type === 'video' ? template.edges.find((edge) => edge.to === anchor.key && edge.into === 'image') : undefined;
      const feeder = template.nodes.find((node) => node.key === first?.from);
      const ratio = anchor.params.aspect_ratio ?? (feeder?.role === 'generate' ? feeder.params.aspect_ratio : undefined);
      const sides = typeof ratio === 'string' ? /^(\d+):(\d+)$/.exec(ratio) : null;
      if (sides === null) continue;
      const [width, height] = [Number(sides[1]), Number(sides[2])];
      const note = template.agentNote;
      const at = `${template.id} ${String(ratio)}: ${note}`;
      for (const literal of note.match(/\b\d+:\d+\b/g) ?? []) expect.soft(literal, at).toBe(ratio);
      if (width <= height) expect.soft(note, at).not.toMatch(/landscape|horizontal|widescreen/i);
      if (height <= width) expect.soft(note, at).not.toMatch(/vertical|portrait/i);
    }
  });

  it('keeps template ids, node keys and input keys unique, and no node takes the guide key', () => {
    const ids = GENERATION_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const template of GENERATION_TEMPLATES) {
      const nodeKeys = template.nodes.map((node) => node.key);
      const inputKeys = template.inputs.map((input) => input.key);
      expect(new Set(nodeKeys).size, template.id).toBe(nodeKeys.length);
      expect(new Set(inputKeys).size, template.id).toBe(inputKeys.length);
      expect(nodeKeys, template.id).not.toContain(TEMPLATE_GUIDE_KEY);
    }
  });

  it('anchors every template on a generate node, every other node upstream of it, downstream of it or wired to nothing', () => {
    // inner#1825 replaces the rule that every node reaches the anchor: a node
    // may also follow the anchor, or stand beside it with no template edge.
    const placed = { upstream: 0, downstream: 0, standalone: 0 };
    for (const template of GENERATION_TEMPLATES) {
      expect(anchorOf(template)?.key, template.id).toBe(template.anchor);
      const upstream = new Set([template.anchor]);
      const downstream = new Set([template.anchor]);
      for (let pass = 0; pass < template.nodes.length; pass += 1) {
        for (const edge of template.edges) {
          if (upstream.has(edge.to)) upstream.add(edge.from);
          if (downstream.has(edge.from)) downstream.add(edge.to);
        }
      }
      for (const node of template.nodes) {
        if (node.key === template.anchor) continue;
        const wired = template.edges.some((edge) => edge.from === node.key || edge.to === node.key);
        const where = upstream.has(node.key) ? 'upstream' : downstream.has(node.key) ? 'downstream' : wired ? undefined : 'standalone';
        expect(where, `${template.id} ${node.key}`).toBeDefined();
        if (where) placed[where] += 1;
      }
    }
    expect(placed.downstream, 'a template has a node downstream of its anchor, so the rule runs on one').toBeGreaterThan(0);
    expect(placed.standalone, 'a template has a node with no template edge, so the rule runs on one').toBeGreaterThan(0);
  });

  it('wires its nodes with no circle, as a canvas takes no edge that closes one', () => {
    for (const template of GENERATION_TEMPLATES) {
      expect(circleIn(template), template.id).toBeUndefined();
    }
  });

  it('finds the circle in edges that run in one', () => {
    const circle = { ...(byId('costume-sheet') as GenerationTemplate), edges: [{ from: 'u', to: 'v' }, { from: 'v', to: 'u' }] };
    expect(circleIn(circle)).toEqual(['u', 'v', 'u']);
  });

  it('wires template edges between keys it has and feeds inputs only into generate nodes', () => {
    for (const template of GENERATION_TEMPLATES) {
      const keys = template.nodes.map((node) => node.key);
      for (const edge of template.edges) {
        expect(keys, `${template.id} ${edge.from}`).toContain(edge.from);
        expect(keys, `${template.id} ${edge.to}`).toContain(edge.to);
      }
      const generate = generateNodes(template).map((node) => node.key);
      for (const input of template.inputs) {
        for (const fed of feedsOf(template, input)) expect(generate, `${template.id} ${input.key}`).toContain(fed);
      }
    }
  });

  it('binds every reference mark to exactly one target of its node by name, the targets named apart, in every language', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of LOCALES) {
        setLocale(locale);
        for (const node of generateNodes(template)) {
          // The same reading the panel and the agent bind marks with.
          const targets = templateMarkTargets(template, node.key);
          const contributors =
            template.inputs.filter((input) => feedsOf(template, input).includes(node.key) && input.into === undefined).length +
            template.edges.filter((edge) => edge.to === node.key && (edge.into ?? 'pool') === 'pool').length;
          const where = `${template.id} ${locale} ${node.key}`;
          expect(targets.size, `${where}: targets named apart`).toBe(contributors);
          const labels = wordsOf(locale, template, node).flatMap((s) => (s.slot?.kind === 'asset' ? [s.slot.label] : []));
          for (const label of labels) expect(targets.has(label), `${where} ${label}`).toBe(true);
        }
      }
    }
  });

  it('keeps every resource under templates/<its template id>/', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const node of template.nodes) {
        if (node.role !== 'source') continue;
        expect(node.resource, `${template.id} ${node.key}`).toMatch(
          new RegExp(`^templates/${template.id}/[A-Za-z0-9][A-Za-z0-9._-]*\\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a)$`),
        );
      }
    }
  });

  it('has every string in all five languages, the names within the node name cap', () => {
    for (const template of GENERATION_TEMPLATES) expectEveryString(template);
  });
});

describe('social hook templates (inner#1816)', () => {
  it('feeds each its user inputs and wires the carried object through two scenes into the first and last frame', () => {
    const expected: Record<string, { inputs: Array<{ key: string; type: string; feeds: readonly string[] }>; edges: GenerationTemplate['edges'] }> = {
      'pet-selfie-vlog': { inputs: [{ key: 'pet', type: 'image', feeds: ['result'] }], edges: [] },
      'phone-vlog-realism': { inputs: [{ key: 'person', type: 'image', feeds: ['result'] }], edges: [] },
      'retro-found-footage': { inputs: [], edges: [] },
      'time-freeze-rewind': { inputs: [{ key: 'person', type: 'image', feeds: ['result'] }], edges: [] },
      'bullet-time-mishap': { inputs: [], edges: [] },
      'beat-sync-outfit-change': { inputs: [{ key: 'person', type: 'image', feeds: ['result'] }], edges: [] },
      'pov-continuous-shot': { inputs: [], edges: [] },
      'carried-object-transition': {
        inputs: [{ key: 'object', type: 'image', feeds: ['scene-a', 'scene-b'] }],
        edges: [
          { from: 'scene-a', to: 'result', into: 'image' },
          { from: 'scene-b', to: 'result', into: 'end_image' },
        ],
      },
      'fisheye-clone-pov': { inputs: [{ key: 'subject', type: 'image', feeds: ['result'] }], edges: [] },
      'flash-photo-dump-grid': { inputs: [{ key: 'person', type: 'image', feeds: ['result'] }], edges: [] },
      'game-ui-livestream': { inputs: [{ key: 'character', type: 'image', feeds: ['result'] }], edges: [] },
      'travel-city-walk': { inputs: [{ key: 'traveler', type: 'image', feeds: ['result'] }], edges: [] },
      'twist-comedy-skit': { inputs: [{ key: 'character', type: 'image', feeds: ['result'] }], edges: [] },
      'vertical-15s-quick-tip': { inputs: [{ key: 'subject', type: 'image', feeds: ['result'] }], edges: [] },
    };
    for (const id of SOCIAL_HOOKS) {
      const template = byId(id);
      expect(template, id).toBeDefined();
      if (!template) continue;
      expect(template.inputs.map((input) => ({ key: input.key, type: input.type, feeds: feedsOf(template, input) })), id).toEqual(expected[id]?.inputs);
      expect(template.edges, id).toEqual(expected[id]?.edges);
      expect(template.steps, id).toEqual([]);
    }
  });

  it('notes in the transition both scenes going into the first and last frame, and @s neither, in every language', () => {
    const template = byId('carried-object-transition');
    const anchor = template && anchorOf(template);
    if (!template || !anchor) throw new Error('carried-object-transition missing');
    for (const locale of LOCALES) {
      const kinds = wordsOf(locale, template, anchor).flatMap((s) => (s.slot ? [s.slot.kind] : []));
      expect(kinds.filter((kind) => kind === 'note'), locale).toHaveLength(2);
      expect(kinds.filter((kind) => kind === 'asset'), locale).toEqual([]);
    }
  });

  it('names the frame slot a note picks a node into the way the panel\'s button does, in every language', () => {
    // The video panel's button label for each slot, by the `into` it fills
    // (web `video-slots.ts`). `image` is the First frame button only in the
    // modes that draw it (web `video-mode-options.ts`); image animation and
    // talking head draw a character image slot there instead.
    const FIRST_FRAME_MODES = ['i2v', 'first_last', 'multi_shot'];
    const labelKeyOf = (node: TemplateGenerateNode, into: string | undefined): string | undefined => {
      if (node.type !== 'video') return undefined;
      if (into === 'end_image') return 'canvas.generatePanel.endFrame';
      if (into === 'image' && FIRST_FRAME_MODES.includes(node.mode)) return 'canvas.generatePanel.firstFrame';
      return undefined;
    };
    let checked = 0;
    for (const template of GENERATION_TEMPLATES) {
      for (const node of generateNodes(template)) {
        for (const edge of template.edges.filter((one) => one.to === node.key)) {
          const labelKey = labelKeyOf(node, edge.into);
          if (labelKey === undefined) continue;
          checked += 1;
          for (const locale of LOCALES) {
            const label = raw(locale, labelKey);
            const notes = wordsOf(locale, template, node).flatMap((s) => (s.slot?.kind === 'note' ? [s.slot.label] : []));
            const where = `${template.id} ${locale} ${node.key} <- ${edge.from} into ${String(edge.into)}`;
            expect(label, `${where}: ${labelKey}`).toBeDefined();
            expect(notes.some((note) => note.includes(label ?? '')), `${where}: a note says "${String(label)}" in ${JSON.stringify(notes)}`).toBe(true);
          }
        }
      }
    }
    expect(checked, 'a template wires a node into a frame slot, so the check runs on something').toBeGreaterThan(0);
  });

  it('gives every ✏️ tweak in the quick tip\'s shots an example, as the first shot\'s has, in every language', () => {
    const EXAMPLE: Record<string, string> = { en: 'e.g.', 'zh-CN': '例如', 'zh-TW': '例如', ja: '例：', ko: '예:' };
    expect(Object.keys(EXAMPLE).sort()).toEqual([...LOCALES].sort());
    const template = byId('vertical-15s-quick-tip');
    const anchor = template && anchorOf(template);
    if (!template || !anchor) throw new Error('vertical-15s-quick-tip missing');
    for (const locale of LOCALES) {
      for (const rest of wordKeysOf(template, anchor)) {
        const tweaks = markedSegments(raw(locale, textKey(template, rest)) ?? '').flatMap((s) => (s.slot?.kind === 'tweak' ? [s.slot.label] : []));
        for (const tweak of tweaks) expect.soft(tweak, `${locale} ${rest}`).toContain(EXAMPLE[locale]);
      }
    }
  });

  it('@s the quick tip\'s subject in every one of its five shots, in every language', () => {
    const template = byId('vertical-15s-quick-tip');
    const anchor = template && anchorOf(template);
    if (!template || !anchor) throw new Error('vertical-15s-quick-tip missing');
    expect(anchor.shots).toHaveLength(5);
    for (const locale of LOCALES) {
      const subject = raw(locale, textKey(template, 'input.subject.name'));
      for (const rest of wordKeysOf(template, anchor)) {
        const labels = markedSegments(raw(locale, textKey(template, rest)) ?? '').flatMap((s) => (s.slot?.kind === 'asset' ? [s.slot.label] : []));
        expect(labels, `${locale} ${rest}`).toContain(subject);
      }
    }
  });
});

describe('template shot lists (inner#1816, CAP-2)', () => {
  it('gives a generate node shots exactly when it runs in the multi_shot mode', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const node of generateNodes(template)) {
        expect(node.shots !== undefined, `${template.id} ${node.key}`).toBe(node.mode === MULTI_SHOT_MODE);
      }
    }
  });

  it('has at least one template with a shot list, so the checks below run on something', () => {
    expect(GENERATION_TEMPLATES.flatMap((template) => generateNodes(template)).some((node) => node.shots !== undefined)).toBe(true);
  });

  it('adds the shots up to the node\'s duration, each a length its model takes, no more shots than its model takes', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const node of generateNodes(template)) {
        if (node.shots === undefined) continue;
        const where = `${template.id} ${node.key}`;
        const params = CATALOG.get(node.model);
        expect(params, `${where}: ${node.model} in the catalog`).toBeDefined();
        if (!params) continue;
        const spec = storyboardSpec(params, node.mode);
        expect(spec?.secondsField, `${where}: a shot length`).toBeDefined();
        if (!spec?.secondsField) continue;
        const lengths = params[spec.shotsParam]?.fields?.[spec.secondsField]?.values ?? [];
        expect(node.shots.reduce((sum, shot) => sum + shot.seconds, 0), where).toBe(node.params[spec.totalParam ?? 'duration']);
        for (const shot of node.shots) expect(lengths, `${where} ${String(shot.seconds)} s`).toContain(shot.seconds);
        expect(node.shots.length, where).toBeGreaterThan(0);
        expect(node.shots.length, where).toBeLessThanOrEqual(spec.maxShots);
      }
    }
  });
});

describe('character template layouts (inner#1846)', () => {
  const SHEET_LABELS = [
    'NAME', 'ROLE', 'AGE', 'PERSONALITY', 'THEME', 'COLOR PALETTE', 'MAIN VIEWS', 'FRONT', '3/4', 'SIDE', 'BACK',
    'SILHOUETTE', 'CLOSE-UP', 'EXPRESSIONS', 'MICRO-EXPRESSIONS', 'HEAD ANGLES', 'POSES', 'COSTUME DETAILS', 'HANDS',
  ];
  const EXPRESSION_LABELS = ['EXPRESSIONS', 'MICRO-EXPRESSIONS', 'HEAD ANGLES'];
  const SHEET_PROMPTS = ['canvas.template.character-bible.prompt', 'canvas.template.character-design-from-text.prompt'];
  const EXPRESSION_PROMPT = 'canvas.template.expression-sheet.prompt';

  /**
   * Whether a text gives these panel counts in this order, read as whole numbers so 48% is not an 8.
   * @param text - The prompt.
   * @param counts - The counts, in the order the rows give them.
   * @returns True when every count turns up after the one before it.
   */
  const givesInOrder = (text: string, counts: readonly number[]): boolean => {
    let next = 0;
    // A view label such as 3/4 is not a count.
    for (const n of (text.replace(/\d+\/\d+/g, '').match(/\d+/g) ?? []).map(Number)) if (n === counts[next]) next += 1;
    return next === counts.length;
  };

  it('names every section of the character sheet with its English label in every language', () => {
    for (const key of SHEET_PROMPTS) {
      for (const locale of LOCALES) {
        const text = raw(locale, key) ?? '';
        for (const label of SHEET_LABELS) expect(text, `${key} ${locale} ${label}`).toContain(label);
      }
    }
  });

  it('gives the character sheet exactly the panel counts of each row, in every language', () => {
    for (const key of SHEET_PROMPTS) {
      expect(raw('en', key), key).toMatch(/exactly 8 equal square swatches/);
      expect(raw('en', key), key).toMatch(/exactly 4 full-body figures/);
      expect(raw('en', key), key).toMatch(/Row 1, EXPRESSIONS, exactly 8 /);
      expect(raw('en', key), key).toMatch(/Row 2, exactly 9 panels/);
      expect(raw('en', key), key).toMatch(/Row 3, exactly 12 panels/);
      // Palette, main views, then the bottom rows: 8 expressions, 9 = 5 + 4, 12 = 3 + 4 + 5.
      for (const locale of LOCALES) expect(givesInOrder(raw(locale, key) ?? '', [8, 4, 8, 9, 5, 4, 12, 3, 4, 5]), `${key} ${locale}`).toBe(true);
    }
  });

  it('lays the expression sheet out as three labelled rows of 8, 5 and 4 equal panels, in every language', () => {
    const en = raw('en', EXPRESSION_PROMPT) ?? '';
    expect(en).toContain('Three full-width rows of exactly equal height');
    expect(en).toContain('the same margin on all four sides');
    expect(en).toMatch(/EXPRESSIONS, 8 panels/);
    expect(en).toMatch(/MICRO-EXPRESSIONS, 5 panels/);
    expect(en).toMatch(/HEAD ANGLES, the calm face in 4 panels/);
    for (const locale of LOCALES) {
      const text = raw(locale, EXPRESSION_PROMPT) ?? '';
      for (const label of EXPRESSION_LABELS) expect(text, `${locale} ${label}`).toContain(label);
      expect(givesInOrder(text, [8, 5, 4]), locale).toBe(true);
    }
  });

  it('locks the rendering on the sheet made from text, and leaves it to the picked style on the character bible', () => {
    expect(raw('en', 'canvas.template.character-bible.prompt')).not.toContain("reference's exact rendering");
    expect(raw('en', 'canvas.template.character-design-from-text.prompt')).toContain("Keep the reference's exact rendering");
  });

  it('tells the agent what to do when a face drifts and what to look for after an orbit', () => {
    expect(byId('identity-locked-sequence')?.agentNote).toContain('if the user says the face drifted, shorten it to 5 to 6 seconds, re-split the three timecodes to fit, and tighten the sentence that says it is the same person in all three shots');
    expect(byId('character-showcase-orbit')?.agentNote).toContain('when the user comes back with the result, check that it shows different sides of the character, not the character turning round');
  });

  it('keeps the inheritance list, the unseen-parts rule and the 180-degree orbit in every language', () => {
    // One phrase per clause in each language: the scene's inheritance list and its no-duplicates rule, the side view's unseen parts.
    const PHRASES: Record<string, [string, string, string]> = {
      en: ['every garment, the shoes and every accessory', 'no duplicates of the person', 'Build the parts the reference does not show'],
      'zh-CN': ['每一件衣服、鞋和每一件饰品', '不出现分身', '参考图里看不到的部分'],
      'zh-TW': ['每一件衣服、鞋子和每一件飾品', '不出現分身', '參考圖裡看不到的部分'],
      ja: ['すべての衣服、靴とすべてのアクセサリー', '人物を複製しない', '参照に写っていない部分'],
      ko: ['모든 옷, 신발과 모든 액세서리', '인물을 복제하지 않고', '참고 이미지에 보이지 않는 부분'],
    };
    expect(Object.keys(PHRASES).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      const [inherit, single, unseen] = PHRASES[locale]!;
      expect(raw(locale, 'canvas.template.single-view-refs-scene.prompt'), locale).toContain(inherit);
      expect(raw(locale, 'canvas.template.single-view-refs-scene.prompt'), locale).toContain(single);
      expect(raw(locale, 'canvas.template.single-view-refs-scene.node.side.prompt'), locale).toContain(unseen);
      expect(raw(locale, 'canvas.template.character-showcase-orbit.prompt'), locale).toContain('180');
    }
    // The ko orbit keeps its around-verb, so the camera circles the character rather than turning in place.
    expect(raw('ko', 'canvas.template.character-showcase-orbit.prompt')).toContain('캐릭터 주위를 180도 돌아');
  });

  it('keeps the silent scene free of speaking and the sheets to items worn, on the back or over a shoulder, in every language', () => {
    // The scene's same-face clause, and the sheets' main-views clause, in each language.
    const PHRASES: Record<string, [string, string]> = {
      en: ['The same face when turning, looking down or with a hand near the face', 'wearing everything the reference shows on the body, including anything on the back or over a shoulder'],
      'zh-CN': ['转身、低头、手靠近脸时都是同一张脸', '参考图里有的，身上穿戴的、背着的、挎在肩上的都画上，参考图里没有的不添加'],
      'zh-TW': ['轉身、低頭、手靠近臉時都是同一張臉', '參考圖裡有的，身上穿戴的、背著的、掛在肩上的都畫上，參考圖裡沒有的不添加'],
      ja: ['振り向いても、うつむいても、手が顔に近づいても同じ顔にする', '参照にある身に着けている物、背負っている物、肩に掛けている物はすべて描き、参照にない物は描き足さず'],
      ko: ['돌아설 때, 고개를 숙일 때, 손이 얼굴 가까이 있을 때도 같은 얼굴', '몸에 걸치거나 메고 있는 것을 모두 갖추고'],
    };
    expect(Object.keys(PHRASES).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      const [sameFace, carried] = PHRASES[locale]!;
      expect(raw(locale, 'canvas.template.single-view-refs-scene.prompt'), locale).toContain(sameFace);
      expect(raw(locale, 'canvas.template.character-bible.prompt'), locale).toContain(carried);
      expect(raw(locale, 'canvas.template.character-design-from-text.prompt'), locale).toContain(carried);
    }
  });

  it('joins the breathing note into one phrase, keeps labels to the section name and blending out of the faces, in every language', () => {
    // The breathing note, the sheets' label clause, and the scene's no-blending clause, in each language.
    const PHRASES: Record<string, [string, string, string]> = {
      en: ['controlled breathing (lips slightly parted while slowly exhaling)', 'a clear English label in small sans-serif capitals at the top left of each section named in capital letters below, written exactly as that name; the top text block and the bands themselves get no label', 'no blending of features'],
      'zh-CN': ['呼吸控制（嘴唇微张着缓缓呼气）', '下文用大写写出名字的每个区块，左上角一个清晰的英文小标签（只写那个大写的区块名，无衬线大写），顶部文字块和三条通栏本身不加标签', '不把五官混在一起'],
      'zh-TW': ['呼吸控制（嘴唇微張著緩緩吐氣）', '下文用大寫寫出名字的每個區塊，左上角一個清晰的英文小標籤（只寫那個大寫的區塊名，無襯線大寫），頂部文字塊和三條通欄本身不加標籤', '不把五官混在一起'],
      ja: ['抑えた呼吸（唇を少し開いてゆっくり息を吐く）', '以下で大文字の名前を示した各セクションの左上に、その名前をそのまま書いた、小さなサンセリフ大文字のはっきりした英語ラベル。上部のテキストブロックと横帯そのものにはラベルを付けない', '顔立ちを混ぜない'],
      ko: ['절제된 호흡(입술을 살짝 벌리고 천천히 내쉼)', '이 글에서 대문자로 이름을 적은 각 섹션 왼쪽 위에, 그 이름 그대로 적은, 작은 산세리프 대문자로 된 선명한 영어 라벨. 상단 텍스트 블록과 가로 띠 자체에는 라벨을 붙이지 않는다', '이목구비를 섞지 않는다'],
    };
    expect(Object.keys(PHRASES).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      const [breathing, label, unblended] = PHRASES[locale]!;
      for (const id of ['character-bible', 'expression-sheet', 'character-design-from-text']) {
        expect(raw(locale, `canvas.template.${id}.prompt`), `${locale} ${id}`).toContain(breathing);
      }
      for (const id of ['character-bible', 'character-design-from-text']) {
        expect(raw(locale, `canvas.template.${id}.prompt`), `${locale} ${id}`).toContain(label);
      }
      expect(raw(locale, 'canvas.template.single-view-refs-scene.prompt'), locale).toContain(unblended);
    }
  });

  it('writes the inheritance list, the shot and move fields and the orbit the sources ask for', () => {
    const scene = raw('en', 'canvas.template.single-view-refs-scene.prompt') ?? '';
    for (const part of ['identity', 'facial features', 'face shape', 'skin tone', 'apparent age', 'hairstyle and hair colour', 'height', 'build and body proportions', 'every garment', 'the shoes and every accessory', 'overall bearing', 'no duplicates of the person, no blending of features']) {
      expect(scene, part).toContain(part);
    }
    expect(scene).toContain('{✏️ name each garment, the shoes and each accessory}');
    for (const view of ['front', 'side', 'back']) {
      expect(raw('en', `canvas.template.single-view-refs-scene.node.${view}.prompt`), view).toContain('nothing redesigned, recoloured, added or removed');
    }
    // The side view's unseen-parts clause is checked in every language above.
    expect(raw('en', 'canvas.template.single-view-refs-scene.node.back.prompt')).toContain('Build the parts the reference does not show');
    const sequence = raw('en', 'canvas.template.identity-locked-sequence.prompt') ?? '';
    expect(sequence.match(/\{✏️ shot size and camera move/g)).toHaveLength(3);
    expect(sequence).toContain('no deformation, no drift, the face never changes');
    const orbit = raw('en', 'canvas.template.character-showcase-orbit.prompt') ?? '';
    expect(orbit).toContain("circles 180 degrees around the character's right side");
    expect(orbit).toContain('keeping the same distance, height and focal length');
    expect(orbit).toContain('The near things sweep past quickly and the far background moves slowly');
    const costume = raw('en', 'canvas.template.costume-sheet.prompt') ?? '';
    expect(costume).toContain('exactly 3 full-body figures of equal width');
    expect(costume).toContain('2 by 2 grid of exactly 4 equal close-up panels');
  });
});

describe('sound, music and voice templates (inner#1825)', () => {
  /** A generate node's settings as the design's table gives them; `params` lists only the ones it fixes. */
  type Settings = { type: string; mode: string; model: string; params?: Record<string, unknown> };
  const LYRIA = 'lyria-3-pro-music';
  /** Returns a full track of a few minutes whatever length is asked, which the user trims. */
  const MUREKA_BGM = 'mureka-v9.5-generate-bgm';
  /** Each template's anchor, as the design's section 9 gives it. */
  const ANCHORS: Record<string, Settings> = {
    'ambience-sfx-bed': { type: 'audio', mode: 'sfx', model: 'sfx-1.6-text-to-audio', params: { loop: true, duration: 30 } },
    'voice-line': { type: 'audio', mode: 'tts', model: 'minimax-speech-2.8-hd' },
    'two-voice-dialogue': { type: 'audio', mode: 'tts', model: 'gemini-3.1-flash-text-to-speech' },
    'underscore-bgm': { type: 'audio', mode: 't2m', model: MUREKA_BGM },
    'voice-from-descriptor': { type: 'audio', mode: 'tts', model: 'qwen3-tts-voice-design' },
    'song-cover': { type: 'audio', mode: 'a2m', model: 'minimax-music-cover' },
    'voice-clone-line': { type: 'audio', mode: 'voice_clone', model: 'minimax-voice-clone' },
    'score-for-my-video': { type: 'audio', mode: 'a2m', model: 'sonilo-video-to-music' },
    'music-mood-from-image': { type: 'audio', mode: 't2m', model: LYRIA },
    'clip-ambience-foley': { type: 'video', mode: 't2v', model: 'kling-v3.0-4k-text-to-video', params: { generate_audio: false } },
    'section-mapped-score': { type: 'audio', mode: 't2m', model: MUREKA_BGM },
  };
  /** Each template's inputs, as the design's section 9 gives them. */
  const INPUTS: Record<string, Array<{ key: string; type: string; into: string }>> = {
    'song-cover': [{ key: 'song', type: 'audio', into: 'audio' }],
    'voice-clone-line': [{ key: 'sample', type: 'audio', into: 'audio' }],
    'score-for-my-video': [{ key: 'video', type: 'video', into: 'video' }],
    'music-mood-from-image': [{ key: 'image', type: 'image', into: 'image' }],
  };
  /** The templates whose guide text node lists steps: trim to length, and trim then join the sections. */
  const WITH_STEPS = ['underscore-bgm', 'section-mapped-score'];

  /**
   * A sound template by id, failing the test when it is not registered.
   * @param id - The id.
   * @returns The template.
   */
  const sound = (id: string): GenerationTemplate => {
    const template = byId(id);
    if (!template) throw new Error(`template ${id} is not registered`);
    return template;
  };

  /**
   * A node's settings in the shape of the table.
   * @param node - The generate node.
   * @returns Its type, mode and model.
   */
  const settingsOf = (node: TemplateGenerateNode): Settings => ({ type: node.type, mode: node.mode, model: node.model });

  it('registers all eleven under the sound goal, which the panels list last', () => {
    for (const id of SOUND) expect(byId(id)?.goal, id).toBe('sound');
    expect(TEMPLATE_GOALS[TEMPLATE_GOALS.length - 1]).toBe('sound');
  });

  it('anchors each on the node type, mode, model and params the design gives', () => {
    for (const id of SOUND) {
      const anchor = anchorOf(sound(id));
      const { params, ...settings } = ANCHORS[id] as Settings;
      expect(anchor && settingsOf(anchor), id).toEqual(settings);
      if (params) expect(anchor?.params, id).toMatchObject(params);
    }
  });

  it('names two distinct speakers on the dialogue and writes each line after a speaker\'s name, in every language', () => {
    const template = sound('two-voice-dialogue');
    const anchor = anchorOf(template);
    const speakers = anchor?.params.speakers as Array<{ speaker?: unknown }> | undefined;
    expect(speakers).toHaveLength(2);
    const names = (speakers ?? []).map((one) => one.speaker);
    for (const name of names) expect(typeof name === 'string' && name.trim().length > 0, String(name)).toBe(true);
    expect(new Set(names).size).toBe(2);
    for (const locale of LOCALES) {
      const prompt = raw(locale, textKey(template, 'prompt')) ?? '';
      for (const name of names) expect(prompt, `${locale} ${String(name)}`).toMatch(new RegExp(`${String(name)}\\s*[:：]`));
    }
  });

  it('gives the voice-design anchor an English voice description to start from', () => {
    const description = anchorOf(sound('voice-from-descriptor'))?.params.voice_description;
    expect(typeof description === 'string' && description.trim().length > 0).toBe(true);
    expect(String(description)).toMatch(/^[\x20-\x7E]+$/);
  });

  it('feeds each user input straight into the slot the design gives, and the others take none', () => {
    for (const id of SOUND) {
      const template = sound(id);
      expect(
        template.inputs.map((input) => ({ key: input.key, type: input.type, into: input.into })),
        id,
      ).toEqual(INPUTS[id] ?? []);
    }
  });

  it('wires the foley clip\'s video into the video slot of one audio node downstream of it', () => {
    const template = sound('clip-ambience-foley');
    const others = generateNodes(template).filter((node) => node.key !== template.anchor);
    expect(others.map(settingsOf)).toEqual([{ type: 'audio', mode: 'sfx', model: 'hunyuan-video-foley' }]);
    expect(template.edges).toEqual([{ from: template.anchor, to: others[0]?.key, into: 'video' }]);
  });

  it('gives the section-mapped score three more sections as generate nodes of the same model, wired to nothing', () => {
    const template = sound('section-mapped-score');
    const others = template.nodes.filter((node) => node.key !== template.anchor);
    expect(others).toHaveLength(3);
    for (const node of others) expect(node.role, node.key).toBe('generate');
    const sections = generateNodes(template);
    expect(sections).toHaveLength(4);
    for (const node of sections) expect(settingsOf(node), node.key).toEqual({ type: 'audio', mode: 't2m', model: MUREKA_BGM });
    expect(template.edges).toEqual([]);
    expect(template.inputs).toEqual([]);
  });

  it('tells the agent the music comes back at full length for the user to trim, not at the length asked', () => {
    for (const id of WITH_STEPS) {
      const note = sound(id).agentNote;
      expect.soft(note, id).toContain('whatever length is asked');
      expect.soft(note, id).not.toContain("asked for at the video's length");
      expect.soft(note, id).toMatch(/\btrim/);
    }
  });

  it('lists follow-up steps only on the two templates that trim and join by hand', () => {
    for (const id of SOUND) {
      const steps = sound(id).steps;
      if (WITH_STEPS.includes(id)) expect(steps.length, id).toBeGreaterThan(0);
      else expect(steps, id).toEqual([]);
    }
  });

  it('has every string of each sound template in all five languages', () => {
    for (const id of SOUND) expectEveryString(sound(id));
  });
});

describe('template inputs that go into a slot (inner#1825, CAP-1)', () => {
  /** Every input with `into`, with its template, across the registry. */
  const slotted = (): Array<{ template: GenerationTemplate; input: GenerationTemplate['inputs'][number] }> =>
    GENERATION_TEMPLATES.flatMap((template) => template.inputs.filter((input) => input.into !== undefined).map((input) => ({ template, input })));

  it('has inputs that go into a slot, so the checks below run on something', () => {
    expect(slotted().length).toBeGreaterThan(0);
  });

  it('feeds such an input into exactly one node, into a slot that node\'s model declares in its mode for the input\'s type, filled from the canvas', () => {
    expect(slotted().length).toBeGreaterThan(0);
    for (const { template, input } of slotted()) {
      const where = `${template.id} ${input.key} into ${String(input.into)}`;
      const fed = feedsOf(template, input);
      expect(fed, where).toHaveLength(1);
      const node = generateNodes(template).find((one) => one.key === fed[0]);
      expect(node, where).toBeDefined();
      if (!node) continue;
      const model = MODELS.get(node.model);
      expect(model, `${where}: ${node.model} in the catalog`).toBeDefined();
      if (!model) continue;
      expect([model.mode].flat(), `${where}: ${node.model} runs in ${node.mode}`).toContain(node.mode);
      const slot = model.params[input.into as string];
      expect(slot, `${where}: a param of ${node.model}`).toBeDefined();
      expect(slot?.accepts, where).toBe(input.type);
      expect(slot?.fill, where).toBe('canvas');
      if (slot?.modes !== undefined) expect(slot.modes, where).toContain(node.mode);
    }
  });

  it('never @s such an input in the prompt of the node it goes into, in any language', () => {
    expect(slotted().length).toBeGreaterThan(0);
    for (const { template, input } of slotted()) {
      for (const node of generateNodes(template).filter((one) => feedsOf(template, input).includes(one.key))) {
        for (const locale of LOCALES) {
          const name = raw(locale, textKey(template, `input.${input.key}.name`));
          const labels = wordsOf(locale, template, node).flatMap((s) => (s.slot?.kind === 'asset' ? [s.slot.label] : []));
          expect(labels, `${template.id} ${locale} ${node.key} ${input.key}`).not.toContain(name);
        }
      }
    }
  });
});
