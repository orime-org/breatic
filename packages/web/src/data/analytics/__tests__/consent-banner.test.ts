// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BannerModule from '@web/data/analytics/consent-banner';

/**
 * A stored cookie as the library holds it, each category's latest choice in its data.
 * @param categories - The accepted categories.
 * @param source - Where both choices came from.
 * @param decidedAt - When.
 * @param revision - The policy revision it was written under.
 * @returns The cookie.
 */
function cookieOf(categories: string[], source = 'banner', decidedAt = '2026-10-12T00:00:00.000Z', revision = 1) {
  const entry = { decidedAt, source };
  return {
    categories,
    revision,
    data: { analytics: { ...entry }, ads: { ...entry } } as Record<string, Record<string, unknown> | undefined>,
    lastConsentTimestamp: '',
  };
}

const library = vi.hoisted(() => ({
  consent: false,
  cookie: null as unknown as ReturnType<typeof cookieOf>,
  config: null as null | Record<string, (arg?: unknown) => void>,
  run: vi.fn(async (config: Record<string, (arg?: unknown) => void>) => {
    library.config = config;
  }),
  reset: vi.fn(),
  validConsent: vi.fn((): boolean => library.consent),
  getCookie: vi.fn(() => (library.consent ? library.cookie : {})),
  getUserPreferences: vi.fn(() => ({ acceptedCategories: library.consent ? library.cookie.categories : [] })),
  // As the library does: accepting stores the categories.
  acceptCategory: vi.fn((accept: string[]) => {
    library.consent = true;
    library.cookie = { ...library.cookie, categories: ['necessary', ...accept] };
  }),
  // The library rewrites the stored cookie's data.
  setCookieData: vi.fn(({ value }: { value: unknown }) => {
    library.cookie = { ...library.cookie, data: value as typeof library.cookie.data };
  }),
  show: vi.fn(),
  hide: vi.fn(),
  showPreferences: vi.fn(),
  hidePreferences: vi.fn(),
  setLanguage: vi.fn(async () => true),
}));

vi.mock('vanilla-cookieconsent', () => library);
vi.mock('vanilla-cookieconsent/dist/cookieconsent.css', () => ({}));
vi.mock('@web/data/analytics/consent-banner.css', () => ({}));

const TEXT = {
  banner: { text: 't', privacy: 'p', acceptAll: 'a', rejectAll: 'r', settings: 's', gpc: 'g' },
  settings: {
    title: 't',
    save: 's',
    close: 'c',
    status: { gpc: 'status-gpc' },
    necessary: { title: 't', description: 'd' },
    analytics: { title: 't', description: 'd' },
    ads: { title: 't', description: 'd' },
  },
};

/** Both windows as the library builds them, with the parts the banner reads and writes. */
const WINDOWS = `<div id="cc-main">
  <div class="cm"><div class="cm__desc"></div>
    <button data-role="all"></button><button data-role="necessary"></button><button data-role="show"></button></div>
  <div class="pm">
    <div class="pm__section--toggle pm__section--expandable">
      <div class="pm__section-title-wrapper"><button class="pm__section-title" aria-expanded="false" aria-controls="analytics-desc">Product analytics</button><label class="section__toggle-wrapper"><input type="checkbox" value="analytics"></label></div>
      <div class="pm__section-desc-wrapper" aria-hidden="true" id="analytics-desc"></div></div>
    <div class="pm__section--toggle pm__section--expandable">
      <div class="pm__section-title-wrapper"><button class="pm__section-title" aria-expanded="false" aria-controls="ads-desc">Advertising</button><label class="section__toggle-wrapper"><input type="checkbox" value="ads"></label></div>
      <div class="pm__section-desc-wrapper" aria-hidden="true" id="ads-desc"></div></div>
    <div class="pm__footer">
      <div class="pm__btn-group"><button data-role="all"></button><button data-role="necessary"></button></div>
      <div class="pm__btn-group"><button data-role="save"></button></div>
    </div>
  </div>
</div>`;

// The library's own handler on its buttons; a press the banner answers never reaches it.
const libraryHandler = vi.fn();

/** Draw both windows and give the library's buttons its handler. */
function drawWindows(): void {
  document.body.innerHTML = WINDOWS;
  for (const button of document.querySelectorAll('[data-role]')) button.addEventListener('click', libraryHandler);
}

/**
 * A fresh banner, started for a visitor from a country.
 * @param country - The visitor's country.
 * @param options - What the page hears.
 * @param options.onChoice - Receives each choice in force.
 * @returns The module.
 */
async function startBanner(
  country: string,
  options: { onChoice?: (choice: unknown) => void } = {},
): Promise<typeof BannerModule> {
  vi.resetModules();
  const banner = await import('@web/data/analytics/consent-banner');
  await banner.startConsentBanner({
    cookieDomain: '',
    language: 'en',
    languages: ['en'],
    text: () => TEXT,
    privacyUrl: '/privacy',
    country: Promise.resolve(country),
    onChoice: options.onChoice ?? (() => undefined),
  });
  return banner;
}

/** Whether the banner is up after the latest call. */
function bannerShown(): boolean {
  const lastShow = library.show.mock.invocationCallOrder.at(-1) ?? 0;
  const lastHide = library.hide.mock.invocationCallOrder.at(-1) ?? 0;
  return lastShow > lastHide;
}

/**
 * Press a button as the visitor would, and let the banner answer.
 * @param selector - The button.
 */
async function press(selector: string): Promise<void> {
  document.querySelector<HTMLElement>(selector)?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The data the last write left. */
const written = (): Record<string, Record<string, unknown> | undefined> =>
  (library.setCookieData.mock.calls.at(-1)?.[0] as { value: Record<string, Record<string, unknown> | undefined> }).value;

const adsToggle = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('.pm input[value="ads"]');
const adsLine = (): string | null | undefined =>
  adsToggle()?.closest('.pm__section--toggle')?.querySelector('.breatic-consent-notice')?.textContent;

// Each test starts a fresh banner module; listeners an earlier one left on the page would answer for it.
const added: Array<[EventTarget, string, EventListenerOrEventListenerObject, AddEventListenerOptions | boolean | undefined]> = [];
for (const target of [document, window] as EventTarget[]) {
  const add = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    if (listener) added.push([target, type, listener, options]);
    add(type, listener, options);
  });
}

afterEach(() => {
  for (const [target, type, listener, options] of added.splice(0)) target.removeEventListener(type, listener, options);
  document.body.innerHTML = '';
});

// No test reaches the network; a request the banner sends is recorded here.
const network = vi.fn(async () => new Response(null, { status: 204 }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', network);
  library.consent = false;
  library.cookie = cookieOf(['necessary']);
});

afterEach(() => vi.unstubAllGlobals());

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
    library.cookie = cookieOf(['necessary', 'analytics', 'ads']);
    const seen: unknown[] = [];
    await startBanner('DE', { onChoice: (choice) => seen.push(choice) });
    library.cookie = cookieOf(['necessary'], 'settings', '2026-10-13T00:00:00.000Z');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({ analytics: { value: false, source: 'settings' }, ads: { value: false } }),
    );
  });

  it('changes nothing when the stored choice is the same', async () => {
    library.consent = true;
    const seen: unknown[] = [];
    await startBanner('DE', { onChoice: (choice) => seen.push(choice) });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toHaveLength(1);
  });

  it('restarts the banner library on the stored choice, so its settings window starts from it', async () => {
    library.consent = true;
    await startBanner('DE');
    library.cookie = cookieOf(['necessary', 'analytics', 'ads'], 'banner', '2026-10-13T00:00:00.000Z');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(library.reset).toHaveBeenCalledWith(false));
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

describe('a press', () => {
  it('is answered here, not by the library: "accept all" in the banner writes both and closes it', async () => {
    const seen: unknown[] = [];
    const banner = await startBanner('DE', { onChoice: (choice) => seen.push(choice) });
    banner.followPage('/login');
    drawWindows();
    await press('.cm [data-role="all"]');
    expect(libraryHandler).not.toHaveBeenCalled();
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['analytics', 'ads'], []);
    expect(written()).toMatchObject({ analytics: { source: 'banner' }, ads: { source: 'banner' } });
    expect(written().ads?.decidedAt).toBe(written().analytics?.decidedAt);
    expect(bannerShown()).toBe(false);
    expect(seen.at(-1)).toMatchObject({ analytics: { value: true }, ads: { value: true } });
  });

  it('writes both settings switches as set, and closes the settings window', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics', 'ads'], 'implicit');
    await startBanner('US');
    drawWindows();
    // As the library presets them from the stored choice; the visitor turns analytics off.
    adsToggle()!.checked = true;
    document.querySelector<HTMLInputElement>('.pm input[value="analytics"]')!.checked = false;
    await press('.pm [data-role="save"]');
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['ads'], ['analytics']);
    expect(written()).toMatchObject({ analytics: { source: 'settings' }, ads: { source: 'settings' } });
    expect(written().ads?.decidedAt).toBe(written().analytics?.decidedAt);
    expect(library.hidePreferences).toHaveBeenCalled();
  });

  it('lets the library open the settings window from the banner', async () => {
    await startBanner('DE');
    drawWindows();
    await press('.cm [data-role="show"]');
    expect(libraryHandler).toHaveBeenCalled();
    expect(library.setCookieData).not.toHaveBeenCalled();
  });
});

describe('the GPC line', () => {
  /**
   * Start a banner in a browser that sends GPC.
   * @param country - The visitor's country.
   * @returns The module.
   */
  async function withGpc(country: string): Promise<typeof BannerModule> {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => true });
    return startBanner(country);
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => undefined });
  });

  it('shows on the banner and under the ads switch, which stays free to turn on', async () => {
    await withGpc('DE');
    drawWindows();
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    expect(document.querySelector('.cm__desc .breatic-consent-notice')?.textContent).toBe('g');
    expect(adsLine()).toBe('status-gpc');
    expect(adsToggle()?.disabled).toBe(false);
  });

  it('lets the visitor’s own consent turn ads on', async () => {
    await withGpc('US');
    drawWindows();
    adsToggle()!.checked = true;
    await press('.pm [data-role="save"]');
    expect(written().ads).toMatchObject({ source: 'settings' });
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['ads'], ['analytics']);
    await press('.cm [data-role="all"]');
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['analytics', 'ads'], []);
  });

  it('is drawn again after a language change rebuilds the windows', async () => {
    const banner = await withGpc('DE');
    drawWindows();
    // As the library does with force: both windows are built afresh from its own state.
    library.setLanguage.mockImplementationOnce(async () => {
      drawWindows();
      return true;
    });
    await banner.setConsentLanguage('ja');
    expect(adsLine()).toBe('status-gpc');
    expect(document.querySelector('.cm__desc .breatic-consent-notice')?.textContent).toBe('g');
  });

  it('is absent without GPC', async () => {
    await startBanner('DE');
    drawWindows();
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    expect(document.querySelector('.breatic-consent-notice')).toBeNull();
  });
});

describe('the category titles', () => {
  /** The settings window's category titles. */
  const titles = (): Element[] => [...document.querySelectorAll('.pm__section--toggle .pm__section-title')];

  /** Each title is a heading a keyboard passes over, and each description is read out. */
  function expectPlainTitles(): void {
    expect(titles().map((title) => [title.tagName, title.getAttribute('role'), title.getAttribute('aria-level'), title.textContent])).toEqual([
      ['DIV', 'heading', '3', 'Product analytics'],
      ['DIV', 'heading', '3', 'Advertising'],
    ]);
    expect(titles().some((title) => title.hasAttribute('aria-expanded'))).toBe(false);
    expect(document.querySelectorAll('.pm__section-desc-wrapper[aria-hidden]')).toHaveLength(0);
  }

  it('are headings, not buttons that claim to expand a description the window always shows', async () => {
    await startBanner('DE');
    drawWindows();
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    expectPlainTitles();
  });

  it('stay headings after a language change rebuilds the windows', async () => {
    const banner = await startBanner('DE');
    drawWindows();
    library.setLanguage.mockImplementationOnce(async () => {
      drawWindows();
      return true;
    });
    await banner.setConsentLanguage('ja');
    expectPlainTitles();
  });
});

describe('robustness', () => {
  it('leaves a crawler or automated browser alone, as the library does', async () => {
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => true });
    try {
      const seen: unknown[] = [];
      const banner = await startBanner('DE', { onChoice: (choice) => seen.push(choice) });
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
    library.cookie = cookieOf(['necessary', 'analytics'], 'settings', '2026-10-14T00:00:00.000Z');
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(library.reset).toHaveBeenCalledWith(false));
  });

  it('does not restart on every focus when the browser refuses the cookie', async () => {
    // The library's write never reaches the cookie, so the stored choice stays empty.
    library.acceptCategory.mockImplementation(() => undefined);
    library.setCookieData.mockImplementation(() => undefined);
    await startBanner('US');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(library.reset).not.toHaveBeenCalled();
  });
});

describe('the consent cookie stays with the browser (design §4.4.3a)', () => {
  it('sends no request when a choice or the regional default is written', async () => {
    await startBanner('US');
    expect(library.setCookieData).toHaveBeenCalledTimes(1);
    drawWindows();
    await press('.pm [data-role="necessary"]');
    expect(library.setCookieData).toHaveBeenCalledTimes(2);
    expect(network).not.toHaveBeenCalled();
  });

  it('sends no request on load for a stored choice', async () => {
    library.consent = true;
    await startBanner('DE');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(network).not.toHaveBeenCalled();
  });
});

describe('the country lookup', () => {
  it('lets a choice stored while it runs stand', async () => {
    let answer = (_country: string): void => undefined;
    const country = new Promise<string>((resolve) => {
      answer = resolve;
    });
    vi.resetModules();
    const banner = await import('@web/data/analytics/consent-banner');
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
    library.cookie = cookieOf(['necessary'], 'banner', '2026-10-14T00:00:00.000Z');
    document.dispatchEvent(new Event('visibilitychange'));
    answer('US');
    await started;
    expect(library.acceptCategory).not.toHaveBeenCalled();
    // The library started on an empty cookie; it starts again on the stored choice, so its settings window shows it.
    expect(library.reset).toHaveBeenCalledWith(false);
    expect(library.run.mock.invocationCallOrder.at(-1)).toBeGreaterThan(library.reset.mock.invocationCallOrder.at(-1) ?? Infinity);
    expect(seen.at(-1)).toMatchObject({ analytics: { value: false, source: 'banner' }, ads: { value: false } });
  });
});

describe('a choice stored under a revision that is not a whole number', () => {
  it('counts as no choice, and the library runs on the current revision', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics'], 'banner', '2026-10-12T00:00:00.000Z', 1.5);
    await startBanner('US');
    expect(library.run).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
  });
});

describe('a choice stored under a newer policy revision', () => {
  it('stands in a tab still running the older code', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics'], 'banner', '2026-10-12T00:00:00.000Z', 2);
    const seen: unknown[] = [];
    await startBanner('US', { onChoice: (choice) => seen.push(choice) });
    expect(library.acceptCategory).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ analytics: { value: true }, ads: { value: false } });
    expect(library.run).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });
});

describe('GPC on load', () => {
  /** Start a banner on the stored cookie in a browser that sends GPC. */
  async function startWithGpc(): Promise<void> {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => true });
    try {
      await startBanner('US');
    } finally {
      Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => undefined });
    }
  }

  it('rewrites only a regional ads default to a GPC refusal', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics', 'ads'], 'implicit');
    await startWithGpc();
    expect(written().analytics).toMatchObject({ source: 'implicit', decidedAt: '2026-10-12T00:00:00.000Z' });
    expect(written().ads).toMatchObject({ source: 'gpc' });
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['analytics'], ['ads']);
  });

  it('keeps the visitor’s own ads consent', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics', 'ads']);
    await startWithGpc();
    expect(library.setCookieData).not.toHaveBeenCalled();
  });
});
