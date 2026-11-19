// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template styles (inner#1817, CAP-10): a template names a style set, and a
 * node that takes one of the set's parts gets the picked style's paragraph
 * after its own words, read from an absolute key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { templateNodeWords, type GenerationTemplate } from '@shared/canvas/generation-templates.js';
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

/** A two-node template: a still the anchor's first frame comes from, both taking film styles. */
const STYLED: GenerationTemplate = {
  id: 'styled-fixture',
  anchor: 'shot',
  styles: 'film-styles',
  nodes: [
    { key: 'shot', role: 'generate', type: 'video', mode: 'i2v', model: 'fixture-video', params: {}, styleWords: 'shot' },
    { key: 'still', role: 'generate', type: 'image', mode: 'i2i', model: 'fixture-image', params: {}, styleWords: 'still' },
    { key: 'plain', role: 'generate', type: 'image', mode: 't2i', model: 'fixture-image', params: {} },
  ],
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
    expect(result.rewritten.get(0)?.prompt?.at(-1)).toEqual({ text: '\n\nShot words.' });
    expect(result.appended.find((node) => node.name === 'Still')?.prompt?.at(-1)).toEqual({ text: '\n\nStill words.' });
    expect(result.appended.find((node) => node.name === 'Plain')?.prompt).toEqual([{ text: 'A plain picture.' }]);
  });

  it('writes only the node\'s own words when no style is picked', () => {
    const prompt = expandTemplate(STYLED, input).rewritten.get(0)?.prompt ?? [];
    expect(prompt.some((segment) => segment.text?.includes('Shot words.') === true)).toBe(false);
  });
});
