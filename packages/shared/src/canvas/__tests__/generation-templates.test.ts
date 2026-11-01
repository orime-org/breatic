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

describe('character template layouts (inner#1846)', () => {
  const SHEET_LABELS = [
    'NAME', 'ROLE', 'AGE', 'PERSONALITY', 'THEME', 'COLOR PALETTE', 'MAIN VIEWS', 'FRONT', '3/4', 'SIDE', 'BACK',
    'SILHOUETTE', 'CLOSE-UP', 'EXPRESSIONS', 'MICRO-EXPRESSIONS', 'HEAD ANGLES', 'POSES', 'COSTUME DETAILS', 'HANDS',
  ];
  const EXPRESSION_LABELS = ['EXPRESSIONS', 'MICRO-EXPRESSIONS', 'HEAD ANGLES'];
  const SHEET_PROMPTS = ['canvas.template.character-bible.prompt', 'canvas.template.character-design-from-text.prompt'];
  const EXPRESSION_PROMPT = 'canvas.template.expression-sheet.prompt';

  /**
   * The kinds of marks a prompt carries, in order.
   * @param text - The prompt.
   * @returns One entry per mark.
   */
  const marksOf = (text: string): string[] => markedSegments(text).flatMap((s) => (s.slot ? [s.slot.kind] : []));

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

  it('keeps the worn and carried items on the character sheet, and its rendering only where no style is picked', () => {
    const bible = raw('en', 'canvas.template.character-bible.prompt') ?? '';
    expect(bible).toContain('wearing everything the reference shows on the body, including anything on the back or over a shoulder');
    expect(bible).not.toContain("reference's exact rendering");
    expect(raw('en', 'canvas.template.character-design-from-text.prompt')).toContain("Keep the reference's exact rendering");
  });

  it('carries the same marks in the same order in every language, for every character template prompt', () => {
    for (const template of GENERATION_TEMPLATES.filter((one) => one.goal === 'character')) {
      for (const key of template.nodes.filter((node) => node.role === 'generate').map((node) => promptKeyOf(template, node.key))) {
        const reference = marksOf(raw('en', key) ?? '');
        for (const locale of LOCALES) expect(marksOf(raw(locale, key) ?? ''), `${key} ${locale}`).toEqual(reference);
      }
    }
  });

  it('tells the agent what to do when a face drifts and what to look for after an orbit', () => {
    expect(byId('identity-locked-sequence')?.agentNote).toContain('if the reader says the face drifted, shorten it to 5 to 6 seconds, re-split the three timecodes to fit, and tighten the sentence that says it is the same person in all three shots');
    expect(byId('character-showcase-orbit')?.agentNote).toContain('when the reader comes back with the result, check that it shows different sides of the character, not the character turning round');
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
      en: ['controlled breathing (lips slightly parted while slowly exhaling)', 'a clear English label in small sans-serif capitals at the top left of every section, written exactly as that section\'s capitalised name below', 'no blending of features'],
      'zh-CN': ['呼吸控制（嘴唇微张着缓缓呼气）', '一个清晰的英文小标签（只写下文大写的区块名，无衬线大写）', '不把五官混在一起'],
      'zh-TW': ['呼吸控制（嘴唇微張著緩緩吐氣）', '一個清晰的英文小標籤（只寫下文大寫的區塊名，無襯線大寫）', '不把五官混在一起'],
      ja: ['抑えた呼吸（唇を少し開いてゆっくり息を吐く）', '下に大文字で書いたセクション名だけを書いた、小さなサンセリフ大文字のはっきりした英語ラベル', '顔立ちを混ぜない'],
      ko: ['절제된 호흡(입술을 살짝 벌리고 천천히 내쉼)', '아래에 대문자로 적은 섹션 이름만 적은, 작은 산세리프 대문자로 된 선명한 영어 라벨', '이목구비를 섞지 않는다'],
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
    for (const view of ['side', 'back']) {
      expect(raw('en', `canvas.template.single-view-refs-scene.node.${view}.prompt`), view).toContain('Build the parts the reference does not show');
    }
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
