// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent banner, Cookie settings and what leaves the app (inner#1442),
 * against the real app. The region lookup and the vendors' endpoints are
 * answered here, and every request to them is recorded.
 *
 * Run with `pnpm test:consent` (playwright.consent.config.ts), which builds
 * the app with and without the vendor variables: cases tagged `@no-vendors`
 * run against the build without them, the rest against the build with them.
 */
import { expect, type BrowserContext, type Page, type Request, type Route } from 'playwright/test';

import { stateFile, test } from '../helpers/slot';
import { NO_VENDORS_TAG, TEST_AMPLITUDE_API_KEY, TEST_GOOGLE_ADS_TAG_ID } from './vendors';

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
  options: { country: string; gpc?: boolean; gpcHeader?: boolean; account?: (route: Route) => Promise<void> },
): Promise<Request[]> {
  const outside: Request[] = [];
  await context.addInitScript((gpc: boolean) => {
    // The banner library stays off in automated browsers.
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    if (gpc) Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
  }, options.gpc === true);
  // The header a GPC browser sends on every request, which the server reads; the page alone reads the property.
  if (options.gpcHeader === true) await context.setExtraHTTPHeaders({ 'Sec-GPC': '1' });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/cdn-cgi/trace') {
      outside.push(route.request());
      return route.fulfill({ status: 200, body: `loc=${options.country}\n` });
    }
    if (url.pathname.endsWith(ACCOUNT_PATH) && options.account) return options.account(route);
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    outside.push(route.request());
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  return outside;
}

/**
 * Whether a request goes to an advertising service.
 * @param request - The request.
 * @returns True for Google's tag and ad hosts, and its conversion paths.
 */
function isAdRequest(request: Request): boolean {
  const { hostname, pathname } = new URL(request.url());
  if (/(^|\.)(googletagmanager|googleadservices|doubleclick|googlesyndication)\./.test(hostname)) return true;
  return /(^|\.)google\.[a-z.]+$/.test(hostname) && /^\/(pagead|ads)\//.test(pathname);
}

/** Hosts the app reaches for a feature the visitor uses, not for measurement: Sign in with Google's script. */
const FEATURE_HOSTS = ['accounts.google.com'];

/**
 * The hosts of the requests that left the app for anything but the region lookup and a feature host.
 * @param outside - The recorded requests.
 * @returns The hosts.
 */
function vendorHosts(outside: Request[]): string[] {
  return outside
    .map((r) => new URL(r.url()))
    .filter((url) => url.pathname !== '/cdn-cgi/trace' && !FEATURE_HOSTS.includes(url.hostname))
    .map((url) => url.hostname);
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

  test('a refusal that cannot reach the account still holds in this browser, keeps the window open saying so, and reaches the account on a retry', async ({ page, context, baseURL }) => {
    let accountUp = false;
    const puts: unknown[] = [];
    await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
    await prepare(context, {
      country: 'US',
      account: (route) => {
        if (route.request().method() !== 'PUT') return route.fulfill({ status: 200, contentType: 'application/json', body: sharing(false) });
        puts.push(route.request().postDataJSON());
        return accountUp
          ? route.fulfill({ status: 200, contentType: 'application/json', body: sharing(true) })
          : route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      },
    });
    await page.goto('/studio');
    await openCookieSettings(page);
    await expect(adsSwitch(page)).toBeChecked();
    await settings(page).locator('[data-role="necessary"]').click();
    await expect(settings(page).locator('.breatic-consent-error')).toHaveText(/Saved in this browser/);
    await expect(settings(page)).toBeVisible();
    await expect.poll(async () => (await consentCookie(context))?.categories).toEqual(['necessary']);
    accountUp = true;
    await settings(page).locator('[data-role="necessary"]').click();
    await expect(settings(page)).toBeHidden();
    expect(puts).toEqual([{ allowed: false }, { allowed: false }]);
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

/** Long enough for a vendor that was going to load after a decision to have asked for its script. */
const SETTLE_MS = 1500;

test.describe('what leaves the app', () => {
  test('a build without the analytics variables sends nothing anywhere and offers no consent', { tag: NO_VENDORS_TAG }, async ({ page, context }) => {
    const outside = await prepare(context, { country: 'DE' });
    await page.goto('/studio');
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menuitem').first()).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Cookie settings' })).toHaveCount(0);
    await page.waitForTimeout(SETTLE_MS);
    expect(await page.locator('#cc-main').count()).toBe(0);
    expect(outside.map((r) => r.url())).toEqual([]);
  });

  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('a visitor who must be asked first sends nothing to any vendor before choosing', async ({ page, context }) => {
      const outside = await prepare(context, { country: 'DE' });
      await page.goto('/login');
      await expect(page.locator('#cc-main .cm')).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);
      expect(vendorHosts(outside)).toEqual([]);
    });

    test('after Accept all, requests go only to the configured Amplitude project and Google tag', async ({ page, context }) => {
      const outside = await prepare(context, { country: 'DE' });
      await page.goto('/login');
      await page.locator('#cc-main .cm [data-role="all"]').click();
      await expect.poll(() => outside.some((r) => new URL(r.url()).hostname === 'www.googletagmanager.com')).toBe(true);
      await page.waitForTimeout(SETTLE_MS);
      expect([...new Set(vendorHosts(outside))].filter((h) => !['www.googletagmanager.com', 'api2.amplitude.com'].includes(h))).toEqual([]);
      const tagIds = outside.filter((r) => new URL(r.url()).hostname === 'www.googletagmanager.com').map((r) => new URL(r.url()).searchParams.get('id'));
      expect(new Set(tagIds)).toEqual(new Set([TEST_GOOGLE_ADS_TAG_ID]));
      const amplitudeBodies = outside.filter((r) => new URL(r.url()).hostname === 'api2.amplitude.com').map((r) => r.postData() ?? '');
      for (const body of amplitudeBodies) expect(body).toContain(TEST_AMPLITUDE_API_KEY);
    });

    test('a GPC browser where consent starts on sends nothing to an advertising service', async ({ page, context }) => {
      const outside = await prepare(context, { country: 'US', gpc: true, gpcHeader: true });
      await page.goto('/login');
      await expect.poll(async () => (await consentCookie(context))?.categories ?? null).toContain('analytics');
      await page.waitForTimeout(SETTLE_MS);
      expect(outside.filter(isAdRequest).map((r) => r.url())).toEqual([]);
    });
  });

  test('after the account sent GPC from another browser, this signed-in browser sends nothing to an advertising service', async ({
    page,
    context,
    browser,
    baseURL,
  }) => {
    const elsewhere = await browser.newContext({ storageState: stateFile('A'), baseURL });
    try {
      await prepare(elsewhere, { country: 'US', gpc: true, gpcHeader: true });
      const other = await elsewhere.newPage();
      const answered = other.waitForResponse((r) => r.url().endsWith(ACCOUNT_PATH) && r.request().method() === 'GET');
      await other.goto('/studio');
      expect(await (await answered).json()).toMatchObject({ data: { optedOut: true, source: 'gpc' } });
    } finally {
      await elsewhere.close();
    }
    try {
      await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
      const outside = await prepare(context, { country: 'US' });
      const answered = page.waitForResponse((r) => r.url().endsWith(ACCOUNT_PATH) && r.request().method() === 'GET');
      await page.goto('/studio');
      await answered;
      await page.waitForTimeout(SETTLE_MS);
      expect(outside.filter(isAdRequest).map((r) => r.url())).toEqual([]);
      await openCookieSettings(page);
      await expect(settings(page).locator('.breatic-consent-notice')).toHaveText('Your account has opted out of ad sharing');
    } finally {
      // The slot's account is shared with other cases: open its switch again from this browser, which sends no GPC.
      const reopened = await page.request.put(`/api/v1${ACCOUNT_PATH}`, { data: { allowed: true } });
      expect(reopened.ok()).toBe(true);
    }
  });
});
