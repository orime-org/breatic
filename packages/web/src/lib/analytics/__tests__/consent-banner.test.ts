// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BannerModule from '@web/lib/analytics/consent-banner';

const library = vi.hoisted(() => ({
  consent: false,
  cookie: { categories: ['necessary'], revision: 1, data: { source: 'banner', decidedAt: '2026-10-12T00:00:00.000Z' }, lastConsentTimestamp: '' },
  run: vi.fn(async () => undefined),
  validConsent: vi.fn((): boolean => library.consent),
  getCookie: vi.fn(() => (library.consent ? library.cookie : {})),
  acceptCategory: vi.fn(),
  setCookieData: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  showPreferences: vi.fn(),
  setLanguage: vi.fn(async () => true),
}));

vi.mock('vanilla-cookieconsent', () => library);
vi.mock('vanilla-cookieconsent/dist/cookieconsent.css', () => ({}));
vi.mock('@web/lib/analytics/consent-banner.css', () => ({}));

const TEXT = {
  banner: { text: 't', privacy: 'p', acceptAll: 'a', rejectAll: 'r', settings: 's' },
  settings: {
    title: 't',
    save: 's',
    close: 'c',
    note: 'n',
    necessary: { title: 't', description: 'd' },
    analytics: { title: 't', description: 'd' },
    ads: { title: 't', description: 'd' },
  },
};

/**
 * A fresh banner, started for a visitor from a country.
 * @param country - The visitor's country.
 * @returns The module.
 */
async function startBanner(
  country: string,
  onChoice: (choice: unknown) => void = () => undefined,
): Promise<typeof BannerModule> {
  vi.resetModules();
  const banner = await import('@web/lib/analytics/consent-banner');
  await banner.startConsentBanner({
    cookieDomain: '',
    language: 'en',
    languages: ['en'],
    text: () => TEXT,
    privacyUrl: '/privacy',
    country: Promise.resolve(country),
    onChoice,
  });
  return banner;
}

/** Whether the banner is up after the latest call. */
function bannerShown(): boolean {
  const lastShow = library.show.mock.invocationCallOrder.at(-1) ?? 0;
  const lastHide = library.hide.mock.invocationCallOrder.at(-1) ?? 0;
  return lastShow > lastHide;
}

beforeEach(() => {
  vi.clearAllMocks();
  library.consent = false;
  library.cookie = { categories: ['necessary'], revision: 1, data: { source: 'banner', decidedAt: '2026-10-12T00:00:00.000Z' }, lastConsentTimestamp: '' };
});

describe('consent banner placement', () => {
  it('asks an undecided visitor only on the sign-in and sign-up pages', async () => {
    const banner = await startBanner('DE');
    expect(bannerShown()).toBe(false);
    banner.followPage('/studio');
    expect(bannerShown()).toBe(false);
    banner.followPage('/login');
    expect(bannerShown()).toBe(true);
    banner.followPage('/project/p1');
    expect(bannerShown()).toBe(false);
    banner.followPage('/register');
    expect(bannerShown()).toBe(true);
  });

  it('never shows the banner to a visitor whose choice is stored', async () => {
    library.consent = true;
    const banner = await startBanner('DE');
    banner.followPage('/login');
    expect(library.show).not.toHaveBeenCalled();
  });

  it('never shows the banner where both categories start on', async () => {
    const banner = await startBanner('US');
    banner.followPage('/register');
    expect(library.show).not.toHaveBeenCalled();
  });

  it('keeps the settings window available on every page', async () => {
    const banner = await startBanner('DE');
    banner.followPage('/studio');
    banner.openConsentSettings();
    expect(library.showPreferences).toHaveBeenCalled();
  });
});

describe('a choice changed in another tab', () => {
  it('is applied when this tab is shown again', async () => {
    library.consent = true;
    library.cookie = { ...library.cookie, categories: ['necessary', 'analytics', 'ads'] };
    const seen: unknown[] = [];
    await startBanner('DE', (choice) => seen.push(choice));
    library.cookie = { ...library.cookie, categories: ['necessary'], data: { source: 'settings', decidedAt: '2026-10-13T00:00:00.000Z' } };
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen.at(-1)).toMatchObject({ analytics: false, ads: false, source: 'settings' });
  });

  it('changes nothing when the stored choice is the same', async () => {
    library.consent = true;
    const seen: unknown[] = [];
    await startBanner('DE', (choice) => seen.push(choice));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toHaveLength(1);
  });
});
