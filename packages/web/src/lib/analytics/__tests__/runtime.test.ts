// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_REVISION, type BrowserChoices } from '@breatic/shared';
import type * as RuntimeModule from '@web/lib/analytics/runtime';

const held = vi.hoisted(() => ({ userId: undefined as string | undefined, ready: Promise.resolve() }));
const sdk = vi.hoisted(() => ({
  // The real SDK finishes starting asynchronously and writes its cookie when it does.
  init: vi.fn(() => ({
    promise: held.ready.then(() => {
      document.cookie = 'AMP_test=1; Path=/';
    }),
  })),
  // The real SDK rewrites its cookie whenever its settings change, opting out included.
  setOptOut: vi.fn(() => {
    document.cookie = 'AMP_test=1; Path=/';
  }),
  setUserId: vi.fn((id: string | undefined) => {
    held.userId = id;
  }),
  getUserId: vi.fn((): string | undefined => held.userId),
  identify: vi.fn(),
  // A reset starts a new device and forgets the account.
  reset: vi.fn(() => {
    held.userId = undefined;
  }),
  track: vi.fn(),
  // The real SDK rewrites its stored queue after each send.
  flush: vi.fn(() => {
    localStorage.setItem('AMP_unsent_test', '[]');
    return { promise: Promise.resolve() };
  }),
  // Records each property it is given, in order: [operation, name, value].
  Identify: class {
    readonly calls: Array<[string, string, unknown]> = [];
    set(name: string, value: unknown): this {
      this.calls.push(['set', name, value]);
      return this;
    }
    setOnce(name: string, value: unknown): this {
      this.calls.push(['setOnce', name, value]);
      return this;
    }
  },
}));
const banner = vi.hoisted(() => ({ onChoice: null as ((choice: BrowserChoices | null) => void) | null }));
const sdkGate = vi.hoisted(() => ({ release: (): void => undefined, wait: Promise.resolve() }));

vi.mock('@amplitude/analytics-browser', async () => {
  await sdkGate.wait;
  return sdk;
});
vi.mock('@web/lib/analytics/build-config', async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...(await importOriginal()),
  AMPLITUDE_API_KEY: 'test-key',
  GOOGLE_ADS_TAG_ID: 'AW-1',
  CONSENT_COOKIE_DOMAIN: '',
  conversionLabels: () => ({ signup: 'label' }),
}));
vi.mock('@web/lib/analytics/consent-banner', () => ({
  startConsentBanner: async (options: { onChoice: (choice: BrowserChoices | null) => void }): Promise<void> => {
    banner.onChoice = options.onChoice;
  },
  setConsentLanguage: async (): Promise<void> => undefined,
  openConsentSettings: (): void => undefined,
  followPage: (): void => undefined,
}));
vi.mock('@web/lib/analytics/consent-decision', () => ({ fetchCountry: async () => 'US' }));

/**
 * Both categories set the same way in the banner.
 * @param value - Accepted or refused.
 * @returns The choices.
 */
function both(value: boolean): BrowserChoices {
  const entry = { value, source: 'banner' as const, decidedAt: '2026-10-12T00:00:00.000Z', revision: CONSENT_REVISION };
  return { analytics: entry, ads: entry };
}
const accepted = both(true);
const rejected = both(false);

/**
 * A fresh copy of the runtime, started, with its choice callback captured.
 * @returns The module.
 */
async function startRuntime(): Promise<typeof RuntimeModule> {
  vi.resetModules();
  const runtime = await import('@web/lib/analytics/runtime');
  await runtime.start({ language: 'en', languages: ['en'], appVersion: '1', text: () => ({}) as never, privacyUrl: '/p', onError: () => undefined });
  return runtime;
}

/**
 * Hand the runtime a choice and let it settle.
 * @param choice - The choice in force.
 */
async function choose(choice: BrowserChoices | null): Promise<void> {
  banner.onChoice?.(choice);
  await vi.waitFor(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of document.cookie.split(';').map((pair) => pair.split('=')[0].trim())) {
    document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
  localStorage.clear();
  sdkGate.wait = Promise.resolve();
  held.userId = undefined;
  held.ready = Promise.resolve();
  (window as Window & { dataLayer?: unknown[] }).dataLayer = [];
});

describe('analytics runtime', () => {
  it('keeps the Google tag out until the page allows ads, whatever the cookie says', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    const tag = (): boolean => [...document.head.querySelectorAll('script')].some((el) => el.src.includes('googletagmanager'));
    expect(tag()).toBe(false);
    runtime.conversion('signup', 'signup:user-1');
    runtime.setAds({ allowed: false });
    expect(tag()).toBe(false);
    runtime.setAds({ allowed: true });
    expect(tag()).toBe(true);
  });

  it('stops ads at once when this browser withdraws them, before the page decides again', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    runtime.setAds({ allowed: true });
    document.cookie = '_gcl_au=1; Path=/';
    await choose(rejected);
    const last = ((window as Window & { dataLayer?: IArguments[] }).dataLayer ?? [])
      .map((entry) => Array.from(entry))
      .filter((entry) => entry[0] === 'consent' && entry[1] === 'update')
      .at(-1);
    expect(last?.[2]).toMatchObject({ ad_storage: 'denied' });
    expect(document.cookie).not.toMatch(/_gcl_/);
  });

  it('hands the backend the ads consent with GPC applied to a regional default', async () => {
    const runtime = await startRuntime();
    const implicit = { value: true, source: 'implicit' as const, decidedAt: '2026-10-12T00:00:00.000Z', revision: CONSENT_REVISION };
    await choose({ analytics: implicit, ads: implicit });
    expect(runtime.consentSnapshot()).toEqual({ analytics: true, ads: true });
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => true });
    try {
      expect(runtime.consentSnapshot()).toEqual({ analytics: true, ads: false });
    } finally {
      Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => undefined });
    }
  });

  it('clears both vendors’ cookies and queued events when no choice is in force, even if this page never loaded them', async () => {
    document.cookie = 'AMP_test=1; Path=/';
    document.cookie = '_gcl_au=1; Path=/';
    localStorage.setItem('AMP_unsent_test', '[]');
    await startRuntime();
    await choose(null);
    expect(document.cookie).not.toMatch(/AMP_|_gcl_/);
    expect(localStorage.getItem('AMP_unsent_test')).toBeNull();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('deletes the database the SDK keeps for its own diagnostics when analytics is not in force', async () => {
    const deleteDatabase = vi.fn();
    vi.stubGlobal('indexedDB', { deleteDatabase });
    await startRuntime();
    await choose(accepted);
    expect(deleteDatabase).not.toHaveBeenCalled();
    await choose(rejected);
    expect(deleteDatabase).toHaveBeenCalledWith('AMP_diagnostics_test-key');
  });

  it('does not start the SDK when analytics is withdrawn while it downloads', async () => {
    let release = (): void => undefined;
    sdkGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    await startRuntime();
    banner.onChoice?.(accepted);
    banner.onChoice?.(rejected);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('writes vendor cookies on the consent cookie’s domain', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    runtime.setAds({ allowed: true });
    expect(sdk.init).toHaveBeenCalledWith('test-key', undefined, expect.objectContaining({ cookieOptions: { domain: '' } }));
    const layer = (window as Window & { dataLayer?: IArguments[] }).dataLayer ?? [];
    const config = layer.map((entry) => Array.from(entry)).find((entry) => entry[0] === 'config');
    expect(config?.[2]).toMatchObject({ cookie_domain: 'none' });
  });

  it('names an account that signed in before analytics was accepted', async () => {
    const runtime = await startRuntime();
    runtime.identify({ id: 'user-1', membershipTier: 'free', language: 'en' });
    expect(sdk.setUserId).not.toHaveBeenCalled();
    await choose(accepted);
    expect(sdk.setUserId).toHaveBeenCalledWith('user-1');
  });

  it('names the account with its first and latest source, medium, campaign and landing page', async () => {
    const at = new Date().toISOString();
    localStorage.setItem(
      'breatic.attribution',
      JSON.stringify({
        first: { at, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'launch', landing_page: '/pricing', gclid: 'CLICK' },
        last: { at, utm_source: 'newsletter', landing_page: '/' },
      }),
    );
    const runtime = await startRuntime();
    await choose(accepted);
    runtime.identify({ id: 'user-1', membershipTier: 'free', language: 'en' });
    await vi.waitFor(() => expect(sdk.identify).toHaveBeenCalled());
    const sent = (sdk.identify.mock.calls.at(-1)?.[0] as { calls: Array<[string, string, unknown]> }).calls;
    expect(sent).toEqual([
      ['set', 'membership_tier', 'free'],
      ['set', 'language', 'en'],
      ['setOnce', 'initial_utm_source', 'google'],
      ['setOnce', 'initial_utm_medium', 'cpc'],
      ['setOnce', 'initial_utm_campaign', 'launch'],
      ['setOnce', 'initial_landing_page', '/pricing'],
      ['set', 'utm_source', 'newsletter'],
      ['set', 'landing_page', '/'],
    ]);
  });

  it('leaves the SDK alone on sign-out once analytics is withdrawn', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    await choose(rejected);
    runtime.reset();
    expect(sdk.reset).not.toHaveBeenCalled();
    expect(document.cookie).not.toMatch(/AMP_/);
  });

  it('reports a browser conversion only for a visitor who arrived from an ad in the last 90 days', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    runtime.setAds({ allowed: true });
    const conversions = (): unknown[][] =>
      ((window as Window & { dataLayer?: IArguments[] }).dataLayer ?? [])
        .map((entry) => Array.from(entry))
        .filter((entry) => entry[0] === 'event' && entry[1] === 'conversion');
    runtime.conversion('signup', 'signup:user-1');
    expect(conversions()).toHaveLength(0);
    const at = new Date().toISOString();
    localStorage.setItem('breatic.attribution', JSON.stringify({ first: { at, gclid: 'CLICK' }, last: { at, gclid: 'CLICK' } }));
    runtime.conversion('signup', 'signup:user-1');
    expect(conversions()).toHaveLength(1);
  });

  it('never grants ad personalisation', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    runtime.setAds({ allowed: true });
    const updates = ((window as Window & { dataLayer?: IArguments[] }).dataLayer ?? [])
      .map((entry) => Array.from(entry))
      .filter((entry) => entry[0] === 'consent' && entry[1] === 'update');
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) expect(update[2]).toMatchObject({ ad_personalization: 'denied', ad_storage: 'granted' });
  });

  it('leaves no Amplitude cookie after analytics is withdrawn, though opting out rewrites it', async () => {
    await startRuntime();
    await choose(accepted);
    await choose(rejected);
    expect(sdk.setOptOut).toHaveBeenLastCalledWith(true);
    expect(document.cookie).not.toMatch(/AMP_/);
  });

  it('never loads the Google tag when ads are withdrawn while the analytics SDK downloads', async () => {
    let release = (): void => undefined;
    sdkGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = await startRuntime();
    banner.onChoice?.(accepted);
    runtime.setAds({ allowed: true });
    banner.onChoice?.(rejected);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const granted = ((window as Window & { dataLayer?: IArguments[] }).dataLayer ?? [])
      .map((entry) => Array.from(entry))
      .filter((entry) => entry[0] === 'consent' && entry[1] === 'update')
      .at(-1);
    expect(granted?.[2]).not.toMatchObject({ ad_storage: 'granted' });
    expect(document.cookie).not.toMatch(/AMP_/);
  });

  it('loads and starts the SDK once when analytics is accepted twice while it downloads', async () => {
    let release = (): void => undefined;
    sdkGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = await startRuntime();
    banner.onChoice?.(accepted);
    banner.onChoice?.({ ...accepted, analytics: { ...accepted.analytics!, source: 'settings' } });
    release();
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sdk.init).toHaveBeenCalledTimes(1);
    // Events reach the SDK that was started, not a second copy.
    runtime.track('pricing_viewed', { surface: 'credits' });
    expect(sdk.track).toHaveBeenCalledTimes(1);
  });

  it('forgets the signed-out account when analytics is accepted again', async () => {
    const runtime = await startRuntime();
    runtime.identify({ id: 'user-1', membershipTier: 'free', language: 'en' });
    await choose(accepted);
    await choose(rejected);
    runtime.reset();
    await choose(accepted);
    expect(sdk.reset).toHaveBeenCalledTimes(1);
  });

  it('sends what was queued while analytics was accepted, then leaves nothing stored', async () => {
    await startRuntime();
    await choose(accepted);
    await choose(rejected);
    expect(sdk.setOptOut.mock.invocationCallOrder.at(-1)).toBeLessThan(sdk.flush.mock.invocationCallOrder.at(-1) ?? 0);
    expect(localStorage.getItem('AMP_unsent_test')).toBeNull();
  });

  it('keeps the device of a visitor who was never signed in when the app finds no session', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    runtime.reset();
    await choose(accepted);
    expect(sdk.reset).not.toHaveBeenCalled();
  });

  it('forgets an account the SDK still holds once the app finds nobody signed in', async () => {
    held.userId = 'user-1';
    const runtime = await startRuntime();
    await choose(accepted);
    runtime.reset();
    await choose(accepted);
    expect(sdk.reset).toHaveBeenCalledTimes(1);
  });

  it('starts a new device before naming a different account', async () => {
    held.userId = 'user-a';
    const runtime = await startRuntime();
    runtime.identify({ id: 'user-b', membershipTier: 'free', language: 'en' });
    await choose(accepted);
    expect(sdk.reset).toHaveBeenCalledTimes(1);
    expect(sdk.reset.mock.invocationCallOrder[0]).toBeLessThan(sdk.setUserId.mock.invocationCallOrder.at(-1) ?? 0);
    expect(sdk.setUserId).toHaveBeenLastCalledWith('user-b');
  });

  it('tells listeners about a withdrawal before the SDK finishes sending what it queued', async () => {
    const runtime = await startRuntime();
    await choose(accepted);
    sdk.flush.mockReturnValueOnce({ promise: new Promise<void>(() => undefined) });
    const seen: boolean[] = [];
    runtime.onConsentChange((consent) => seen.push(consent.analytics));
    banner.onChoice?.(rejected);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([false]);
  });

  it('clears what the SDK stored even when sending what it queued never finishes', async () => {
    await startRuntime();
    await choose(accepted);
    vi.useFakeTimers();
    sdk.flush.mockReturnValueOnce({ promise: new Promise<void>(() => undefined) });
    banner.onChoice?.(rejected);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(document.cookie).not.toMatch(/AMP_/);
  });

  it('leaves nothing stored when analytics is withdrawn while the SDK starts', async () => {
    let started = (): void => undefined;
    held.ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    await startRuntime();
    banner.onChoice?.(accepted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    banner.onChoice?.(rejected);
    await new Promise((resolve) => setTimeout(resolve, 0));
    started();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sdk.setOptOut).toHaveBeenLastCalledWith(true);
    expect(document.cookie).not.toMatch(/AMP_/);
  });

  it('lets the SDK store queued events only while analytics is accepted', async () => {
    await startRuntime();
    await choose(accepted);
    const options = (sdk.init.mock.calls as unknown as unknown[][])[0]?.[2] as { storageProvider: { set(key: string, value: unknown): Promise<void> } };
    await options.storageProvider.set('AMP_unsent_test', ['event']);
    expect(localStorage.getItem('AMP_unsent_test')).toBe(JSON.stringify(['event']));
    await choose(rejected);
    // A send that finishes after the withdrawal stores what is left of its queue.
    await options.storageProvider.set('AMP_unsent_test', ['late']);
    expect(localStorage.getItem('AMP_unsent_test')).toBeNull();
  });
});
