// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The words of every template style set (inner#1817) in
 * `locales/template-styles/<locale>.json`: one file per locale the main
 * catalogs have, holding exactly the keys the sets ask for, in plain text,
 * naming no person, work, publication, company, brand or trademark, and the
 * subject-keeps-colour sentence in exactly the black-and-white and sepia
 * film styles.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TEMPLATE_STYLE_SETS } from '@shared/canvas/template-styles.js';

import { FORBIDDEN_LATIN, FORBIDDEN_BY_LOCALE } from './template-style-forbidden-words.js';

const LOCALES_DIR = resolve(import.meta.dirname, '../../../../../locales');
const STYLES_DIR = resolve(LOCALES_DIR, 'template-styles');

/**
 * The locales a directory holds catalogs for.
 * @param dir - The directory.
 * @returns Their codes, sorted.
 */
function localesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

const LOCALES = localesIn(LOCALES_DIR);

/**
 * Every leaf of a nested catalog, by dotted key.
 * @param node - A catalog or part of one.
 * @param prefix - The key so far.
 * @returns Each leaf's key and text.
 */
function leaves(node: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === 'string') {
    out.set(prefix, node);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    for (const [leaf, text] of leaves(value, prefix === '' ? key : `${prefix}.${key}`)) out.set(leaf, text);
  }
  return out;
}

/**
 * One locale's style words, by dotted key.
 * @param locale - The locale.
 * @returns Its leaves.
 */
function styleWords(locale: string): Map<string, string> {
  return leaves(JSON.parse(readFileSync(resolve(STYLES_DIR, `${locale}.json`), 'utf-8')));
}

/** The keys the style sets ask for. */
const EXPECTED = TEMPLATE_STYLE_SETS.flatMap((set) => [
  ...(set.categories ?? []).map((category) => `canvas.template.styleSet.${set.id}.category.${category}`),
  ...set.styles.flatMap((style) => ['name', ...set.parts].map((part) => `canvas.template.styleSet.${set.id}.style.${style.id}.${part}`)),
]).sort();

/** The film styles that keep the subject in colour (OP `dim` black-and-white or sepia, plus the hand-tinted photograph). */
const SUBJECT_KEEPS_COLOUR = [
  'expressionist-woodcut',
  'sepia-albumen',
  'rubber-hose',
  'letterpress-engraving',
  'gothic-charcoal',
  'studio-glamour-bw',
  'typewriter-art',
  'halftone-spread',
  'graphite-magazine',
  'one-line-caricature',
  'kinescope-tv',
  'cut-paper-titles',
  'bw-colour-accent',
  'silent-film-bw',
  'daguerreotype',
  'hand-tinted-photo',
];

/** The sentence, in each locale, that keeps the subject in colour. */
const SUBJECT_COLOUR_SENTENCE: Record<string, string> = {
  en: 'Only the subject keeps its own colours',
  'zh-CN': '只有主体保留它原本的颜色',
  'zh-TW': '只有主體保留它原本的顏色',
  ja: '主体だけが本来の色を保ち',
  ko: '주체만 원래의 색을 지니고',
};

/**
 * A pattern finding a name as a whole word, letters and digits on neither side.
 * @param word - The name.
 * @returns The pattern.
 */
function wholeWord(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
}

describe('template style words', () => {
  it('has a style catalog for exactly the locales the main catalogs have', () => {
    expect(localesIn(STYLES_DIR)).toEqual(LOCALES);
  });

  it('holds exactly the keys the style sets ask for, in every locale', () => {
    for (const locale of LOCALES) expect([...styleWords(locale).keys()].sort(), locale).toEqual(EXPECTED);
  });

  it('writes plain text with no marks and no empty words', () => {
    for (const locale of LOCALES) {
      for (const [key, text] of styleWords(locale)) {
        expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(text, `${locale} ${key}`).not.toMatch(/📎|✏️|💡|[{}]/u);
      }
    }
  });

  it('keeps the subject in colour in exactly the black-and-white and sepia film styles', () => {
    const film = TEMPLATE_STYLE_SETS.find((set) => set.id === 'film-styles');
    for (const locale of LOCALES) {
      const words = styleWords(locale);
      const sentence = SUBJECT_COLOUR_SENTENCE[locale] ?? '';
      expect(sentence, locale).not.toBe('');
      for (const style of film?.styles ?? []) {
        const still = words.get(`canvas.template.styleSet.film-styles.style.${style.id}.still`) ?? '';
        expect(still.includes(sentence), `${locale} ${style.id}`).toBe(SUBJECT_KEEPS_COLOUR.includes(style.id));
      }
    }
  });

  it('names no person, work, publication, company, brand or trademark', () => {
    for (const locale of LOCALES) {
      const own = FORBIDDEN_BY_LOCALE[locale] ?? [];
      for (const [key, text] of styleWords(locale)) {
        for (const word of FORBIDDEN_LATIN) expect(wholeWord(word).test(text), `${locale} ${key}: ${word}`).toBe(false);
        for (const word of own) expect(text.includes(word), `${locale} ${key}: ${word}`).toBe(false);
      }
    }
  });
});
