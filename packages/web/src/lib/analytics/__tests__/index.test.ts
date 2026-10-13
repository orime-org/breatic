// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  listener: null as null | ((choice: { analytics: boolean; ads: boolean }) => void),
  started: Promise.resolve(),
  choice: null as null | Record<string, unknown>,
  revision: 1,
}));
const api = vi.hoisted(() => ({ put: vi.fn(async (_path: string, _body: Record<string, unknown>) => undefined) }));

vi.mock('@web/lib/analytics/build-config', () => ({ ANALYTICS_CONFIGURED: true }));
vi.mock('@web/lib/analytics/runtime', () => ({
  onConsentChange: (listener: typeof runtime.listener) => {
    runtime.listener = listener;
  },
  start: () => runtime.started,
  followPage: () => undefined,
  setLanguage: async () => undefined,
  browserChoice: () => runtime.choice,
  consentRevision: () => runtime.revision,
  identify: () => undefined,
}));
vi.mock('@web/data/api/request', () => ({ apiPut: api.put }));

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

describe('the choice sent to the account', () => {
  it('carries the policy revision the stored choice was written under', async () => {
    vi.resetModules();
    runtime.choice = { analytics: false, ads: false, source: 'settings', decidedAt: '2026-10-13T00:00:00.000Z' };
    // A tab still running older code holds, and writes, a choice under the newer revision 2.
    runtime.revision = 2;
    const analytics = await import('@web/lib/analytics');
    analytics.startProductAnalytics();
    analytics.identifyUser({ id: 'u1' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put).toHaveBeenCalledWith('/users/me/analytics-consent', expect.objectContaining({ revision: 2, analytics: false }));
  });

  it('carries the browser clock at sending, so the server can correct a skewed clock', async () => {
    vi.resetModules();
    api.put.mockClear();
    runtime.choice = { analytics: true, ads: true, source: 'banner', decidedAt: '2026-10-13T00:00:00.000Z' };
    const analytics = await import('@web/lib/analytics');
    analytics.startProductAnalytics();
    const before = Date.now();
    analytics.identifyUser({ id: 'u2' } as never);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls.at(-1)?.[1] ?? {};
    expect(Date.parse(String(body.sentAt))).toBeGreaterThanOrEqual(before);
  });
});
