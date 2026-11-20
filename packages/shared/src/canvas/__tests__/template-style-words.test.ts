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
const LEFTOVERS_IN_EVERY_LOCALE: RegExp[] = [/[（(]\s*(约|約|前後|안팎|about|near)?\s*[）)]/u];

/** The same, in the words of one locale. */
const LEFTOVERS: Record<string, RegExp[]> = {
  en: [/\b(?<!to )(near|reach|from)\s*[,;.:]/u, /\bfrom (to|through)\b/u, /\bthrough to\s*[,;.]/u, /\band and\b/u, /\bnear (cover|the rest|with)\b/u],
  'zh-CN': [/、(和|与)|从到|从经|经到|约[）)；，。]|接近[，；。]|亮到[；。]|暗部。/u],
  'zh-TW': [/、(和|與)|從到|從經|經到|約[）)；，。]|接近[，；。]|亮到[；。]|暗部。/u],
  ja: [/からを|から(を経て)?まで|^まで|[はの]前後|は近く|は。|は(まで|から)/u],
  ko: [/에서(을|까지)|^에서|[은는]안팎|[은는]가까이|[은는]이다|\(\s*안팎/u],
};

/**
 * How each locale writes what a film style's words must not ask of the picture they extend (inner#1817): the shot's
 * first frame is the finished still, so its first sentence builds nothing from black or bare paper and no shot opens
 * on an iris or a door; the still is one picture, so it names no cut, dissolve or process still under way; and
 * lettering in the language of the prompt asks for no letter case a language without capitals cannot have.
 */
const PICTURE_RULES: Record<string, { shotStart: RegExp; shotOpens: RegExp; stillMotion: RegExp; caseWithPromptLanguage?: RegExp }> = {
  en: {
    shotStart: /open(s)? on (black|blank)|starts? as|(draws|types|sprays|builds|colours|writes) itself|paint themselves in|develops? out of|snap on one by one/u,
    shotOpens: /\bopens? or closes?\b|\bopens and closes\b/u,
    stillMotion: /fast cuts|hard cuts?(?! edges)|dissolve|fade to|crossfade|whip pan|\bdeveloping\b/u,
  },
  'zh-CN': {
    shotStart: /全黑|先只有|自己画|自己涂|自己写|一笔一笔|一笔笔画出来|打出来|喷到墙上|显出来/u,
    shotOpens: /开场或收尾|开场和收尾|开头或结尾/u,
    stillMotion: /快切|叠化|淡出|甩镜|正在显影/u,
    caseWithPromptLanguage: /[^。]*(大写[^。]*这段提示词的语言|这段提示词的语言[^。]*大写)/u,
  },
  'zh-TW': {
    shotStart: /全黑|先只有|自己畫|自己塗|自己寫|一筆一筆|一筆筆畫出來|打出來|噴到牆上|顯出來/u,
    shotOpens: /開場或收尾|開場和收尾|開頭或結尾/u,
    stillMotion: /快切|溶接|淡出|甩鏡|正在顯影/u,
    caseWithPromptLanguage: /[^。]*(大寫[^。]*這段提示詞的語言|這段提示詞的語言[^。]*大寫)/u,
  },
  ja: {
    shotStart: /黒から|鉛筆だけで始ま|描かれていく|描き込まれていく|ひとりでに|打たれて|吹きつけられ|浮かび上が/u,
    shotOpens: /始まりか終わり|始まりと終わり|冒頭か終わり/u,
    stillMotion: /速いカット|ディゾルブ|フェード|現像されていく/u,
    caseWithPromptLanguage: /[^。]*(大文字[^。]*このプロンプトの言語|このプロンプトの言語[^。]*大文字)/u,
  },
  ko: {
    shotStart: /검은 화면에서 시작|연필만으로 시작|스스로 그려|저절로|한 획씩 그려|타자로 쳐진 뒤|벽에 뿌려지고|떠오른다/u,
    shotOpens: /시작이나 끝|시작과 끝/u,
    stillMotion: /빠른 컷|디졸브|페이드|현상되고 있다/u,
    caseWithPromptLanguage: /[^.]*(대문자[^.]*이 프롬프트의 언어|이 프롬프트의 언어[^.]*대문자)/u,
  },
};

/** The bracket pairs a style's words use. */
const BRACKETS = [['(', ')'], ['（', '）']] as const;

/**
 * Whole Korean words in the style words that end in a syllable spelled like a particle but are not a noun and its
 * particle: nouns (노을, 아이, 찬송가) and verb forms before a noun (있는, 걷는).
 */
const KOREAN_WORDS_NOT_NOUN_AND_PARTICLE = new Set([
  '가까이', '가라앉는', '가을', '걷는', '노을', '늦가을', '닿는', '덮는', '뜯는', '맡는', '받는', '뿜는', '스프레이', '아이',
  '않는', '얻는', '없는', '웃는', '읽는', '있는', '조명받는', '지은', '찍는', '찬송가', '토이', '파이', '훑는',
]);

/** The particle forms taken after a syllable that ends in a consonant. */
const AFTER_CONSONANT = new Set(['이', '은', '을', '과', '으로']);

/**
 * Korean particles in a text whose form does not match the syllable before them: 이/가, 은/는, 을/를 and 과/와 by
 * whether that syllable ends in a consonant, 으로/로 by whether it ends in one other than ㄹ.
 * @param text - Korean text.
 * @returns Each mismatched word with its particle.
 */
function koreanParticleMismatches(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/([가-힣]+?)(으로|로|이|가|은|는|을|를|과|와)(?=[\s,.;:)])/gu)) {
    const [whole = '', word = '', particle = ''] = match;
    if (KOREAN_WORDS_NOT_NOUN_AND_PARTICLE.has(whole)) continue;
    const final = ((word.codePointAt(word.length - 1) ?? 0) - 0xac00) % 28;
    const wants = particle === '로' || particle === '으로' ? final !== 0 && final !== 8 : final !== 0;
    if (AFTER_CONSONANT.has(particle) !== wants) out.push(whole);
  }
  return out;
}

/**
 * A pattern finding a name as a whole Latin word: no Latin letter or digit on either side, so a name written
 * straight against Chinese, Japanese or Korean text is still found.
 * @param word - The name.
 * @returns The pattern.
 */
function wholeWord(word: string): RegExp {
  return new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{Script=Latin}\\p{N}])`, 'u');
}

/** The templates of the film style goal (inner#1817), whose words the forbidden-name check reads too. */
const FILM_STYLE_TEMPLATES = ['film-style-still', 'film-style-shot', 'era-walkthrough-montage', 'style-sound-bed'];

/**
 * The main catalog's words of the film style goal's templates and the goal's name, by dotted key.
 * @param locale - The locale.
 * @returns Their leaves.
 */
function styledTemplateWords(locale: string): Map<string, string> {
  const template = (JSON.parse(readFileSync(resolve(LOCALES_DIR, `${locale}.json`), 'utf-8')) as {
    canvas: { template: Record<string, unknown> & { goal: Record<string, string> } };
  }).canvas.template;
  const out = leaves(Object.fromEntries(FILM_STYLE_TEMPLATES.map((id) => [id, template[id]])), 'canvas.template');
  out.set('canvas.template.goal.film-styles', template.goal['film-styles'] ?? '');
  return out;
}

/**
 * A pattern finding one locale's spelling of a forbidden name: anywhere in Chinese and Japanese, which do not
 * separate words; in Korean only at the start of a word, so a name inside an ordinary word (매기 in 갈매기) is not
 * read as the name, while the particles a name takes after it still are.
 * @param locale - The locale.
 * @param word - The name.
 * @returns The pattern.
 */
function localWord(locale: string, word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(locale === 'ko' ? `(?<![가-힣])${escaped}` : escaped, 'u');
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
      const residue = [...LEFTOVERS_IN_EVERY_LOCALE, ...(LEFTOVERS[locale] ?? [])];
      for (const [key, text] of styleWords(locale)) {
        for (const pattern of residue) expect(text, `${locale} ${key}`).not.toMatch(pattern);
        for (const [open, close] of BRACKETS) {
          expect(text.split(open).length, `${locale} ${key} ${open}${close}`).toBe(text.split(close).length);
        }
      }
    }
  });

  it('asks each part only for what its picture can hold: a shot starting from the finished still, a still with no motion', () => {
    const found: string[] = [];
    for (const locale of LOCALES) {
      const rules = PICTURE_RULES[locale];
      expect(rules, locale).toBeDefined();
      if (rules === undefined) continue;
      const stop = locale === 'en' || locale === 'ko' ? '. ' : '。';
      for (const [key, text] of styleWords(locale)) {
        const flag = (rule: RegExp | undefined, within: string): void => {
          const hit = rule?.exec(within);
          if (hit) found.push(`${locale} ${key}: ${hit[0]}`);
        };
        if (key.endsWith('.shot')) {
          flag(rules.shotStart, text.split(stop)[0] ?? '');
          flag(rules.shotOpens, text);
        }
        if (key.endsWith('.still')) {
          flag(rules.stillMotion, text);
          flag(rules.caseWithPromptLanguage, text);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('puts each Korean particle in the form the syllable before it takes', () => {
    expect([...styleWords('ko')].flatMap(([key, text]) => koreanParticleMismatches(text).map((word) => `${key}: ${word}`))).toEqual([]);
  });

  it('finds a Latin name written straight against other scripts, and only as a whole Latin word', () => {
    expect(wholeWord('Polaroid').test('Polaroid相纸')).toBe(true);
    expect(wholeWord('Kodachrome').test('Kodachromeのフィルム')).toBe(true);
    expect(wholeWord('Polaroid').test('Polaroids')).toBe(false);
  });

  it('catches each particle pair written in the wrong form', () => {
    expect(koreanParticleMismatches('땅가 크다. 슬레이트색는 하늘. 금색로 타오른다. 주황를 거쳐 벽돌색와 하늘. 바다으로 간다. 물으로 씻는다.')).toEqual([
      '땅가', '슬레이트색는', '금색로', '주황를', '벽돌색와', '바다으로', '물으로',
    ]);
    expect(koreanParticleMismatches('땅이 크다. 슬레이트색은 하늘. 금색으로 타오르고 선으로 그린다. 주황을 거쳐 벽돌색과 하늘.')).toEqual([]);
  });

  it('names no person, work, publication, company, brand or trademark in the styles or their templates', () => {
    const named: string[] = [];
    for (const locale of LOCALES) {
      const own = (FORBIDDEN_BY_LOCALE[locale] ?? []).map((word) => [word, localWord(locale, word)] as const);
      for (const [key, text] of [...styleWords(locale), ...styledTemplateWords(locale)]) {
        for (const [word, pattern] of LATIN_PATTERNS) if (pattern.test(text)) named.push(`${locale} ${key}: ${word}`);
        for (const [word, pattern] of own) if (pattern.test(text)) named.push(`${locale} ${key}: ${word}`);
      }
    }
    expect(named).toEqual([]);
  });
});
