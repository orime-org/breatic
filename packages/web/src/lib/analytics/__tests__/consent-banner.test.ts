// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BannerModule from '@web/lib/analytics/consent-banner';

const library = vi.hoisted(() => ({
  consent: false,
  cookie: { categories: ['necessary'], revision: 1, data: { source: 'banner', decidedAt: '2026-10-12T00:00:00.000Z' }, lastConsentTimestamp: '' },
  config: null as null | Record<string, (arg?: unknown) => void>,
  run: vi.fn(async (config: Record<string, (arg?: unknown) => void>) => {
    library.config = config;
  }),
  reset: vi.fn(),
  validConsent: vi.fn((): boolean => library.consent),
  getCookie: vi.fn(() => (library.consent ? library.cookie : {})),
  acceptCategory: vi.fn(),
  // The library rewrites the stored cookie's data.
  setCookieData: vi.fn(({ value }: { value: unknown }) => {
    library.cookie = { ...library.cookie, data: value as typeof library.cookie.data };
  }),
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

// Each test starts a fresh banner module; listeners an earlier one left on the page would answer for it.
const added: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];
for (const target of [document, window] as EventTarget[]) {
  const add = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    if (listener) added.push([target, type, listener]);
    add(type, listener, options);
  });
}

afterEach(() => {
  for (const [target, type, listener] of added.splice(0)) target.removeEventListener(type, listener);
});

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
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ analytics: false, ads: false, source: 'settings' }));
  });

  it('changes nothing when the stored choice is the same', async () => {
    library.consent = true;
    const seen: unknown[] = [];
    await startBanner('DE', (choice) => seen.push(choice));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toHaveLength(1);
  });

  it('restarts the banner library on the stored choice, so its settings window and its next save start from it', async () => {
    library.consent = true;
    await startBanner('DE');
    library.cookie = { ...library.cookie, categories: ['necessary', 'analytics', 'ads'], data: { source: 'banner', decidedAt: '2026-10-13T00:00:00.000Z' } };
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(library.reset).toHaveBeenCalledWith(false));
    // Restarted after the reset, so the library's own copy of the choice is the cookie's.
    await vi.waitFor(() =>
      expect(library.run.mock.invocationCallOrder.at(-1)).toBeGreaterThan(library.reset.mock.invocationCallOrder.at(-1) ?? Infinity),
    );
  });

  it('stops asking once another tab decided', async () => {
    const banner = await startBanner('DE');
    banner.followPage('/login');
    expect(bannerShown()).toBe(true);
    library.consent = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(bannerShown()).toBe(false));
  });

  it('asks again when the stored choice disappeared while the tab was hidden', async () => {
    library.consent = true;
    const banner = await startBanner('DE');
    banner.followPage('/login');
    expect(bannerShown()).toBe(false);
    library.consent = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(bannerShown()).toBe(true));
  });
});

describe('what counts as the visitor choosing', () => {
  it('files the visitor\'s choice under the window it was made in', async () => {
    const seen: unknown[] = [];
    await startBanner('DE', (choice) => seen.push(choice));
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    // The library reports a choice saved in the window before it hides the window.
    library.config?.onFirstConsent?.();
    library.config?.onModalHide?.({ modalName: 'preferencesModal' });
    expect(library.setCookieData).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ source: 'settings' }) }));
    expect(seen).toHaveLength(2);
  });

  it('files a save in the settings window that confirms the stored choice as the visitor\'s', async () => {
    library.consent = true;
    library.cookie = { ...library.cookie, categories: ['necessary', 'analytics', 'ads'], data: { source: 'implicit', decidedAt: '2026-10-12T00:00:00.000Z' } };
    const seen: unknown[] = [];
    await startBanner('US', (choice) => seen.push(choice));
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    document.body.innerHTML = '<div id="cc-main"><div class="pm"><button data-role="all"></button></div></div>';
    try {
      // The library saves nothing and reports nothing when no category changes; it then hides the window.
      document.querySelector<HTMLButtonElement>('[data-role="all"]')?.click();
      library.config?.onModalHide?.({ modalName: 'preferencesModal' });
    } finally {
      document.body.innerHTML = '';
    }
    expect(seen).toHaveLength(2);
    // The save is the latest decision, made now: the cookie records it, so a report from a later page carries it too.
    const stamped = library.setCookieData.mock.calls.at(-1)?.[0] as { value: { source: string; decidedAt: string } };
    expect(stamped.value.source).toBe('settings');
    expect(Date.parse(stamped.value.decidedAt)).toBeGreaterThan(Date.parse('2026-10-12T00:00:00.000Z'));
    expect((seen.at(-1) as { decidedAt: string }).decidedAt).toBe(stamped.value.decidedAt);
    expect(seen.at(-1)).toMatchObject({ source: 'settings', analytics: true, ads: true });
  });

  it('does not carry a press from a window that never hid into the next one', async () => {
    library.consent = true;
    await startBanner('US');
    document.body.innerHTML = '<div id="cc-main"><div class="pm"><button data-role="save"></button></div></div>';
    try {
      // A second click of a double click lands while the window fades out; no hide follows it.
      document.querySelector<HTMLButtonElement>('[data-role="save"]')?.click();
    } finally {
      document.body.innerHTML = '';
    }
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    library.config?.onModalHide?.({ modalName: 'preferencesModal' });
    expect(library.setCookieData).not.toHaveBeenCalled();
  });

  it('does not file closing the settings window as a choice', async () => {
    library.consent = true;
    await startBanner('US');
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    library.config?.onModalHide?.({ modalName: 'preferencesModal' });
    expect(library.setCookieData).not.toHaveBeenCalled();
  });

  it('does not file its own load decision as the visitor\'s, though a window was opened and closed without a choice', async () => {
    library.consent = true;
    await startBanner('US');
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    // The stored choice disappears while the tab is hidden; the restart writes the regional default.
    library.consent = false;
    library.acceptCategory.mockImplementationOnce(() => library.config?.onFirstConsent?.());
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(library.acceptCategory).toHaveBeenCalled());
    expect(library.setCookieData).not.toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ source: 'settings' }) }));
  });
});

describe('robustness', () => {
  it('leaves a crawler or automated browser alone, as the library does', async () => {
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => true });
    try {
      const seen: unknown[] = [];
      const banner = await startBanner('DE', (choice) => seen.push(choice));
      banner.followPage('/login');
      banner.openConsentSettings();
      expect(library.run).not.toHaveBeenCalled();
      expect(library.show).not.toHaveBeenCalled();
      expect(library.showPreferences).not.toHaveBeenCalled();
      expect(seen).toEqual([null]);
    } finally {
      Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    }
  });

  it('picks up a choice made in another window when this one gets focus', async () => {
    library.consent = true;
    await startBanner('DE');
    library.cookie = { ...library.cookie, categories: ['necessary', 'analytics'], data: { source: 'settings', decidedAt: '2026-10-14T00:00:00.000Z' } };
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(library.reset).toHaveBeenCalledWith(false));
  });

  it('files a banner click after the settings window was closed without a choice under the banner', async () => {
    const banner = await startBanner('DE');
    banner.followPage('/login');
    library.config?.onModalShow?.({ modalName: 'consentModal' });
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    library.config?.onModalHide?.({ modalName: 'preferencesModal' });
    library.config?.onFirstConsent?.();
    expect(library.setCookieData).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ source: 'banner' }) }));
  });

  it('does not restart on every focus when the browser refuses the cookie', async () => {
    // The library's write never reaches the cookie, so the stored choice stays empty.
    await startBanner('US');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(library.reset).not.toHaveBeenCalled();
  });
});

describe('the country lookup', () => {
  it('lets a choice stored while it runs stand', async () => {
    let answer = (_country: string): void => undefined;
    const country = new Promise<string>((resolve) => {
      answer = resolve;
    });
    vi.resetModules();
    const banner = await import('@web/lib/analytics/consent-banner');
    const seen: unknown[] = [];
    const started = banner.startConsentBanner({
      cookieDomain: '',
      language: 'en',
      languages: ['en'],
      text: () => TEXT,
      privacyUrl: '/privacy',
      country,
      onChoice: (choice) => seen.push(choice),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Another tab decides while the lookup is still out.
    library.consent = true;
    library.cookie = { ...library.cookie, categories: ['necessary'], data: { source: 'banner', decidedAt: '2026-10-14T00:00:00.000Z' } };
    document.dispatchEvent(new Event('visibilitychange'));
    answer('US');
    await started;
    expect(library.acceptCategory).not.toHaveBeenCalled();
    // The library started on an empty cookie; it starts again on the stored choice, so its settings window shows it.
    expect(library.reset).toHaveBeenCalledWith(false);
    expect(library.run.mock.invocationCallOrder.at(-1)).toBeGreaterThan(library.reset.mock.invocationCallOrder.at(-1) ?? Infinity);
    expect(seen.at(-1)).toMatchObject({ analytics: false, ads: false, source: 'banner' });
  });
});

describe('a choice stored under a newer policy revision', () => {
  it('stands in a tab still running the older code', async () => {
    library.consent = true;
    library.cookie = { ...library.cookie, revision: 2, categories: ['necessary', 'analytics'] };
    const seen: unknown[] = [];
    await startBanner('US', (choice) => seen.push(choice));
    expect(library.acceptCategory).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ analytics: true, ads: false });
    // The library runs on that revision too, so its settings window and its next save keep it.
    expect(library.run).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });
});
