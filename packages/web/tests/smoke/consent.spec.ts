// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent banner and Cookie settings against the real app (inner#1442).
 * Needs a dev build with the analytics variables set; the region lookup, the
 * account's consent record and the vendors' scripts are answered here.
 */
import { expect, type BrowserContext, type Page, type Route } from 'playwright/test';

import { test } from '../helpers/slot';

const ACCOUNT_PATH = '/users/me/ads-sharing';

/**
 * A stored consent cookie with both categories accepted in the banner.
 * @returns The cookie value.
 */
function storedConsent(): string {
  const decidedAt = new Date(Date.now() - 3_600_000).toISOString();
  // Every field the banner library writes, so the library holds the choice as a real visitor's browser would.
  return encodeURIComponent(
    JSON.stringify({
      categories: ['necessary', 'analytics', 'ads'],
      revision: 1,
      data: { analytics: { decidedAt, source: 'banner' }, ads: { decidedAt, source: 'banner' } },
      consentTimestamp: decidedAt,
      consentId: '44444444-4444-4444-8444-444444444444',
      services: { necessary: [], analytics: [], ads: [] },
      languageCode: 'en',
      lastConsentTimestamp: decidedAt,
      expirationTime: Date.now() + 300 * 86_400_000,
    }),
  );
}

/**
 * The account's ad switch as the server answers it.
 * @param optedOut - Whether the account has opted out.
 * @returns The response body.
 */
function sharing(optedOut: boolean): string {
  return JSON.stringify({ data: { optedOut, source: optedOut ? 'settings' : null } });
}

/**
 * Answer everything that leaves the app, and the account record as given.
 * @param context - The browser profile.
 * @param options - The visitor.
 * @param options.country - The region the trace reports.
 * @param options.gpc - Whether the browser sends GPC.
 * @param options.account - Answers the account record request.
 */
async function prepare(
  context: BrowserContext,
  options: { country: string; gpc?: boolean; account?: (route: Route) => Promise<void> },
): Promise<void> {
  await context.addInitScript((gpc: boolean) => {
    // The banner library stays off in automated browsers.
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    if (gpc) Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
  }, options.gpc === true);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/cdn-cgi/trace') return route.fulfill({ status: 200, body: `loc=${options.country}\n` });
    if (url.pathname.endsWith(ACCOUNT_PATH) && options.account) return options.account(route);
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
}

/**
 * The consent cookie as the page left it.
 * @param context - The browser profile.
 * @returns The parsed cookie, or null.
 */
async function consentCookie(context: BrowserContext): Promise<{ categories: string[] } | null> {
  const cookie = (await context.cookies()).find((c) => c.name === 'breatic_consent');
  return cookie ? (JSON.parse(decodeURIComponent(cookie.value)) as { categories: string[] }) : null;
}

/**
 * Open Cookie settings from the account menu.
 * @param page - The page.
 */
async function openCookieSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Cookie settings' }).click();
}

/** The settings window's ads switch. */
const adsSwitch = (page: Page) => page.locator('#cc-main .pm input[value="ads"]');

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a GPC visitor keeps the banner GPC line across a language change, and Accept all keeps ads off', async ({ page, context }) => {
    await prepare(context, { country: 'DE', gpc: true });
    await page.goto('/login');
    const notice = page.locator('#cc-main .cm__desc .breatic-consent-notice');
    await expect(notice).toBeVisible();
    await page.getByTestId('lang-trigger').click();
    await page.getByTestId('lang-option-ja').click();
    await expect(notice).toBeVisible();
    await page.locator('#cc-main .cm [data-role="all"]').click();
    await expect.poll(async () => (await consentCookie(context))?.categories.toSorted()).toEqual(['analytics', 'necessary']);
  });
});

/** The settings window. */
const settings = (page: Page) => page.locator('#cc-main .pm');

test.describe('signed in', () => {
  test('an account opted out on another device shows so, and turning ads back on asks first and then records it', async ({ page, context, baseURL }) => {
    const puts: unknown[] = [];
    await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
    await prepare(context, {
      country: 'US',
      account: async (route) => {
        if (route.request().method() === 'PUT') {
          const body = route.request().postDataJSON() as { allowed: boolean };
          puts.push(body);
          return route.fulfill({ status: 200, contentType: 'application/json', body: sharing(!body.allowed) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: sharing(true) });
      },
    });
    await page.goto('/studio');
    await openCookieSettings(page);
    await expect(settings(page).locator('.breatic-consent-notice')).toHaveText('Your account has opted out of ad sharing');
    await expect(adsSwitch(page)).not.toBeChecked();
    await adsSwitch(page).click();
    await settings(page).locator('[data-role="save"]').click();
    await expect(settings(page).locator('.breatic-consent-confirm')).toBeVisible();
    expect(puts).toEqual([]);
    await settings(page).locator('[data-breatic-confirm="yes"]').click();
    await expect.poll(() => puts).toEqual([{ allowed: true }]);
    await expect.poll(async () => (await consentCookie(context))?.categories).toContain('ads');
  });

  test('a refusal that cannot reach the account keeps the window open and the cookie as it was', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
    await prepare(context, {
      country: 'US',
      account: (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
          : route.fulfill({ status: 200, contentType: 'application/json', body: sharing(false) }),
    });
    await page.goto('/studio');
    await openCookieSettings(page);
    await expect(adsSwitch(page)).toBeChecked();
    await settings(page).locator('[data-role="necessary"]').click();
    await expect(settings(page).locator('.breatic-consent-error')).toBeVisible();
    await expect(settings(page)).toBeVisible();
    expect((await consentCookie(context))?.categories).toContain('ads');
  });

  test('a GPC browser shows the switch off and locked, and a save sends nothing to the account', async ({ page, context, baseURL }) => {
    const puts: unknown[] = [];
    await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
    await prepare(context, {
      country: 'US',
      gpc: true,
      account: (route) => {
        if (route.request().method() === 'PUT') puts.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, contentType: 'application/json', body: sharing(true) });
      },
    });
    await page.goto('/studio');
    await openCookieSettings(page);
    await expect(settings(page).locator('.breatic-consent-notice')).toHaveText('Opted out via Global Privacy Control (GPC)');
    await expect(adsSwitch(page)).toBeDisabled();
    await expect(adsSwitch(page)).not.toBeChecked();
    await settings(page).locator('[data-role="save"]').click();
    await expect(settings(page)).toBeHidden();
    expect((await consentCookie(context))?.categories).toContain('analytics');
    expect(puts).toEqual([]);
  });
});
