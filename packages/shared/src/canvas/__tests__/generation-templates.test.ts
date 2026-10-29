// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { TEMPLATE_GUIDE_KEY } from '@shared/types/canvas-proposal.js';
import { setLocale, setLocaleMessages, t } from '@shared/i18n/index.js';
import { MAX_NODE_NAME_LEN } from '@shared/types/canvas-node.js';
import { markedSegments } from '@shared/types/canvas-proposal.js';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];

/**
 * A registered template by id.
 * @param id - The id.
 * @returns The template, or undefined.
 */
const byId = (id: string): GenerationTemplate | undefined => GENERATION_TEMPLATES.find((template) => template.id === id);

/**
 * A template anchor's prompt in the current language.
 * @param template - The template.
 * @returns Its segments.
 */
const promptOf = (template: GenerationTemplate): ReturnType<typeof markedSegments> => markedSegments(t(`canvas.template.${template.id}.prompt`));

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

/** The locale key of a generate node's prompt: the template's own for the anchor. */
const promptKeyOf = (template: GenerationTemplate, key: string): string =>
  key === template.anchor ? textKey(template, 'prompt') : textKey(template, `node.${key}.prompt`);

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

/**
 * The generate nodes wired into a node's pool by a template edge.
 * @param template - The template.
 * @param key - The node.
 * @returns Their keys.
 */
const upstreamGenerations = (template: GenerationTemplate, key: string): string[] =>
  template.edges
    .filter((edge) => edge.to === key && (edge.into ?? 'pool') === 'pool')
    .map((edge) => edge.from)
    .filter((from) => generateNodes(template).some((node) => node.key === from));

describe('generation templates', () => {
  it('lists each node type its templates in registry order, audio none yet', () => {
    expect(templatesFor('image').map((t) => t.id)).toEqual([
      'costume-sheet',
      'character-bible',
      'expression-sheet',
      'character-design-from-text',
      'storyboard-grid-25',
    ]);
    expect(templatesFor('video').map((t) => t.id)).toEqual([
      'single-view-refs-scene',
      'identity-locked-sequence',
      'character-showcase-orbit',
    ]);
    expect(templatesFor('audio')).toEqual([]);
  });

  it('fixes the mode, model and the params the real runs settled on', () => {
    const NANO = 'nano-banana-pro-edit-ultra';
    const MINIMAX = 'minimax-h3-reference-to-video';
    const QWEN = 'qwen-image-edit-multiple-angles';
    const expected: Record<string, Record<string, Pick<TemplateGenerateNode, 'type' | 'mode' | 'model' | 'params'>>> = {
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
    };
    expect(GENERATION_TEMPLATES.map((template) => template.id).sort()).toEqual(Object.keys(expected).sort());
    for (const template of GENERATION_TEMPLATES) {
      const nodes = Object.fromEntries(
        generateNodes(template).map(({ key, type, mode, model, params }) => [key, { type, mode, model, params }]),
      );
      expect(nodes, template.id).toEqual(expected[template.id]);
      expect(template.anchor, template.id).toBe('result');
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

  it('carries a prompt in every interface language with a reference mark for each thing wired into the anchor pool and a note for each upstream generation', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of LOCALES) {
        setLocale(locale);
        const slots = promptOf(template).flatMap((s) => (s.slot ? [s.slot.kind] : []));
        const fedInputs = template.inputs.filter((input) => feedsOf(template, input).includes(template.anchor));
        const pooled = template.edges.filter((edge) => edge.to === template.anchor && (edge.into ?? 'pool') === 'pool');
        const where = `${template.id} ${locale}`;
        expect(slots.filter((kind) => kind === 'asset'), where).toHaveLength(fedInputs.length + pooled.length);
        expect(slots.filter((kind) => kind === 'note'), where).toHaveLength(upstreamGenerations(template, template.anchor).length);
        if (MIGRATED.includes(template.id)) expect(slots, where).toEqual(['asset', 'tweak']);
      }
    }
  });

  it('writes the prompt in the reader’s language', () => {
    const grid = byId('storyboard-grid-25');
    if (!grid) throw new Error('grid template missing');
    const text = (locale: string): string => {
      setLocale(locale);
      return promptOf(grid)
        .map((s) => s.text ?? '')
        .join('');
    };
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

  it('@s in the anchor prompt everything wired into its pool, each by its name, in every language', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of LOCALES) {
        setLocale(locale);
        const labels = promptOf(template).flatMap((s) => (s.slot?.kind === 'asset' ? [s.slot.label] : []));
        const names = [
          ...template.inputs
            .filter((input) => feedsOf(template, input).includes(template.anchor))
            .map((input) => raw(locale, textKey(template, `input.${input.key}.name`))),
          ...template.edges
            .filter((edge) => edge.to === template.anchor && (edge.into ?? 'pool') === 'pool')
            .map((edge) => raw(locale, textKey(template, `node.${edge.from}.name`))),
        ];
        expect([...labels].sort(), `${template.id} ${locale}`).toEqual([...names].sort());
      }
    }
  });
});

describe('creative goals and triggers', () => {
  it('lists the goals the registry uses, in panel order', () => {
    expect([...TEMPLATE_GOALS]).toEqual(['character', 'comics-storyboards']);
  });

  it('gives every template a known goal and words for when the agent offers it', () => {
    const goals: Record<string, string> = {
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
      expect(template.triggers.offerWhen.length, `${template.id} offerWhen`).toBeGreaterThan(0);
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

  it('groups a node type\'s templates under their goals in goal order, leaving out goals with none', () => {
    expect(templateGoalsFor('image').map(({ goal, templates }) => [goal, templates.map((one) => one.id)])).toEqual([
      ['character', ['costume-sheet', 'character-bible', 'expression-sheet', 'character-design-from-text']],
      ['comics-storyboards', ['storyboard-grid-25']],
    ]);
    expect(templateGoalsFor('video').map(({ goal, templates }) => [goal, templates.map((one) => one.id)])).toEqual([
      ['character', ['single-view-refs-scene', 'identity-locked-sequence', 'character-showcase-orbit']],
    ]);
    expect(templateGoalsFor('audio')).toEqual([]);
  });
});

describe('generation template registry checks', () => {
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

  it('anchors every template on a generate node that is the only end every other node reaches', () => {
    for (const template of GENERATION_TEMPLATES) {
      expect(anchorOf(template)?.key, template.id).toBe(template.anchor);
      expect(template.edges.filter((edge) => edge.from === template.anchor), template.id).toEqual([]);
      const reaches = new Set([template.anchor]);
      for (let pass = 0; pass < template.nodes.length; pass += 1) {
        for (const edge of template.edges) if (reaches.has(edge.to)) reaches.add(edge.from);
      }
      expect([...reaches].sort(), template.id).toEqual(template.nodes.map((node) => node.key).sort());
    }
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
            template.inputs.filter((input) => feedsOf(template, input).includes(node.key)).length +
            template.edges.filter((edge) => edge.to === node.key && (edge.into ?? 'pool') === 'pool').length;
          const where = `${template.id} ${locale} ${node.key}`;
          expect(targets.size, `${where}: targets named apart`).toBe(contributors);
          const labels = markedSegments(raw(locale, promptKeyOf(template, node.key)) ?? '').flatMap((s) =>
            s.slot?.kind === 'asset' ? [s.slot.label] : [],
          );
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
    for (const template of GENERATION_TEMPLATES) {
      const names = [
        'name',
        ...template.nodes.filter((node) => node.key !== template.anchor).map((node) => `node.${node.key}.name`),
        ...template.inputs.map((input) => `input.${input.key}.name`),
      ];
      const keys = [
        ...names,
        'description',
        'prompt',
        ...generateNodes(template).filter((node) => node.key !== template.anchor).map((node) => `node.${node.key}.prompt`),
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
      }
    }
  });
});
