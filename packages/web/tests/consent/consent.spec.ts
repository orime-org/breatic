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
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type BrowserContext, type Page, type Request } from 'playwright/test';

import { test } from '../helpers/slot';
import { NO_VENDORS_TAG, TEST_AMPLITUDE_API_KEY, TEST_GOOGLE_ADS_TAG_ID } from './vendors';

const REPORT_PATH = '/users/me/consent';

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
 * Answer everything that leaves the app; requests to the app's own API reach the real server.
 * @param context - The browser profile.
 * @param options - The visitor.
 * @param options.country - The region the trace reports.
 * @param options.gpc - Whether the browser sends GPC.
 * @param options.gpcHeader - Whether every request carries `Sec-GPC: 1`.
 */
async function prepare(
  context: BrowserContext,
  options: { country: string; gpc?: boolean; gpcHeader?: boolean },
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

  test('a GPC visitor keeps the banner GPC line across a language change, and Accept all turns ads on', async ({ page, context }) => {
    await prepare(context, { country: 'DE', gpc: true });
    await page.goto('/login');
    const notice = page.locator('#cc-main .cm__desc .breatic-consent-notice');
    await expect(notice).toBeVisible();
    await page.getByTestId('lang-trigger').click();
    await page.getByTestId('lang-option-ja').click();
    await expect(notice).toBeVisible();
    await page.locator('#cc-main .cm [data-role="all"]').click();
    await expect.poll(async () => (await consentCookie(context))?.categories.toSorted()).toEqual(['ads', 'analytics', 'necessary']);
  });
});

/** The settings window. */
const settings = (page: Page) => page.locator('#cc-main .pm');

/**
 * The next report this page sends to the account, with the server's answer.
 * @param page - The page.
 * @returns The request body and the response status.
 */
async function nextReport(page: Page): Promise<{ body: unknown; status: number }> {
  const response = await page.waitForResponse((r) => r.url().endsWith(REPORT_PATH) && r.request().method() === 'PUT');
  return { body: response.request().postDataJSON(), status: response.status() };
}

test.describe('signed in', () => {
  test('reports this browser’s choice once the app knows who is signed in, and again after a change in Cookie settings', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
    await prepare(context, { country: 'US' });
    const first = nextReport(page);
    await page.goto('/studio');
    expect(await first).toEqual({ body: { analytics: true, ads: true }, status: 204 });
    await openCookieSettings(page);
    await expect(adsSwitch(page)).toBeChecked();
    await adsSwitch(page).click();
    const second = nextReport(page);
    await settings(page).locator('[data-role="save"]').click();
    expect(await second).toEqual({ body: { analytics: true, ads: false }, status: 204 });
    await expect(settings(page)).toBeHidden();
    await expect.poll(async () => (await consentCookie(context))?.categories.toSorted()).toEqual(['analytics', 'necessary']);
  });

  test('the settings window’s category titles are headings a keyboard passes over, and their descriptions are read out', async ({ page, context }) => {
    await prepare(context, { country: 'US' });
    await page.goto('/studio');
    await openCookieSettings(page);
    await expect(settings(page)).toBeVisible();
    // The library moves focus into the window once its opening transition ends.
    await page.waitForTimeout(700);
    const titles = settings(page).locator('.pm__section--toggle .pm__section-title');
    expect(await titles.evaluateAll((all) => all.map((title) => [title.tagName, title.getAttribute('role'), title.hasAttribute('aria-expanded')]))).toEqual([
      ['DIV', 'heading', false],
      ['DIV', 'heading', false],
      ['DIV', 'heading', false],
    ]);
    await expect(settings(page).locator('.pm__section-desc-wrapper[aria-hidden]')).toHaveCount(0);
    const stops: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          return el?.getAttribute('data-role') ?? el?.getAttribute('value') ?? el?.className ?? '';
        }),
      );
    }
    expect(stops).toEqual(['pm__close-btn', 'analytics', 'ads', 'all', 'necessary', 'save']);
  });

  test('a GPC browser shows the GPC line under a switch that can be turned on, and turning it on loads the ad tag', async ({ page, context }) => {
    const outside = await prepare(context, { country: 'US', gpc: true, gpcHeader: true });
    const first = nextReport(page);
    await page.goto('/studio');
    expect((await first).body).toEqual({ analytics: true, ads: false });
    await openCookieSettings(page);
    await expect(settings(page).locator('.breatic-consent-notice')).toHaveText(
      'Your browser sends Global Privacy Control, so advertising is off by default.',
    );
    await expect(adsSwitch(page)).toBeEnabled();
    await expect(adsSwitch(page)).not.toBeChecked();
    await adsSwitch(page).click();
    const second = nextReport(page);
    await settings(page).locator('[data-role="save"]').click();
    expect(await second).toEqual({ body: { analytics: true, ads: true }, status: 204 });
    await expect.poll(() => outside.some((r) => new URL(r.url()).hostname === 'www.googletagmanager.com')).toBe(true);
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

  test('a build without the analytics variables ships no analytics, ad or banner code', { tag: NO_VENDORS_TAG }, () => {
    // The build the no-vendors preview serves (playwright.consent.config.ts). Exact hostnames and selectors:
    // the bare word "amplitude" also appears in unrelated markup.
    const build = resolve(__dirname, '../../playwright/.consent/no-vendors');
    const markers = ['googletagmanager.com', 'api2.amplitude.com', 'cookieconsent', '#cc-main'];
    const files = readdirSync(build, { recursive: true, encoding: 'utf8' }).filter((file) => /\.(js|html)$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) => {
      const text = readFileSync(resolve(build, file), 'utf8');
      return markers.filter((marker) => text.includes(marker)).map((marker) => `${file}: ${marker}`);
    });
    expect(found).toEqual([]);
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
      // Session tracking sends a start event as soon as the SDK loads, so the project check below has something to read.
      await expect.poll(() => outside.some((r) => new URL(r.url()).hostname === 'api2.amplitude.com')).toBe(true);
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
});
