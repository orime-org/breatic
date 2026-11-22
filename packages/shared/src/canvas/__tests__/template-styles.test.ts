// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template styles (inner#1817, CAP-10): a template names a style set, and a
 * node that takes one of the set's parts gets the picked style's paragraph
 * after its own words, read from an absolute key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GENERATION_TEMPLATES, templateNodeWords, type GenerationTemplate, type TemplateGenerateNode } from '@shared/canvas/generation-templates.js';
import { expandTemplate } from '@shared/canvas/template-expansion.js';
import {
  TEMPLATE_STYLE_SETS,
  templateStyleKey,
  templateStyleSet,
  templateStylesOf,
} from '@shared/canvas/template-styles.js';
import { resetLocales, setLocale, setLocaleMessages } from '@shared/i18n/index.js';

const FILM = templateStyleSet('film-styles');
const STYLE = FILM.styles[0]?.id ?? '';

/**
 * What is wrong with how a template's nodes take style words: a node naming a part its template's set does not
 * have, a node taking style words beside a shot or line list, style words on a template with no set, or a set no
 * node takes words from.
 * @param template - The template.
 * @returns One line per problem.
 */
function styleWordsProblems(template: GenerationTemplate): string[] {
  const set = templateStylesOf(template);
  const problems: string[] = [];
  let taken = 0;
  for (const node of template.nodes) {
    if (node.role !== 'generate' || node.styleWords === undefined) continue;
    taken += 1;
    if (set === undefined) problems.push(`${template.id}.${node.key}: style words with no set`);
    else if (!set.parts.includes(node.styleWords)) problems.push(`${template.id}.${node.key}: ${node.styleWords} is not a part of ${set.id}`);
    if (node.shots !== undefined || node.lines !== undefined) problems.push(`${template.id}.${node.key}: style words beside a shot or line list`);
  }
  if (set !== undefined && taken === 0) problems.push(`${template.id}: ${set.id} with no node taking its words`);
  return problems;
}

/** The fixture's video anchor, taking the shot part. */
const SHOT_NODE: TemplateGenerateNode = { key: 'shot', role: 'generate', type: 'video', mode: 'i2v', model: 'fixture-video', params: {}, styleWords: 'shot' };

/** The fixture's still, taking the still part. */
const STILL_NODE: TemplateGenerateNode = { key: 'still', role: 'generate', type: 'image', mode: 'i2i', model: 'fixture-image', params: {}, styleWords: 'still' };

/** The fixture's node that takes no style words. */
const PLAIN_NODE: TemplateGenerateNode = { key: 'plain', role: 'generate', type: 'image', mode: 't2i', model: 'fixture-image', params: {} };

/** A two-node template: a still the anchor's first frame comes from, both taking film styles. */
const STYLED: GenerationTemplate = {
  id: 'styled-fixture',
  anchor: 'shot',
  styles: 'film-styles',
  nodes: [SHOT_NODE, STILL_NODE, PLAIN_NODE],
  edges: [{ from: 'still', to: 'shot', into: 'image' }],
  inputs: [{ key: 'subject', type: 'image', feeds: ['still'] }],
  steps: [],
  agentNote: 'a styled fixture',
  goal: 'character',
  triggers: { asks: ['a styled fixture'], offerWhen: [] },
};

beforeEach(() => {
  setLocaleMessages('en', {
    canvas: {
      template: {
        'styled-fixture': {
          name: 'Styled',
          prompt: 'Move [📎 Still].',
          node: { still: { name: 'Still', prompt: 'Redraw [📎 Subject].' }, plain: { name: 'Plain', prompt: 'A plain picture.' } },
          input: { subject: { name: 'Subject', note: 'Add a subject.' } },
        },
        styleSet: { 'film-styles': { style: { [STYLE]: { name: 'Style A', still: 'Still words.', shot: 'Shot words.' } } } },
      },
    },
  });
  setLocale('en');
});

afterEach(() => {
  resetLocales();
});

describe('template style sets', () => {
  it('names every style of a set once and gives each a category the set lists, when it lists any', () => {
    for (const set of TEMPLATE_STYLE_SETS) {
      const ids = set.styles.map((style) => style.id);
      expect(new Set(ids).size, set.id).toBe(ids.length);
      for (const style of set.styles) {
        if (set.categories === undefined) expect(style.category, `${set.id}.${style.id}`).toBeUndefined();
        else expect(set.categories, `${set.id}.${style.id}`).toContain(style.category);
      }
      expect(set.parts.length, set.id).toBeGreaterThan(0);
    }
  });

  it('holds 68 film styles in six categories', () => {
    expect(FILM.styles).toHaveLength(68);
    expect(FILM.categories).toHaveLength(6);
    expect(FILM.parts).toEqual(['still', 'shot', 'sound']);
    expect(FILM.thumbnails).toBe(true);
  });

  it('builds the absolute key of one part of one style', () => {
    expect(templateStyleKey('film-styles', STYLE, 'still')).toBe(`canvas.template.styleSet.film-styles.style.${STYLE}.still`);
  });

  it('gives a template its set and an unstyled template none', () => {
    expect(templateStylesOf(STYLED)?.id).toBe('film-styles');
    expect(templateStylesOf({ ...STYLED, styles: undefined })).toBeUndefined();
  });

  it('ties every registered node that takes style words to a part of its template\'s set', () => {
    expect(GENERATION_TEMPLATES.flatMap(styleWordsProblems)).toEqual([]);
  });

  it('reports a part the set lacks, a part on a shot list, and style words with no set or no node to take them', () => {
    expect(styleWordsProblems({ ...STYLED, nodes: [{ ...SHOT_NODE, styleWords: 'hit' }, STILL_NODE, PLAIN_NODE] })).toHaveLength(1);
    expect(styleWordsProblems({ ...STYLED, nodes: [{ ...SHOT_NODE, shots: [{ seconds: 5 }] }, STILL_NODE, PLAIN_NODE] })).toHaveLength(1);
    expect(styleWordsProblems({ ...STYLED, styles: undefined })).toHaveLength(2);
    expect(styleWordsProblems({ ...STYLED, nodes: [PLAIN_NODE] })).toHaveLength(1);
  });
});

describe('templateNodeWords with a style', () => {
  it('adds the absolute key of the part a node takes, and nothing without a style or a part', () => {
    expect(templateNodeWords(STYLED, 'still', STYLE)).toEqual({ prompt: 'node.still.prompt', styleKey: templateStyleKey('film-styles', STYLE, 'still') });
    expect(templateNodeWords(STYLED, 'shot', STYLE)).toEqual({ prompt: 'prompt', styleKey: templateStyleKey('film-styles', STYLE, 'shot') });
    expect(templateNodeWords(STYLED, 'still')).toEqual({ prompt: 'node.still.prompt' });
    expect(templateNodeWords(STYLED, 'plain', STYLE)).toEqual({ prompt: 'node.plain.prompt' });
  });

  it('ignores a style the set does not hold', () => {
    expect(templateNodeWords(STYLED, 'still', 'no-such-style')).toEqual({ prompt: 'node.still.prompt' });
  });
});

describe('expandTemplate with a style', () => {
  const input = { anchorAt: 0, base: 1, inputs: new Map(), wired: [], reuse: new Map(), guide: false };

  it('writes the style paragraph after each styled node\'s own words', () => {
    const result = expandTemplate(STYLED, { ...input, style: STYLE });
    expect(result.rewritten.get(0)?.prompt?.at(-1)).toEqual({ text: '\nShot words.' });
    expect(result.appended.find((node) => node.name === 'Still')?.prompt?.at(-1)).toEqual({ text: '\nStill words.' });
    expect(result.appended.find((node) => node.name === 'Plain')?.prompt).toEqual([{ text: 'A plain picture.' }]);
  });

  it('writes only the node\'s own words when no style is picked', () => {
    const prompt = expandTemplate(STYLED, input).rewritten.get(0)?.prompt ?? [];
    expect(prompt.some((segment) => segment.text?.includes('Shot words.') === true)).toBe(false);
  });
});
