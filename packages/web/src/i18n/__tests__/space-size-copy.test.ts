// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec N-09 to
 * N-11: the size-cap sentences in the five catalogs.
 *
 * The spec fixes the sentences, not the key names (answer Q1: the keys are
 * renamed for the second design and the first design's keys are deleted). So
 * each sentence's key is found by matching the English template, with
 * `{used}` and `{limit}` left as placeholders, against the English catalog;
 * the same key must render the Simplified Chinese sentence word for word, and
 * exist in ja, ko and zh-TW with the same placeholders and the word `Space`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { formatBytes, t } from '@breatic/shared';

import { changeLocale } from '@web/i18n/locale-bootstrap';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import {
  COPY_V2_EN,
  COPY_V2_ZH_CN,
  P_FULL,
  P_OVER,
  P_WARNING,
  type DocSizePushV2,
} from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

type Code = keyof typeof COPY_V2_EN;

/** The push whose figures each sentence with figures is rendered with (N-09). */
const FIGURES: Partial<Record<Code, DocSizePushV2>> = {
  N_WARNING: P_WARNING,
  N_FULL: P_FULL,
  N_OVER: P_OVER,
};

const CODES = Object.keys(COPY_V2_EN) as Code[];

/** The first design's keys, which Q1 deletes from every catalog. */
const V1_KEYS = [
  'warning', 'fullNotice', 'addBlocked', 'overwriteBlocked', 'noRoom', 'overCeilingDelete', 'timelineFull',
  'threeDFull', 'resync', 'proposalFull', 'proposalNoRoom', 'spaceFullReason', 'textNoRoom', 'textFull',
].map((key) => `spaces.size.${key}`);

/** First-design sentences whose wording the second design replaced (en, zh-CN). */
const V1_SENTENCES = [
  'This Space is using {used} of its {limit}.',
  'This Space is full ({used} of {limit}). Delete some content to add more.',
  'This Space is full. Delete some content to add more.',
  'This Space is full. Moving or changing things is paused until you delete some content.',
  'This doesn\'t fit — the Space has {room} left.',
  'This Space is full and cannot take more.',
  'This Space is full and can no longer be edited.',
  '这个 Space 已用 {used}，上限 {limit}。',
  '这个 Space 已满，删除一些内容后才能继续添加。',
  '这个 Space 已满，暂时不能再移动或修改，删除一些内容后可继续。',
];

/**
 * A sentence as its template reads: `{used}` and `{limit}` for the figures.
 * @param literal - The copy literal.
 * @returns The template text.
 */
function template(literal: string | ((u: string, l: string) => string)): string {
  return typeof literal === 'string' ? literal : literal('{used}', '{limit}');
}

/**
 * A sentence with its figures filled in.
 * @param literal - The copy literal.
 * @param figures - The push the figures come from, if it has any.
 * @returns The sentence.
 */
function rendered(literal: string | ((u: string, l: string) => string), figures: DocSizePushV2 | undefined): string {
  if (typeof literal === 'string') return literal;
  return literal(formatBytes(figures!.bytes), formatBytes(figures!.limit));
}

/**
 * Every string leaf of a catalog, by dotted key.
 * @param node - A catalog or a subtree of it.
 * @param prefix - The key of `node`.
 * @returns The leaves.
 */
function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix === '' ? k : `${prefix}.${k}`),
  );
}

/**
 * The simple ICU arguments of a message.
 * @param message - The message template.
 * @returns The argument names, sorted.
 */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/**
 * The English keys whose message is this sentence's template.
 * @param code - The sentence.
 * @returns The keys.
 */
function keysFor(code: Code): string[] {
  const wanted = template(COPY_V2_EN[code]);
  const [, en] = LOCALE_CATALOGS[0];
  return leaves(en).filter(([, message]) => message === wanted).map(([key]) => key);
}

/**
 * The ICU parameters a sentence is rendered with.
 * @param code - The sentence.
 * @returns The parameters.
 */
function paramsFor(code: Code): Record<string, string> {
  const figures = FIGURES[code];
  return figures === undefined ? {} : { used: formatBytes(figures.bytes), limit: formatBytes(figures.limit) };
}

afterEach(() => {
  changeLocale('en');
});

describe('N-09 every size-cap sentence in en and zh-CN', () => {
  it.each(CODES)('N-09 %s has an English key whose message is the spec sentence', (code) => {
    expect(keysFor(code).length).toBeGreaterThan(0);
  });

  it.each(CODES)('N-09 %s renders the spec sentence in en and in zh-CN on the same key', (code) => {
    const keys = keysFor(code);
    expect(keys.length).toBeGreaterThan(0);
    const figures = FIGURES[code];
    for (const key of keys) {
      changeLocale('en');
      expect(t(key, paramsFor(code))).toBe(rendered(COPY_V2_EN[code], figures));
      changeLocale('zh-CN');
      expect(t(key, paramsFor(code))).toBe(rendered(COPY_V2_ZH_CN[code], figures));
    }
  });
});

describe('N-10 ja, ko and zh-TW carry every size-cap key', () => {
  const others = LOCALE_CATALOGS.filter(([tag]) => tag === 'ja' || tag === 'ko' || tag === 'zh-TW');

  it.each(CODES)('N-10 %s exists, non-empty, with the English placeholders and the word Space', (code) => {
    const keys = keysFor(code);
    expect(keys.length).toBeGreaterThan(0);
    const [, en] = LOCALE_CATALOGS[0];
    for (const key of keys) {
      const english = readPath(en, key) as string;
      for (const [tag, catalog] of others) {
        const message = readPath(catalog, key);
        expect(typeof message, `${tag} ${key}`).toBe('string');
        expect((message as string).trim(), `${tag} ${key}`).not.toBe('');
        expect(placeholders(message as string), `${tag} ${key}`).toEqual(placeholders(english));
        expect(message as string, `${tag} ${key}`).toContain('Space');
        changeLocale(tag);
        expect(() => t(key, paramsFor(code)), `${tag} ${key}`).not.toThrow();
      }
    }
  });

  it('N-10 the sentences with figures carry {used} and {limit}', () => {
    for (const code of ['N_WARNING', 'N_FULL', 'N_OVER'] as const) {
      expect(keysFor(code).length, code).toBeGreaterThan(0);
      for (const key of keysFor(code)) {
        for (const [tag, catalog] of LOCALE_CATALOGS) {
          expect(placeholders(readPath(catalog, key) as string), `${tag} ${key}`).toEqual(['limit', 'used']);
        }
      }
    }
  });
});

describe('N-11 the first design\'s copy is gone', () => {
  it.each(LOCALE_CATALOGS)('N-11 %s has none of the first design\'s size keys', (_tag, catalog) => {
    for (const key of V1_KEYS) expect(readPath(catalog, key), key).toBeUndefined();
  });

  it('N-11 no catalog message is one of the first design\'s replaced sentences', () => {
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      const messages = new Set(leaves(catalog).map(([, message]) => message));
      for (const sentence of V1_SENTENCES) expect(messages.has(sentence), `${tag}: ${sentence}`).toBe(false);
    }
  });
});
