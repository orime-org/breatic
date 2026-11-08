// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The copy `web_fetch` puts on screen, in all five locales (inner#1664).
 *
 * The running line is an ICU plural over `count`: 0 is a sentence naming no
 * site (the arguments have not arrived), 1 names the site by `{host}`, and
 * more say how many pages with `#`. Chinese, Japanese and Korean have no
 * `one` plural category, so a count of 1 there is only told apart by an
 * exact branch; the checks below ask what each locale renders, not which
 * branch name it used.
 *
 * Whether the six new failure lines exist in every locale is already asked
 * by `tool-failure-line-parity.test.ts`, which reads them off `FAILURE_LINES`;
 * here they are only formatted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FAILURE_LINES, setLocale, t } from '@breatic/shared';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import { expectEveryLocaleRenders } from '@web/test-utils/i18n-keys';

/** The running line's key. */
const READING = 'chat.tool.readingPages';

/** The failed step's key. */
const STEP = 'chat.tool.step.webFetch';

/** The failure lines `web_fetch` adds, read off the table so they cannot drift. */
const NEW_FAILURES = [
  FAILURE_LINES.linkNotInConversation,
  FAILURE_LINES.pageNeedsLogin,
  FAILURE_LINES.pageRefused,
  FAILURE_LINES.pageTooSlow,
  FAILURE_LINES.pageEmpty,
  FAILURE_LINES.pagesUnreadable,
];

afterEach(() => {
  setLocale('en');
});

describe('the reading-pages line', () => {
  it.each(LOCALE_CATALOGS)('%s is a plural over count with =0 and other branches', (_tag, catalog) => {
    const message = readPath(catalog, READING);

    expect(typeof message).toBe('string');
    expect(message as string).toMatch(/\{\s*count\s*,\s*plural\s*,/);
    expect(message as string).toMatch(/=0\s*\{/);
    expect(message as string).toMatch(/\bother\s*\{[^{}]*#/);
    // English selects `one` for 1; the other four select `other` unless an
    // exact `=1` branch catches it first.
    expect(message as string).toMatch(/(\bone|=1)\s*\{[^{}]*\{host\}/);
  });

  it.each(LOCALE_CATALOGS)('%s names the site for one page', (tag) => {
    setLocale(tag);

    const shown = t(READING, { host: 'www.example.com', count: 1 });

    expect(shown).toContain('www.example.com');
    expect(shown).not.toContain('{host}');
  });

  it.each(LOCALE_CATALOGS)('%s gives the count and no site for several pages', (tag) => {
    setLocale(tag);

    const shown = t(READING, { host: 'www.example.com', count: 7 });

    expect(shown).toContain('7');
    expect(shown).not.toContain('www.example.com');
  });

  it.each(LOCALE_CATALOGS)('%s names no site and no number before the arguments arrive', (tag) => {
    setLocale(tag);

    const shown = t(READING, { host: '', count: 0 });

    expect(shown).not.toMatch(/[0-9]/);
    expect(shown).not.toBe(READING);
    expect(shown.trim()).not.toBe('');
  });
});

describe('the rest of the web_fetch copy', () => {
  it('renders in every locale, the step and the six failure lines included', () => {
    expectEveryLocaleRenders([
      { key: READING, params: { host: 'www.example.com', count: 1 } },
      { key: READING, params: { host: '', count: 0 } },
      { key: READING, params: { host: 'www.example.com', count: 3 } },
      { key: STEP },
      ...NEW_FAILURES.map((key) => ({ key })),
    ]);
  });

  it.each(LOCALE_CATALOGS)('%s carries the failed-step label as plain text', (_tag, catalog) => {
    const message = readPath(catalog, STEP);

    expect(typeof message).toBe('string');
    expect((message as string).trim()).not.toBe('');
  });
});
