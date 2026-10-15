// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAdsView } from '@breatic/shared';
import type * as BannerModule from '@web/lib/analytics/consent-banner';
import type { AdsView } from '@web/lib/analytics/consent-decision';

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
vi.mock('@web/lib/analytics/consent-banner.css', () => ({}));

const TEXT = {
  banner: { text: 't', privacy: 'p', acceptAll: 'a', rejectAll: 'r', settings: 's', gpc: 'g', optedOut: 'opted-out' },
  settings: {
    title: 't',
    save: 's',
    close: 'c',
    note: 'n',
    status: { gpc: 'status-gpc', account: 'status-account', browser: 'status-browser' },
    confirm: { body: 'confirm-body', yes: 'confirm-yes', no: 'confirm-no' },
    error: 'save-error',
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
    <div class="pm__section--toggle"><input type="checkbox" value="analytics"><div class="pm__section-desc-wrapper"></div></div>
    <div class="pm__section--toggle"><input type="checkbox" value="ads"><div class="pm__section-desc-wrapper"></div></div>
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

/** A page's answer to the banner about the account, controllable by each test. */
function hostOf(account: AccountAdsView = 'signedOut') {
  const host = {
    view: account,
    account: () => host.view,
    accountSettled: vi.fn(async () => undefined),
    refreshAccount: vi.fn(async () => false),
    putAdsSharing: vi.fn(async () => true),
  };
  return host;
}

/**
 * A fresh banner, started for a visitor from a country.
 * @param country - The visitor's country.
 * @param options - What the page answers and hears.
 * @param options.host - The account.
 * @param options.onChoice - Receives each choice in force.
 * @returns The module.
 */
async function startBanner(
  country: string,
  options: { host?: ReturnType<typeof hostOf>; onChoice?: (choice: unknown) => void } = {},
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
    host: options.host ?? hostOf(),
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

/**
 * A page's ads view.
 * @param over - Fields to change.
 * @returns The view.
 */
const view = (over: Partial<AdsView> = {}): AdsView => ({
  allowed: false,
  known: true,
  status: null,
  optedOut: false,
  adsOn: false,
  ...over,
});

const adsToggle = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('.pm input[value="ads"]');
/**
 * Move the ads switch as the visitor would, so the banner hears it.
 * @param on - Where the switch ends up.
 */
function setAdsSwitch(on: boolean): void {
  const toggle = adsToggle()!;
  toggle.checked = on;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
}
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

  it('waits for the account before asking, within the first second', async () => {
    vi.useFakeTimers();
    try {
      const host = hostOf('unknown');
      let settle = (): void => undefined;
      host.accountSettled.mockImplementation(() => new Promise<undefined>((resolve) => (settle = () => resolve(undefined))));
      vi.resetModules();
      const banner = await import('@web/lib/analytics/consent-banner');
      const started = banner.startConsentBanner({
        cookieDomain: '',
        language: 'en',
        languages: ['en'],
        text: () => TEXT,
        privacyUrl: '/privacy',
        country: Promise.resolve('DE'),
        host,
        onChoice: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      banner.followPage('/login');
      expect(bannerShown()).toBe(false);
      settle();
      await started;
      banner.followPage('/login');
      expect(bannerShown()).toBe(true);
      // With no answer at all, the banner opens once the first second is over.
      host.accountSettled.mockImplementation(() => new Promise<undefined>(() => undefined));
      vi.resetModules();
      const late = await import('@web/lib/analytics/consent-banner');
      const waiting = late.startConsentBanner({
        cookieDomain: '',
        language: 'en',
        languages: ['en'],
        text: () => TEXT,
        privacyUrl: '/privacy',
        country: Promise.resolve('DE'),
        host,
        onChoice: () => undefined,
      });
      late.followPage('/login');
      library.show.mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      await waiting;
      expect(library.show).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it('writes the settings switches as set, and closes the settings window', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics', 'ads'], 'implicit');
    const banner = await startBanner('US');
    drawWindows();
    banner.setAdsView(view({ allowed: true, adsOn: true }));
    document.querySelector<HTMLInputElement>('.pm input[value="analytics"]')!.checked = false;
    await press('.pm [data-role="save"]');
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['ads'], ['analytics']);
    // The ads switch was left as preset, so ads keep the choice they had.
    expect(written()).toMatchObject({ analytics: { source: 'settings' }, ads: { source: 'implicit' } });
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

describe('a signed-in press that writes ads off', () => {
  it('closes the account switch before the cookie is written', async () => {
    const host = hostOf({ optedOut: false, source: null });
    const order: string[] = [];
    host.putAdsSharing.mockImplementation(async () => {
      order.push('put');
      return true;
    });
    library.setCookieData.mockImplementationOnce(({ value }: { value: unknown }) => {
      order.push('cookie');
      library.cookie = { ...library.cookie, data: value as typeof library.cookie.data };
    });
    const banner = await startBanner('DE', { host });
    banner.followPage('/login');
    drawWindows();
    await press('.cm [data-role="necessary"]');
    expect(host.putAdsSharing).toHaveBeenCalledWith(false);
    expect(order).toEqual(['put', 'cookie']);
  });

  it('writes nothing, keeps the window open and says so when the account cannot be reached, then saves on a retry', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics', 'ads']);
    const host = hostOf({ optedOut: false, source: null });
    host.putAdsSharing.mockResolvedValueOnce(false);
    const banner = await startBanner('US', { host });
    drawWindows();
    banner.setAdsView(view({ allowed: true, adsOn: true }));
    document.querySelector<HTMLInputElement>('.pm input[value="analytics"]')!.checked = true;
    adsToggle()!.click();
    await press('.pm [data-role="save"]');
    expect(library.setCookieData).not.toHaveBeenCalled();
    expect(library.hidePreferences).not.toHaveBeenCalled();
    expect(document.querySelector('.pm .breatic-consent-error')?.textContent).toBe('save-error');
    await press('.pm [data-role="save"]');
    expect(written().ads).toMatchObject({ source: 'settings' });
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['analytics'], ['ads']);
    expect(document.querySelector('.breatic-consent-error')).toBeNull();
  });

  it('shows the error under the banner text when the press came from the banner', async () => {
    const host = hostOf({ optedOut: false, source: null });
    host.putAdsSharing.mockResolvedValue(false);
    const banner = await startBanner('DE', { host });
    banner.followPage('/login');
    drawWindows();
    await press('.cm [data-role="necessary"]');
    expect(document.querySelector('.cm__desc .breatic-consent-error')?.textContent).toBe('save-error');
    expect(bannerShown()).toBe(true);
  });
});

describe('turning ads back on while they are opted out', () => {
  /**
   * A stored refusal here, and the settings window drawn.
   * @param host - The account.
   * @returns The banner.
   */
  async function refusedHere(host = hostOf()): Promise<typeof BannerModule> {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics']);
    const banner = await startBanner('US', { host });
    drawWindows();
    banner.setAdsView(view({ optedOut: true, status: host.view === 'signedOut' ? 'browser' : null }));
    return banner;
  }

  it('asks first, writing nothing, in place of the window’s buttons', async () => {
    await refusedHere();
    await press('.pm [data-role="all"]');
    expect(library.setCookieData).not.toHaveBeenCalled();
    expect(document.querySelector('.pm__footer')?.classList.contains('breatic-consent-confirming')).toBe(true);
    expect(document.querySelector('.breatic-consent-confirm p')?.textContent).toBe('confirm-body');
    expect(document.activeElement?.getAttribute('data-breatic-confirm')).toBe('yes');
  });

  it('turns ads on once confirmed, opening the account switch first when signed in', async () => {
    const host = hostOf({ optedOut: false, source: null });
    await refusedHere(host);
    document.querySelector<HTMLInputElement>('.pm input[value="analytics"]')!.checked = true;
    setAdsSwitch(true);
    await press('.pm [data-role="save"]');
    await press('[data-breatic-confirm="yes"]');
    expect(host.putAdsSharing).toHaveBeenCalledWith(true);
    expect(written().ads).toMatchObject({ source: 'settings' });
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['analytics', 'ads'], []);
    expect(document.querySelector('.breatic-consent-confirm')).toBeNull();
  });

  it('leaves ads off and writes the rest when declined', async () => {
    await refusedHere();
    setAdsSwitch(true);
    document.querySelector<HTMLInputElement>('.pm input[value="analytics"]')!.checked = false;
    await press('.pm [data-role="save"]');
    await press('[data-breatic-confirm="no"]');
    expect(written()).toMatchObject({ analytics: { source: 'settings' }, ads: { source: 'banner' } });
    expect(library.acceptCategory).toHaveBeenLastCalledWith([], ['analytics', 'ads']);
    expect(document.querySelector('.breatic-consent-confirm')).toBeNull();
  });

  it('never turns ads on from the banner: "accept all" turns on analytics only and keeps ads off', async () => {
    const host = hostOf({ optedOut: true, source: 'settings' });
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'ads']);
    library.cookie.data.analytics = undefined;
    const banner = await startBanner('DE', { host });
    banner.followPage('/login');
    drawWindows();
    banner.setAdsView(view({ optedOut: true, status: 'account' }));
    expect(document.querySelector('.cm__desc .breatic-consent-notice')?.textContent).toBe('opted-out');
    await press('.cm [data-role="all"]');
    expect(written().analytics).toMatchObject({ source: 'banner' });
    expect(written().ads).toMatchObject({ source: 'banner', decidedAt: '2026-10-12T00:00:00.000Z' });
    expect(host.putAdsSharing).not.toHaveBeenCalled();
  });

  it('asks the account again before turning ads on while its switch is unknown, and says so when it cannot', async () => {
    const host = hostOf('unknown');
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics', 'ads']);
    const banner = await startBanner('US', { host });
    drawWindows();
    banner.setAdsView(view({ known: false, adsOn: true }));
    await press('.pm [data-role="all"]');
    expect(host.refreshAccount).toHaveBeenCalled();
    expect(library.setCookieData).not.toHaveBeenCalled();
    expect(document.querySelector('.pm .breatic-consent-error')?.textContent).toBe('save-error');
    host.refreshAccount.mockImplementationOnce(async () => {
      host.view = { optedOut: false, source: null };
      return true;
    });
    await press('.pm [data-role="all"]');
    expect(written()).toMatchObject({ analytics: { source: 'settings' }, ads: { source: 'settings' } });
  });
});

describe('status lines and the ads switch', () => {
  it('says GPC keeps ads off, on the banner and under a switch that cannot be turned on', async () => {
    const banner = await startBanner('DE');
    drawWindows();
    banner.setAdsView(view({ status: 'gpc', optedOut: true }));
    expect(document.querySelector('.cm__desc .breatic-consent-notice')?.textContent).toBe('g');
    expect(adsLine()).toBe('status-gpc');
    expect(adsToggle()?.disabled).toBe(true);
    expect(adsToggle()?.checked).toBe(false);
  });

  it('says the account opted out, and that a signed-out choice is this browser’s only', async () => {
    library.consent = true;
    const banner = await startBanner('US');
    drawWindows();
    banner.setAdsView(view({ status: 'account', optedOut: true }));
    expect(adsLine()).toBe('status-account');
    expect(adsToggle()?.disabled).toBe(false);
    banner.setAdsView(view({ status: 'browser', allowed: true, adsOn: true }));
    expect(adsLine()).toBe('status-browser');
    expect(document.querySelector('.cm__desc .breatic-consent-notice')).toBeNull();
    banner.setAdsView(view({ allowed: true, adsOn: true }));
    expect(adsLine()).toBeUndefined();
  });

  it('moves an untouched ads switch with a view that arrives while the window is open', async () => {
    library.consent = true;
    const banner = await startBanner('US');
    drawWindows();
    // The account's answer is still on its way: the switch shows this browser's consent.
    banner.setAdsView(view({ known: false, adsOn: true }));
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    expect(adsToggle()?.checked).toBe(true);
    // The answer: another device opted the account out.
    banner.setAdsView(view({ status: 'account', optedOut: true }));
    expect(adsToggle()?.checked).toBe(false);
  });

  it('keeps the ads switch where the visitor put it when a view arrives afterwards', async () => {
    library.consent = true;
    const banner = await startBanner('US');
    drawWindows();
    banner.setAdsView(view({ allowed: true, adsOn: true }));
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    adsToggle()?.click();
    expect(adsToggle()?.checked).toBe(false);
    banner.setAdsView(view({ allowed: true, adsOn: true }));
    expect(adsToggle()?.checked).toBe(false);
  });

  it('starts over when ads become opted out after the visitor changed the switch', async () => {
    library.consent = true;
    const banner = await startBanner('US');
    drawWindows();
    banner.setAdsView(view({ allowed: true, adsOn: true }));
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    adsToggle()?.click();
    adsToggle()?.click();
    expect(adsToggle()?.checked).toBe(true);
    banner.setAdsView(view({ status: 'account', optedOut: true }));
    expect(adsToggle()?.checked).toBe(false);
  });

  it('follows the view again once the window is reopened, and drops a question or an error left open', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics']);
    const banner = await startBanner('US');
    drawWindows();
    banner.setAdsView(view({ optedOut: true, status: 'browser' }));
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    await press('.pm [data-role="all"]');
    expect(document.querySelector('.breatic-consent-confirm')).not.toBeNull();
    library.config?.onModalShow?.({ modalName: 'preferencesModal' });
    expect(document.querySelector('.breatic-consent-confirm')).toBeNull();
    expect(document.querySelector('.pm__footer')?.classList.contains('breatic-consent-confirming')).toBe(false);
  });

  it('draws the lines, the switch and a pending question again after a language change rebuilds the windows', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics']);
    const banner = await startBanner('DE');
    drawWindows();
    banner.setAdsView(view({ optedOut: true, status: 'browser' }));
    await press('.pm [data-role="all"]');
    // As the library does with force: both windows are built afresh from its own state.
    library.setLanguage.mockImplementationOnce(async () => {
      drawWindows();
      setAdsSwitch(true);
      return true;
    });
    await banner.setConsentLanguage('ja');
    expect(adsToggle()?.checked).toBe(false);
    expect(adsLine()).toBe('status-browser');
    expect(document.querySelector('.cm__desc .breatic-consent-notice')?.textContent).toBe('opted-out');
    expect(document.querySelector('.breatic-consent-confirm')).not.toBeNull();
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

  it('answers one press at a time', async () => {
    const host = hostOf({ optedOut: false, source: null });
    let release = (_ok: boolean): void => undefined;
    host.putAdsSharing.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)));
    const banner = await startBanner('DE', { host });
    banner.followPage('/login');
    drawWindows();
    await press('.cm [data-role="necessary"]');
    await press('.cm [data-role="all"]');
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.putAdsSharing).toHaveBeenCalledTimes(1);
    expect(library.setCookieData).toHaveBeenCalledTimes(1);
    expect(written().ads).toMatchObject({ source: 'banner' });
    expect(library.acceptCategory).toHaveBeenLastCalledWith([], ['analytics', 'ads']);
  });
});

describe('the consent cookie stays with the browser (design §4.4.3a)', () => {
  it('sends no request when a signed-out visitor’s choice or the regional default is written', async () => {
    const banner = await startBanner('US');
    expect(library.setCookieData).toHaveBeenCalledTimes(1);
    drawWindows();
    banner.setAdsView(view({ allowed: true, adsOn: true, status: 'browser' }));
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
    const banner = await import('@web/lib/analytics/consent-banner');
    const seen: unknown[] = [];
    const started = banner.startConsentBanner({
      cookieDomain: '',
      language: 'en',
      languages: ['en'],
      text: () => TEXT,
      privacyUrl: '/privacy',
      country,
      host: hostOf(),
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
  it('rewrites only the ads choice when GPC appears on a stored consent', async () => {
    library.consent = true;
    library.cookie = cookieOf(['necessary', 'analytics', 'ads']);
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => true });
    try {
      await startBanner('US');
    } finally {
      Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => undefined });
    }
    expect(written().analytics).toMatchObject({ source: 'banner', decidedAt: '2026-10-12T00:00:00.000Z' });
    expect(written().ads).toMatchObject({ source: 'gpc' });
    expect(library.acceptCategory).toHaveBeenLastCalledWith(['analytics'], ['ads']);
  });
});
