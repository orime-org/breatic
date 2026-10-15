// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AnalyticsModule from '@web/lib/analytics';
import type { ConsentHost } from '@web/lib/analytics/consent-banner';

const runtime = vi.hoisted(() => ({
  listener: null as null | ((choice: { analytics: boolean; ads: boolean }) => void),
  host: null as null | ConsentHost,
  started: Promise.resolve(),
  choices: null as null | undefined | Record<string, unknown>,
  setAds: vi.fn(),
}));
const OPEN = { optedOut: false, source: null };
const api = vi.hoisted(() => ({
  put: vi.fn(async (_path: string, body: { allowed: boolean }): Promise<unknown> =>
    body.allowed ? { optedOut: false, source: null } : { optedOut: true, source: 'settings' },
  ),
  get: vi.fn(async (_path: string): Promise<unknown> => ({ optedOut: false, source: null })),
}));

vi.mock('@web/lib/analytics/build-config', () => ({ ANALYTICS_CONFIGURED: true }));
vi.mock('@web/lib/analytics/runtime', () => ({
  onConsentChange: (listener: typeof runtime.listener) => {
    runtime.listener = listener;
  },
  start: (options: { host: ConsentHost }) => {
    runtime.host = options.host;
    return runtime.started;
  },
  followPage: () => undefined,
  setLanguage: async () => undefined,
  browserChoices: () => runtime.choices,
  identify: () => undefined,
  reset: () => undefined,
  setAds: runtime.setAds,
}));
vi.mock('@web/data/api/request', () => ({ apiPut: api.put, apiGet: api.get }));

/**
 * Both categories as a press in the banner leaves them.
 * @param value - Accepted or refused.
 * @param source - Where the choice came from.
 * @returns The choices.
 */
function choices(value: boolean, source = 'banner'): Record<string, unknown> {
  const entry = { value, source, decidedAt: new Date().toISOString(), revision: 1 };
  return { analytics: entry, ads: entry };
}

/**
 * A fresh entry module with the runtime loaded.
 * @returns The module.
 */
async function load(): Promise<typeof AnalyticsModule> {
  vi.resetModules();
  const analytics = await import('@web/lib/analytics');
  analytics.startProductAnalytics();
  await vi.waitFor(() => expect(runtime.host).not.toBeNull());
  return analytics;
}

/** The last ads view handed to the runtime. */
const lastAds = (): unknown => runtime.setAds.mock.calls.at(-1)?.[0];

afterEach(() => {
  vi.clearAllMocks();
  runtime.listener = null;
  runtime.host = null;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('the landing a sign-up is credited to', () => {
  it('is the address the visitor arrived on, though the app redirected before consent applied', async () => {
    window.history.replaceState(null, '', '/?utm_source=google&gclid=abc');
    const analytics = await import('@web/lib/analytics');
    analytics.startProductAnalytics();
    // The router replaces `/` with /studio, then sends a signed-out visitor to /login.
    window.history.replaceState(null, '', '/login?next=%2Fstudio');
    await vi.waitFor(() => expect(runtime.listener).not.toBeNull());
    runtime.listener?.({ analytics: true, ads: true });
    expect(analytics.attributionBody().attribution?.first).toMatchObject({ gclid: 'abc', utm_source: 'google', landing_page: '/' });
  });
});

describe('whether ads run', () => {
  it('stays off until the app knows who is signed in, showing this browser’s consent on the switch', async () => {
    runtime.choices = choices(true);
    await load();
    runtime.listener?.({ analytics: true, ads: true });
    expect(lastAds()).toEqual({ allowed: false, known: false, status: null, optedOut: false, adsOn: true });
  });

  it('decides nothing before the page has read this browser’s choice, so an early answer keeps the stored ad click', async () => {
    runtime.choices = undefined;
    const analytics = await load();
    analytics.resetUser();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.setAds).not.toHaveBeenCalled();
  });

  it('follows the browser alone when nobody is signed in, and reads nothing from the server', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.resetUser();
    await vi.waitFor(() =>
      expect(lastAds()).toEqual({ allowed: true, known: true, status: 'browser', optedOut: false, adsOn: true }),
    );
    expect(api.get).not.toHaveBeenCalled();
  });

  it('reads the account switch on sign-in and runs ads while it is open', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u1' } as never);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/users/me/ads-sharing'));
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: true, known: true, status: null, optedOut: false, adsOn: true }));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('stops for an account that opted out on another device, and says so in settings', async () => {
    runtime.choices = choices(true);
    api.get.mockResolvedValueOnce({ optedOut: true, source: 'gpc' });
    const analytics = await load();
    analytics.identifyUser({ id: 'u2' } as never);
    await vi.waitFor(() =>
      expect(lastAds()).toEqual({ allowed: false, known: true, status: 'account', optedOut: true, adsOn: false }),
    );
  });

  it('treats a failed read or an answer that is not the switch as unknown, which keeps ads off without a refusal', async () => {
    runtime.choices = choices(true);
    api.get.mockRejectedValueOnce(new Error('offline'));
    const analytics = await load();
    analytics.identifyUser({ id: 'u3' } as never);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(lastAds()).toMatchObject({ allowed: false, known: false, adsOn: true }));
    api.get.mockResolvedValueOnce({ optedOut: true, source: null });
    analytics.identifyUser({ id: 'u4' } as never);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lastAds()).toMatchObject({ allowed: false, known: false }));
  });

  it('decides again on a new choice in this browser without asking the server', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u5' } as never);
    await vi.waitFor(() => expect(lastAds()).toMatchObject({ allowed: true }));
    runtime.choices = choices(false, 'settings');
    runtime.listener?.({ analytics: false, ads: false });
    expect(lastAds()).toEqual({ allowed: false, known: true, status: null, optedOut: true, adsOn: false });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('takes the answer for the account signed in now, not one that arrives after it', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    let answerEarlier: (answer: unknown) => void = () => undefined;
    api.get.mockReturnValueOnce(new Promise((resolve) => (answerEarlier = resolve)));
    analytics.identifyUser({ id: 'u6' } as never);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    api.get.mockResolvedValueOnce({ optedOut: true, source: 'settings' });
    analytics.identifyUser({ id: 'u7' } as never);
    await vi.waitFor(() => expect(lastAds()).toMatchObject({ status: 'account' }));
    answerEarlier(OPEN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastAds()).toMatchObject({ allowed: false, status: 'account' });
  });
});

describe('what the banner asks about the account', () => {
  it('waits for the account until it is known, and not at all when nobody is signed in', async () => {
    const analytics = await load();
    let answer: (value: unknown) => void = () => undefined;
    api.get.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    analytics.identifyUser({ id: 'u1' } as never);
    let settled = false;
    void runtime.host!.accountSettled().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(runtime.host!.account()).toBe('unknown');
    answer(OPEN);
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(runtime.host!.account()).toEqual(OPEN);
    analytics.resetUser();
    expect(runtime.host!.account()).toBe('signedOut');
    await runtime.host!.accountSettled();
  });

  it('sends the switch and takes the answer, reporting a failure', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u2' } as never);
    await vi.waitFor(() => expect(runtime.host!.account()).toEqual(OPEN));
    expect(await runtime.host!.putAdsSharing(false)).toBe('took');
    expect(api.put).toHaveBeenCalledWith('/users/me/ads-sharing', { allowed: false });
    expect(runtime.host!.account()).toEqual({ optedOut: true, source: 'settings' });
    await vi.waitFor(() => expect(lastAds()).toMatchObject({ allowed: false, status: 'account' }));
    api.put.mockRejectedValueOnce(new Error('offline'));
    expect(await runtime.host!.putAdsSharing(true)).toBe('failed');
    api.put.mockResolvedValueOnce({ optedOut: 'no' });
    expect(await runtime.host!.putAdsSharing(true)).toBe('failed');
    expect(runtime.host!.account()).toEqual({ optedOut: true, source: 'settings' });
  });

  it('forgets the account when the server answers that the session is gone', async () => {
    const analytics = await load();
    analytics.identifyUser({ id: 'u4' } as never);
    await vi.waitFor(() => expect(runtime.host!.account()).toEqual(OPEN));
    // The class the freshly loaded module sees.
    const { ApiException } = await import('@web/data/api/types');
    api.put.mockRejectedValueOnce(new ApiException({ status: 401, message: 'unauthorized', fromServer: true }));
    expect(await runtime.host!.putAdsSharing(false)).toBe('signedOut');
    expect(runtime.host!.account()).toBe('signedOut');
  });

  it('knows the session once the app has signed someone in or found nobody', async () => {
    const analytics = await load();
    let known = false;
    void runtime.host!.sessionKnown().then(() => (known = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(known).toBe(false);
    analytics.resetUser();
    await vi.waitFor(() => expect(known).toBe(true));
    await runtime.host!.sessionKnown();
  });

  it('asks the account again on request, and answers false while nobody is signed in', async () => {
    const analytics = await load();
    expect(await runtime.host!.refreshAccount()).toBe(false);
    api.get.mockRejectedValueOnce(new Error('offline'));
    analytics.identifyUser({ id: 'u3' } as never);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(await runtime.host!.refreshAccount()).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
