// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent banner and Cookie settings against the real app (inner#1442).
 * Needs a dev build with the analytics variables set; the region lookup, the
 * account's consent record and the vendors' scripts are answered here.
 */
import { test, expect, type BrowserContext, type Page, type Route } from 'playwright/test';

const ACCOUNT_PATH = '/users/me/analytics-consent';
const ADS_ID = '22222222-2222-4222-8222-222222222222';

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
      data: {
        analytics: { decisionId: '11111111-1111-4111-8111-111111111111', decidedAt, source: 'banner' },
        ads: { decisionId: ADS_ID, decidedAt, source: 'banner', noticeShown: false, gpcAtDecision: false },
      },
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
 * The account record with another device's ads opt-out on it.
 * @returns The record.
 */
function optedOutAccount(): Record<string, unknown> {
  const decidedAt = new Date().toISOString();
  return {
    receipts: [{ decisionId: '33333333-3333-4333-8333-333333333333', value: false, source: 'settings', noticeShown: false, decidedAt, revision: 1 }],
    gpcSeenAt: null,
    ownership: 'none',
    serverTime: decidedAt,
  };
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
    const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === '/_consent/refresh');
    await page.locator('#cc-main .cm [data-role="all"]').click();
    await expect.poll(async () => (await consentCookie(context))?.categories.toSorted()).toEqual(['analytics', 'necessary']);
    // The server wrote the value back (design §4.4.3a), so Safari's cap on script-written cookies does not apply.
    const response = await refreshed;
    expect(response.status()).toBe(204);
    const written = (await response.allHeaders())['set-cookie'] ?? '';
    const stored = (await context.cookies()).find((c) => c.name === 'breatic_consent');
    expect(written.startsWith(`breatic_consent=${stored?.value};`)).toBe(true);
  });
});

test.describe('signed in', () => {
  test('an opt-out that arrives while Cookie settings is open moves a switch the visitor changed before it', async ({ page, context, baseURL }) => {
    let release = (): void => undefined;
    const answer = new Promise<void>((resolve) => (release = resolve));
    await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
    await prepare(context, {
      country: 'US',
      account: async (route) => {
        await answer;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: optedOutAccount() }) });
      },
    });
    await page.goto('/studio');
    await openCookieSettings(page);
    await expect(adsSwitch(page)).toBeChecked();
    await adsSwitch(page).click();
    await adsSwitch(page).click();
    await expect(adsSwitch(page)).toBeChecked();
    release();
    await expect(adsSwitch(page)).not.toBeChecked();
    await expect(page.locator('#cc-main .pm .breatic-consent-notice')).toBeVisible();
    await page.locator('#cc-main .pm [data-role="save"]').click();
    await expect.poll(async () => (await consentCookie(context))?.categories).not.toContain('ads');
  });

  test('an account answer that is not the account record leaves a later withdrawal working', async ({ page, context, baseURL }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await context.addCookies([{ name: 'breatic_consent', value: storedConsent(), url: baseURL }]);
    await prepare(context, {
      country: 'US',
      account: (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ownership: 'self' } }) }),
    });
    await page.goto('/studio');
    await openCookieSettings(page);
    await page.locator('#cc-main .pm [data-role="necessary"]').click();
    await expect.poll(async () => (await consentCookie(context))?.categories).toEqual(['necessary']);
    expect(errors).toEqual([]);
  });
});
