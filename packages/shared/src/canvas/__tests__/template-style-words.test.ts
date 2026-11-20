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
 * What a sentence looks like where a value it named was cut out and the words around it were left: a
 * preposition or hedge with nothing after it, a bracket holding only a hedge, a doubled conjunction.
 */
const LEFTOVERS: Record<string, RegExp[]> = {
  common: [/[（(]\s*(约|約|前後|안팎|about|near)?\s*[）)]/u],
  en: [/\b(?<!to )(near|reach|from)\s*[,;.:]/u, /\bfrom (to|through)\b/u, /\bthrough to\s*[,;.]/u, /\band and\b/u, /\bnear (cover|the rest|with)\b/u],
  'zh-CN': [/从到|从经|经到|约[）)；，。]|接近[，；。]|亮到[；。]|暗部。/u],
  'zh-TW': [/從到|從經|經到|約[）)；，。]|接近[，；。]|亮到[；。]|暗部。/u],
  ja: [/からを|から(を経て)?まで|^まで|[はの]前後|は近く|は。|は(まで|から)/u],
  ko: [/에서(을|까지)|^에서|[은는]안팎|[은는]가까이|[은는]이다|\(\s*안팎/u],
};

/** Korean nouns ending in the syllable 을 (늦가을 too), which the particle check must not read as a particle. */
const KOREAN_NOUNS_ENDING_IN_EUL = /(노|가|마)을$/u;

/**
 * A pattern finding a name as a whole word, letters and digits on neither side.
 * @param word - The name.
 * @returns The pattern.
 */
function wholeWord(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
}

/** Each forbidden Latin name with its whole-word pattern, built once for every text the check reads. */
const LATIN_PATTERNS = FORBIDDEN_LATIN.map((word) => [word, wholeWord(word)] as const);

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

  it('leaves no clause hanging where a value was taken out', () => {
    for (const locale of LOCALES) {
      const residue = LEFTOVERS.common.concat(LEFTOVERS[locale] ?? []);
      for (const [key, text] of styleWords(locale)) {
        for (const pattern of residue) expect(text, `${locale} ${key}`).not.toMatch(pattern);
        for (const [open, close] of [['(', ')'], ['（', '）']]) {
          expect(text.split(open).length, `${locale} ${key} ${open}${close}`).toBe(text.split(close).length);
        }
      }
    }
  });

  it('puts each Korean object and conjunction particle in the form its noun takes', () => {
    for (const [key, text] of styleWords('ko')) {
      for (const match of text.matchAll(/([가-힣]+)([를을와과])(?=[\s,.;:)])/gu)) {
        const [, word = '', particle = ''] = match;
        if (KOREAN_NOUNS_ENDING_IN_EUL.test(word + particle)) continue;
        const last = (word.codePointAt(word.length - 1) ?? 0) - 0xac00;
        const closed = last % 28 !== 0;
        expect(closed, `${key}: ${word}${particle}`).toBe(particle === '을' || particle === '과');
      }
    }
  });

  it('names no person, work, publication, company, brand or trademark', () => {
    const named: string[] = [];
    for (const locale of LOCALES) {
      const own = FORBIDDEN_BY_LOCALE[locale] ?? [];
      for (const [key, text] of styleWords(locale)) {
        for (const [word, pattern] of LATIN_PATTERNS) if (pattern.test(text)) named.push(`${locale} ${key}: ${word}`);
        for (const word of own) if (text.includes(word)) named.push(`${locale} ${key}: ${word}`);
      }
    }
    expect(named).toEqual([]);
  });
});
