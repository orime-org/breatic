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
  serverTime: new Date().toISOString(),
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
const OTHER = '33333333-3333-4333-8333-333333333333';

/**
 * Both categories as a press in the banner leaves them.
 * @param value - Accepted or refused.
 * @param source - Where the choice came from.
 * @param adsId - The ads decision id.
 * @returns The choices.
 */
function choices(value: boolean, source = 'banner', adsId = ID): Record<string, unknown> {
  const entry = { value, source, decidedAt: new Date().toISOString(), revision: 1 };
  return {
    analytics: { ...entry, decisionId: '11111111-1111-4111-8111-111111111111' },
    ads: { ...entry, decisionId: adsId, noticeShown: false, gpcAtDecision: false },
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
    expect(lastAds()).toEqual({ allowed: false, known: false, notice: false, adsOn: true });
  });

  it('follows the browser alone when nobody is signed in', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.resetUser();
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: true, known: true, notice: false, adsOn: true }));
  });

  it('stops for an account that opted out on another device, and says so in settings', async () => {
    runtime.choices = choices(true);
    api.put.mockResolvedValueOnce({
      receipts: [{ decisionId: '33333333-3333-4333-8333-333333333333', value: false, source: 'settings', noticeShown: false, decidedAt: new Date().toISOString(), revision: 1 }],
      gpcSeenAt: null,
      ownership: 'self',
      serverTime: new Date().toISOString(),
    });
    const analytics = await load();
    analytics.identifyUser({ id: 'u3' } as never);
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: false, known: true, notice: 'account', adsOn: false }));
  });

  it('runs once the account record allows them, and stays off when it cannot be read', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u4' } as never);
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: true, known: true, notice: false, adsOn: true }));
    api.put.mockRejectedValueOnce(new Error('offline'));
    runtime.listener?.({ analytics: true, ads: true });
    // Unknown is not refused: ads stay off for now, the stored ad click is kept, and the switch shows this browser's consent.
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: false, known: false, notice: false, adsOn: true }));
  });

  it('treats an answer that is not the account record as unknown, and still applies a later refusal', async () => {
    runtime.choices = choices(true);
    api.put.mockResolvedValueOnce({ ownership: 'self', serverTime: new Date().toISOString() });
    const analytics = await load();
    analytics.identifyUser({ id: 'u8' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: false, known: false, notice: false, adsOn: true }));
    runtime.choices = choices(false, 'settings', OTHER);
    runtime.listener?.({ analytics: false, ads: false });
    expect(lastAds()).toEqual({ allowed: false, known: true, notice: false, adsOn: false });
  });

  it('stops at once when this browser refuses while its report is on the way', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    analytics.identifyUser({ id: 'u5' } as never);
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: true, known: true, notice: false, adsOn: true }));
    api.put.mockReturnValueOnce(new Promise(() => undefined));
    runtime.choices = choices(false, 'settings', OTHER);
    runtime.listener?.({ analytics: false, ads: false });
    // The refusal counts as the receipt it is about to become, as the server will answer.
    expect(lastAds()).toEqual({ allowed: false, known: true, notice: 'account', adsOn: false });
  });

  it('takes the answer to the latest report, not one that arrives after it', async () => {
    runtime.choices = choices(true);
    const analytics = await load();
    let answerEarlier: (view: unknown) => void = () => undefined;
    api.put.mockReturnValueOnce(new Promise((resolve) => (answerEarlier = resolve)));
    analytics.identifyUser({ id: 'u6' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    api.put.mockResolvedValueOnce({ ...VIEW, receipts: [{ ...VIEW.receipts[0], decisionId: OTHER, value: false }] });
    runtime.listener?.({ analytics: true, ads: true });
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: false, known: true, notice: 'account', adsOn: false }));
    answerEarlier(VIEW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastAds()).toEqual({ allowed: false, known: true, notice: 'account', adsOn: false });
  });

  it('times this browser on the server clock the account receipts are dated by', async () => {
    // This browser's clock is two minutes behind the server.
    const server = Date.now() + 120_000;
    runtime.choices = choices(false, 'settings');
    // Another account left this refusal; this account overrode its own opt-out 30 s ago by the server's clock.
    api.put.mockResolvedValueOnce({
      receipts: [{ decisionId: OTHER, value: true, source: 'settings', noticeShown: 'account', decidedAt: new Date(server - 30_000).toISOString(), revision: 1 }],
      gpcSeenAt: null,
      ownership: 'other',
      serverTime: new Date(server).toISOString(),
    });
    const analytics = await load();
    analytics.identifyUser({ id: 'u7' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalled());
    await vi.waitFor(() => expect(lastAds()).toEqual({ allowed: false, known: true, notice: 'account', adsOn: false }));
  });
});
