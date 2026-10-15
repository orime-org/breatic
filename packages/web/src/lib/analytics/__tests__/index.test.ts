// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AnalyticsModule from '@web/lib/analytics';

const runtime = vi.hoisted(() => ({
  listener: null as null | ((choice: { analytics: boolean; ads: boolean }) => void),
  started: Promise.resolve(),
  choices: null as null | undefined | Record<string, unknown>,
  setAds: vi.fn(),
}));
const api = vi.hoisted(() => ({ put: vi.fn(async (_path: string, _body: unknown): Promise<unknown> => undefined) }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock('@sentry/react', () => sentry);
vi.mock('@web/lib/analytics/build-config', () => ({ ANALYTICS_CONFIGURED: true }));
vi.mock('@web/lib/analytics/runtime', () => ({
  onConsentChange: (listener: typeof runtime.listener) => {
    runtime.listener = listener;
  },
  start: () => runtime.started,
  followPage: () => undefined,
  setLanguage: async () => undefined,
  browserChoices: () => runtime.choices,
  identify: () => undefined,
  reset: () => undefined,
  setAds: runtime.setAds,
}));
vi.mock('@web/data/api/request', () => ({ apiPut: api.put }));

/**
 * Both categories with one value and source.
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
  await vi.waitFor(() => expect(runtime.listener).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return analytics;
}

/**
 * A choice change in this browser, as the runtime reports it.
 * @param next - The choices now in force.
 */
function change(next: Record<string, unknown> | null): void {
  runtime.choices = next;
  runtime.listener?.({ analytics: next !== null, ads: next !== null });
}

/** The last ads view handed to the runtime. */
const lastAds = (): unknown => runtime.setAds.mock.calls.at(-1)?.[0];

/**
 * Send GPC from this browser, or stop.
 * @param on - Whether it is sent.
 */
function gpc(on: boolean): void {
  Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => (on ? true : undefined) });
}

afterEach(() => {
  vi.clearAllMocks();
  gpc(false);
  runtime.listener = null;
  runtime.choices = null;
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
  it('follows this browser’s choice, signed in or not, and asks the server nothing', async () => {
    const analytics = await load();
    change(choices(true));
    expect(lastAds()).toEqual({ allowed: true });
    change(choices(false, 'settings'));
    expect(lastAds()).toEqual({ allowed: false });
    analytics.identifyUser({ id: 'u1' } as never);
    change(choices(true));
    expect(lastAds()).toEqual({ allowed: true });
  });

  it('lets GPC refuse a regional default, not the visitor’s own consent', async () => {
    gpc(true);
    await load();
    change(choices(true, 'implicit'));
    expect(lastAds()).toEqual({ allowed: false });
    change(choices(true, 'settings'));
    expect(lastAds()).toEqual({ allowed: true });
  });
});

describe('reporting this browser’s choice to the account (design §4.4.6)', () => {
  it('sends it after sign-in, and again after each change while signed in', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u1' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledWith('/users/me/consent', { analytics: true, ads: true }));
    change(choices(false, 'settings'));
    await vi.waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/users/me/consent', { analytics: false, ads: false }));
  });

  it('sends nothing while nobody is signed in', async () => {
    const analytics = await load();
    change(choices(true));
    analytics.resetUser();
    change(choices(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('reports a missing choice as refused, and a regional ads default under GPC as refused', async () => {
    runtime.choices = null;
    const analytics = await load();
    analytics.identifyUser({ id: 'u1' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledWith('/users/me/consent', { analytics: false, ads: false }));
    gpc(true);
    change(choices(true, 'implicit'));
    await vi.waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/users/me/consent', { analytics: true, ads: false }));
  });

  it('does not send the same choice twice for the same account, but does for another account', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u1' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    change(choices(true));
    analytics.identifyUser({ id: 'u1' } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.put).toHaveBeenCalledTimes(1);
    analytics.identifyUser({ id: 'u2' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
  });

  it('sends again after a failure, and does not report a session that ended', async () => {
    runtime.choices = choices(true);
    api.put.mockRejectedValueOnce(new Error('offline'));
    const analytics = await load();
    analytics.identifyUser({ id: 'u1' } as never);
    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledTimes(1));
    change(choices(true));
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    // The class the freshly loaded module sees.
    const { ApiException } = await import('@web/data/api/types');
    api.put.mockRejectedValueOnce(new ApiException({ status: 401, message: 'unauthorized', fromServer: true }));
    change(choices(false));
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
