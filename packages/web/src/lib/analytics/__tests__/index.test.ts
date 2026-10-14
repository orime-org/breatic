// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AnalyticsModule from '@web/lib/analytics';

const runtime = vi.hoisted(() => ({
  listener: null as null | ((choice: { analytics: boolean; ads: boolean }) => void),
  started: Promise.resolve(),
  choices: null as null | Record<string, unknown>,
  revision: 1,
  setAds: vi.fn(),
}));
const api = vi.hoisted(() => ({
  put: vi.fn(async (_path: string, _body: Record<string, unknown>): Promise<unknown> => VIEW),
  get: vi.fn(async (_path: string): Promise<unknown> => VIEW),
}));
// The account holds the browser's ads consent as its receipt.
const VIEW = vi.hoisted(() => ({
  receipts: [
    {
      decisionId: '22222222-2222-4222-8222-222222222222',
      value: true,
      source: 'banner',
      noticeShown: false,
      decidedAt: new Date().toISOString(),
      revision: 1,
    },
  ],
  gpcSeenAt: null,
  ownership: 'self',
}));

vi.mock('@web/lib/analytics/build-config', () => ({ ANALYTICS_CONFIGURED: true }));
vi.mock('@web/lib/analytics/runtime', () => ({
  onConsentChange: (listener: typeof runtime.listener) => {
    runtime.listener = listener;
  },
  start: () => runtime.started,
  followPage: () => undefined,
  setLanguage: async () => undefined,
  browserChoices: () => runtime.choices,
  consentRevision: () => runtime.revision,
  identify: () => undefined,
  reset: () => undefined,
  setAds: runtime.setAds,
}));
vi.mock('@web/data/api/request', () => ({ apiPut: api.put, apiGet: api.get }));

const ID = '22222222-2222-4222-8222-222222222222';

/**
 * Both categories as a press in the banner leaves them.
 * @param value - Accepted or refused.
 * @param source - Where the choice came from.
 * @returns The choices.
 */
function choices(value: boolean, source = 'banner'): Record<string, unknown> {
  const entry = { value, source, decidedAt: new Date().toISOString(), revision: 1 };
  return {
    analytics: { ...entry, decisionId: '11111111-1111-4111-8111-111111111111' },
    ads: { ...entry, decisionId: ID, noticeShown: false, gpcAtDecision: false },
  };
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
  return analytics;
}

/** The last ads decision handed to the runtime. */
const lastAds = (): unknown => runtime.setAds.mock.calls.at(-1)?.[0];

afterEach(() => {
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

describe('the choices sent to the account', () => {
  afterEach(() => {
    vi.clearAllMocks();
    runtime.listener = null;
    runtime.revision = 1;
  });

  it('carries each choice with its id, the revision the cookie was written under and the browser clock', async () => {
    runtime.choices = choices(false, 'settings');
    // A tab still running older code holds, and writes, a choice under the newer revision 2.
    runtime.revision = 2;
    const analytics = await load();
    const before = Date.now();
    analytics.identifyUser({ id: 'u1' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls.at(-1)?.[1] ?? {};
    expect(body).toMatchObject({ revision: 2, decisions: [expect.objectContaining({ category: 'analytics', value: false }), expect.objectContaining({ decisionId: ID })] });
    expect(Date.parse(String(body.sentAt))).toBeGreaterThanOrEqual(before);
  });

  it('reads the account record without reporting when the cookie holds only regional defaults', async () => {
    runtime.choices = choices(true, 'implicit');
    const analytics = await load();
    analytics.identifyUser({ id: 'u2' } as never);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/users/me/analytics-consent'));
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('whether ads run', () => {
  afterEach(() => {
    vi.clearAllMocks();
    runtime.listener = null;
  });

  it('stays off until the app knows who is signed in', async () => {
    runtime.choices = choices(true);
    await load();
    runtime.listener?.({ analytics: true, ads: true });
    await vi.waitFor(() => expect(runtime.setAds).toHaveBeenCalled());
    expect(lastAds()).toEqual({ allowed: false, notice: false });
  });

  it('follows the browser alone when nobody is signed in', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.resetUser();
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: true, notice: false }));
  });

  it('stops for an account that opted out on another device, and says so in settings', async () => {
    runtime.choices = choices(true);
    api.put.mockResolvedValueOnce({
      receipts: [{ decisionId: '33333333-3333-4333-8333-333333333333', value: false, source: 'settings', noticeShown: false, decidedAt: new Date().toISOString(), revision: 1 }],
      gpcSeenAt: null,
      ownership: 'self',
    });
    const analytics = await load();
    analytics.identifyUser({ id: 'u3' } as never);
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: false, notice: 'account' }));
  });

  it('runs once the account record allows them, and stays off when it cannot be read', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u4' } as never);
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: true, notice: false }));
    api.put.mockRejectedValueOnce(new Error('offline'));
    runtime.listener?.({ analytics: true, ads: true });
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: false, notice: false }));
  });
});
