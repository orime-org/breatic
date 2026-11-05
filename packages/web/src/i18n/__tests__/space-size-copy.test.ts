// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790), test spec section 14: W-132, W-133.
 *
 * The spec fixes the sentences, not the locale keys or the placeholder names
 * the implementation chooses for them. So each sentence's key is found by
 * matching the English template against the expected English sentence, with
 * every placeholder left open; the same key must then render the expected
 * Simplified Chinese sentence, and exist, carrying the same placeholders, in
 * the other three catalogs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { t } from '@breatic/shared';

import { changeLocale } from '@web/i18n/locale-bootstrap';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import { COPY_EN, COPY_ZH_CN } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

/** The values the spec renders every sentence with (W-132). */
const VALUES = { u: '9 MiB', l: '10 MiB', r: '768 KiB' } as const;

type Code = keyof typeof COPY_EN;

/** Which spec values each sentence takes, in the order its English wording shows them. */
const ARGS: Record<Code, ReadonlyArray<keyof typeof VALUES>> = {
  T_WARNING: ['u', 'l'],
  T_FULL_NOTICE: ['u', 'l'],
  T_ADD_BLOCKED: [],
  T_OVERWRITE_BLOCKED: [],
  T_NO_ROOM: ['r'],
  T_OVER_CEILING_DELETE: [],
  T_TIMELINE_FULL: [],
  T_3D_FULL: [],
  T_RESYNC: [],
  T_PROPOSAL_FULL: [],
  T_PROPOSAL_NO_ROOM: ['r'],
  T_UPLOAD_FAILED: [],
  T_SPACE_FULL_REASON: [],
  T_TEXT_NO_ROOM: ['r'],
  T_TEXT_FULL: [],
};

const CODES = Object.keys(ARGS) as Code[];

/**
 * Calls a copy literal (a string or a function of its values) with the given arguments.
 * @param literal - The literal from the fixtures.
 * @param args - The arguments, in the literal's own order.
 * @returns The sentence.
 */
function render(literal: string | ((...a: string[]) => string), args: readonly string[]): string {
  return typeof literal === 'string' ? literal : literal(...args);
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

const SENTINEL = '\u0000';

/**
 * The English catalog keys whose template is this sentence, with the
 * placeholder each spec value took.
 * @param code - The sentence.
 * @returns Each matching key and the placeholder name for each spec value.
 */
function keysFor(code: Code): Array<{ key: string; names: string[] }> {
  const args = ARGS[code];
  const marked = render(COPY_EN[code], args.map((_, i) => `${SENTINEL}${String(i)}${SENTINEL}`));
  const escaped = marked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped.replace(new RegExp(`${SENTINEL}\\d+${SENTINEL}`, 'g'), '\\{(\\w+)\\}')}$`);
  const [, en] = LOCALE_CATALOGS[0];
  return leaves(en).flatMap(([key, template]) => {
    const match = pattern.exec(template);
    return match === null ? [] : [{ key, names: match.slice(1) }];
  });
}

/**
 * The parameters a key is rendered with: each placeholder gets its spec value.
 * @param code - The sentence.
 * @param names - The placeholder name each spec value took.
 * @returns The ICU parameters.
 */
function paramsFor(code: Code, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(ARGS[code].map((arg, i) => [names[i], VALUES[arg]]));
}

afterEach(() => {
  changeLocale('en');
});

describe('W-132 the size-cap sentences in en and zh-CN', () => {
  it.each(CODES)('%s has an English key whose message is the spec sentence', (code) => {
    expect(keysFor(code).length).toBeGreaterThan(0);
  });

  it.each(CODES)('%s renders the spec sentence in en and in zh-CN on the same key', (code) => {
    const found = keysFor(code);
    expect(found.length).toBeGreaterThan(0);
    const args = ARGS[code].map((arg) => VALUES[arg]);
    for (const { key, names } of found) {
      const params = paramsFor(code, names);
      changeLocale('en');
      expect(t(key, params)).toBe(render(COPY_EN[code], args));
      changeLocale('zh-CN');
      const zh = t(key, params);
      expect(zh).toBe(render(COPY_ZH_CN[code], args));
      // The product noun stays English inside the Chinese sentence.
      if (code !== 'T_UPLOAD_FAILED') expect(zh).toContain('Space');
    }
  });
});

describe('W-133 the other catalogs carry every size-cap key', () => {
  const others = LOCALE_CATALOGS.filter(([tag]) => tag === 'ja' || tag === 'ko' || tag === 'zh-TW');

  it.each(CODES)('%s exists in ja, ko and zh-TW with the English placeholders and the word Space', (code) => {
    const found = keysFor(code);
    expect(found.length).toBeGreaterThan(0);
    const [, en] = LOCALE_CATALOGS[0];
    for (const { key, names } of found) {
      const english = readPath(en, key) as string;
      for (const [tag, catalog] of others) {
        const message = readPath(catalog, key);
        expect(typeof message, `${tag} ${key}`).toBe('string');
        expect((message as string).trim(), `${tag} ${key}`).not.toBe('');
        expect(placeholders(message as string), `${tag} ${key}`).toEqual(placeholders(english));
        if (code !== 'T_UPLOAD_FAILED') expect(message as string, `${tag} ${key}`).toContain('Space');
        changeLocale(tag);
        expect(() => t(key, paramsFor(code, names)), `${tag} ${key}`).not.toThrow();
      }
    }
  });

  it.each(['timeline.errors.full', 'timeline.errors.no_room'])('%s exists in all five catalogs', (key) => {
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      const message = readPath(catalog, key);
      expect(typeof message, `${tag} ${key}`).toBe('string');
      expect((message as string).trim(), `${tag} ${key}`).not.toBe('');
    }
  });

  it('timeline.errors.full and timeline.errors.no_room say the timeline sentences in en and zh-CN', () => {
    const [, en] = LOCALE_CATALOGS[0];
    const [, zhCN] = LOCALE_CATALOGS[1];
    expect(readPath(en, 'timeline.errors.full')).toBe(COPY_EN.T_TIMELINE_FULL);
    expect(readPath(zhCN, 'timeline.errors.full')).toBe(COPY_ZH_CN.T_TIMELINE_FULL);
    const noRoom = readPath(en, 'timeline.errors.no_room') as string;
    const [name] = placeholders(noRoom);
    changeLocale('en');
    expect(t('timeline.errors.no_room', { [name]: VALUES.r })).toBe(COPY_EN.T_NO_ROOM(VALUES.r));
    changeLocale('zh-CN');
    expect(t('timeline.errors.no_room', { [name]: VALUES.r })).toBe(COPY_ZH_CN.T_NO_ROOM(VALUES.r));
  });
});
