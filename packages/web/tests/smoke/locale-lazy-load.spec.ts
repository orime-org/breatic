// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Only English ships in the entry; every other language is downloaded at
 * startup or when the reader picks it from the language menu (breatic#1374).
 * Measured in a browser because the questions are about what is painted and
 * what the network delivers: whether the first frame is already in the stored
 * language, what a failed download leaves on screen, and whether the menu item
 * shows the wait.
 *
 * Every case runs signed out on the sign-in page: there the stored choice alone
 * decides the language, and a pick writes nothing to a slot account that other
 * specs read their language from.
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/locale-lazy-load.spec.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';

import { test } from '../helpers/slot';

const STORAGE_KEY = 'breatic.locale';

/**
 * A message from a shipped locale file.
 * @param locale - Locale tag, the file's base name.
 * @param path - Dotted key path.
 * @returns The message.
 * @throws {Error} When the locale file has no string at that path.
 */
function copy(locale: string, path: string): string {
  const catalog: unknown = JSON.parse(readFileSync(join(__dirname, '../../../../locales', `${locale}.json`), 'utf8'));
  const value = path.split('.').reduce<unknown>(
    (node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    catalog,
  );
  if (typeof value !== 'string') throw new Error(`locales/${locale}.json has no string at ${path}`);
  return value;
}

/**
 * Requests for a locale's downloaded catalog: the JSON module the dev server
 * serves, or the `locale-<code>-` chunk of a build.
 * @param locale - Locale tag.
 * @returns A matcher for `page.route`.
 */
function chunkOf(locale: string): RegExp {
  const tag = locale.replace('-', '\\-');
  return new RegExp(`/locales/${tag}\\.json|/locale-${tag}-[^/]*\\.js`);
}

/**
 * The language the sign-in page is shown in, read from its title.
 * @param page - The page.
 * @param locale - Locale tag whose title should be on screen.
 */
async function expectSignInIn(page: Page, locale: string): Promise<void> {
  await expect(page.locator('#root').getByText(copy(locale, 'auth.login.title'), { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('downloaded languages', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a stored language is on the first frame, with no English painted before it', async ({ page }) => {
    await page.addInitScript(
      ({ key, english }) => {
        window.localStorage.setItem(key, 'zh-CN');
        const w = window as unknown as { __englishSeen: boolean };
        w.__englishSeen = false;
        new MutationObserver(() => {
          if ((document.getElementById('root')?.textContent ?? '').includes(english)) w.__englishSeen = true;
        }).observe(document, { subtree: true, childList: true, characterData: true });
      },
      { key: STORAGE_KEY, english: copy('en', 'auth.login.title') },
    );

    await page.goto('/login');
    await expectSignInIn(page, 'zh-CN');

    expect(
      await page.evaluate(() => (window as unknown as { __englishSeen: boolean }).__englishSeen),
      'the English sign-in title was never painted before the Chinese one',
    ).toBe(false);
  });

  test('a language whose download fails says so and leaves the page in its language', async ({ page }) => {
    await page.route(chunkOf('ja'), (route) => route.abort());
    await page.goto('/login');
    await expectSignInIn(page, 'en');
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);

    await page.getByTestId('lang-trigger').click();
    await page.getByTestId('lang-option-ja').click();

    await expect(page.getByText(copy('en', 'chrome.languageLoadFailed'))).toBeVisible();
    await expect(page.getByTestId('lang-popover')).toBeVisible();
    await expect(page.getByTestId('lang-option-ja')).not.toHaveAttribute('aria-busy', 'true');
    await expectSignInIn(page, 'en');
    expect(await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe(stored);
  });

  test('a language picked from the menu shows its item loading, then switches and closes the menu', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(chunkOf('ko'), async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/login');
    await expectSignInIn(page, 'en');

    await page.getByTestId('lang-trigger').click();
    await page.getByTestId('lang-option-ko').click();

    await expect(page.getByTestId('lang-option-ko')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('lang-popover')).toBeVisible();
    await expectSignInIn(page, 'en');

    release();

    await expectSignInIn(page, 'ko');
    await expect(page.getByTestId('lang-popover')).toHaveCount(0);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe('ko');
  });
});
