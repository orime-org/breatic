// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template registry: what each generate panel lists and what a template
 * writes (inner#977).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  GENERATION_TEMPLATES,
  findTemplate,
  templatePrompt,
  templatesFor,
  type GenerationTemplate,
  type TemplateGenerateNode,
} from '@shared/canvas/generation-templates.js';
import { TEMPLATE_GUIDE_KEY, templateSkeleton } from '@shared/canvas/template-expansion.js';
import { setLocale, setLocaleMessages } from '@shared/i18n/index.js';
import { MAX_NODE_NAME_LEN } from '@shared/types/canvas-node.js';
import { markedSegments } from '@shared/types/canvas-proposal.js';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];

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

afterEach(() => {
  setLocale('en');
});

describe('generation templates', () => {
  it('lists the two image templates and nothing for video or audio yet', () => {
    expect(templatesFor('image').map((t) => t.id)).toEqual(['storyboard-grid-25', 'costume-sheet']);
    expect(templatesFor('video')).toEqual([]);
    expect(templatesFor('audio')).toEqual([]);
  });

  it('fixes the mode, model and the params the real runs settled on', () => {
    const grid = findTemplate('storyboard-grid-25');
    const costume = findTemplate('costume-sheet');
    if (!grid || !costume) throw new Error('template missing');
    expect(anchorOf(grid)).toMatchObject({
      role: 'generate',
      type: 'image',
      mode: 'i2i',
      model: 'nano-banana-pro-edit-ultra',
      params: { aspect_ratio: '1:1', resolution: '4k' },
    });
    expect(anchorOf(costume)).toMatchObject({
      role: 'generate',
      type: 'image',
      mode: 'i2i',
      model: 'nano-banana-pro-edit-ultra',
      params: { aspect_ratio: '16:9', resolution: '4k' },
    });
  });

  it('answers undefined for an id it does not have', () => {
    expect(findTemplate('no-such-template')).toBeUndefined();
  });

  it('carries a prompt in every interface language with as many reference marks as it declares', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of LOCALES) {
        setLocale(locale);
        const slots = templatePrompt(template).flatMap((s) => (s.slot ? [s.slot.kind] : []));
        const fedInputs = template.inputs.filter((input) => feedsOf(template, input).includes(template.anchor));
        expect(slots.filter((kind) => kind === 'asset'), `${template.id} ${locale}`).toHaveLength(fedInputs.length);
        expect(slots, `${template.id} ${locale}`).toEqual(['asset', 'tweak']);
      }
    }
  });

  it('writes the prompt in the reader’s language', () => {
    const grid = findTemplate('storyboard-grid-25');
    if (!grid) throw new Error('grid template missing');
    const text = (locale: string): string => {
      setLocale(locale);
      return templatePrompt(grid)
        .map((s) => s.text ?? '')
        .join('');
    };
    expect(text('zh-CN')).toContain('5 行 5 列');
    expect(text('en')).toContain('5 rows and 5 columns');
  });

  it('migrates both templates to one anchor fed by one reference input, with no resource, edge or step', () => {
    for (const template of GENERATION_TEMPLATES) {
      const skeleton = templateSkeleton(template);
      expect(skeleton.nodes, template.id).toEqual(new Map([[template.anchor, { role: 'generate', type: 'image' }]]));
      expect(skeleton.edges, template.id).toEqual([]);
      expect(skeleton.inputs, template.id).toEqual([{ key: 'reference', type: 'image', feeds: [template.anchor] }]);
      expect(skeleton.steps, template.id).toEqual([]);
    }
  });

  it('names the reference input after the label its mark carried in every language', () => {
    expect(raw('en', 'canvas.template.storyboard-grid-25.input.reference.name')).toBe('character or scene reference');
    expect(raw('en', 'canvas.template.costume-sheet.input.reference.name')).toBe('character reference');
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of LOCALES) {
        setLocale(locale);
        const labels = templatePrompt(template).flatMap((s) => (s.slot?.kind === 'asset' ? [s.slot.label] : []));
        expect(labels, `${template.id} ${locale}`).toEqual([raw(locale, textKey(template, 'input.reference.name'))]);
      }
    }
  });
});

describe('generation template registry checks', () => {
  it('keeps template ids, node keys and input keys unique, and no node takes the guide key', () => {
    const ids = GENERATION_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
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
        for (const node of generateNodes(template)) {
          const targets = [
            ...template.inputs
              .filter((input) => feedsOf(template, input).includes(node.key))
              .map((input) => raw(locale, textKey(template, `input.${input.key}.name`))),
            ...template.edges
              .filter((edge) => edge.to === node.key && edge.into === 'pool')
              .map((edge) => raw(locale, textKey(template, `node.${edge.from}.name`))),
          ];
          const where = `${template.id} ${locale} ${node.key}`;
          expect(new Set(targets).size, where).toBe(targets.length);
          const labels = markedSegments(raw(locale, promptKeyOf(template, node.key)) ?? '').flatMap((s) =>
            s.slot?.kind === 'asset' ? [s.slot.label] : [],
          );
          for (const label of labels) expect(targets.filter((name) => name === label), `${where} ${label}`).toHaveLength(1);
        }
      }
    }
  });

  it('keeps every resource under templates/<its template id>/', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const node of template.nodes) {
        if (node.role !== 'source') continue;
        expect(node.resource, `${template.id} ${node.key}`).toMatch(new RegExp(`^templates/${template.id}/[^/]+$`));
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
