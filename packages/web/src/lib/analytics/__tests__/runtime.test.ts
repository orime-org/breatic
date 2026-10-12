// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserChoice } from '@web/lib/analytics/consent-decision';
import type * as RuntimeModule from '@web/lib/analytics/runtime';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  setOptOut: vi.fn(),
  setUserId: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  track: vi.fn(),
  Identify: class {
    set(): this {
      return this;
    }
  },
}));
const banner = vi.hoisted(() => ({ onChoice: null as ((choice: BrowserChoice | null) => void) | null }));
const sdkGate = vi.hoisted(() => ({ release: (): void => undefined, wait: Promise.resolve() }));

vi.mock('@amplitude/analytics-browser', async () => {
  await sdkGate.wait;
  return sdk;
});
vi.mock('@web/lib/analytics/build-config', () => ({
  AMPLITUDE_API_KEY: 'test-key',
  GOOGLE_ADS_TAG_ID: 'AW-1',
  CONSENT_COOKIE_DOMAIN: '',
  conversionLabels: () => ({ signup: 'label' }),
}));
vi.mock('@web/lib/analytics/consent-banner', () => ({
  startConsentBanner: async (options: { onChoice: (choice: BrowserChoice | null) => void }): Promise<void> => {
    banner.onChoice = options.onChoice;
  },
  setConsentLanguage: async (): Promise<void> => undefined,
  openConsentSettings: (): void => undefined,
}));
vi.mock('@web/lib/analytics/consent-decision', () => ({ fetchCountry: async () => 'US' }));

const accepted: BrowserChoice = { analytics: true, ads: true, source: 'banner', decidedAt: '2026-10-12T00:00:00.000Z' };
const rejected: BrowserChoice = { analytics: false, ads: false, source: 'banner', decidedAt: '2026-10-12T00:00:00.000Z' };

/**
 * A fresh copy of the runtime, started, with its choice callback captured.
 * @returns The module.
 */
async function startRuntime(): Promise<typeof RuntimeModule> {
  vi.resetModules();
  const runtime = await import('@web/lib/analytics/runtime');
  await runtime.start({ language: 'en', languages: ['en'], appVersion: '1', text: () => ({}) as never, privacyUrl: '/p' });
  return runtime;
}

/**
 * Hand the runtime a choice and let it settle.
 * @param choice - The choice in force.
 */
async function choose(choice: BrowserChoice | null): Promise<void> {
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
  (window as Window & { dataLayer?: unknown[] }).dataLayer = [];
});

describe('analytics runtime', () => {
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
    await startRuntime();
    await choose(accepted);
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
    await startRuntime();
    await choose(accepted);
    const updates = ((window as Window & { dataLayer?: IArguments[] }).dataLayer ?? [])
      .map((entry) => Array.from(entry))
      .filter((entry) => entry[0] === 'consent' && entry[1] === 'update');
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) expect(update[2]).toMatchObject({ ad_personalization: 'denied', ad_storage: 'granted' });
  });
});
