// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { CONSENT_REVISION, type BrowserAds, type BrowserAnalytics, type BrowserChoices } from '@breatic/shared';
import {
  adsNotice,
  countryFromTrace,
  decideOnLoad,
  fetchCountry,
  reportBody,
  writesForClick,
} from '@web/lib/analytics/consent-decision';

const NOW = '2026-10-12T01:00:00.000Z';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const analytics = (over: Partial<BrowserAnalytics> = {}): BrowserAnalytics => ({
  decisionId: ID_A,
  value: true,
  source: 'banner',
  decidedAt: NOW,
  revision: CONSENT_REVISION,
  ...over,
});
const ads = (over: Partial<BrowserAds> = {}): BrowserAds => ({
  decisionId: ID_B,
  value: true,
  source: 'banner',
  noticeShown: false,
  gpcAtDecision: false,
  decidedAt: NOW,
  revision: CONSENT_REVISION,
  ...over,
});
const NONE: BrowserChoices = { analytics: null, ads: null };

describe('decideOnLoad', () => {
  it('asks first in an opt-in region and writes nothing meanwhile', () => {
    expect(decideOnLoad({ stored: NONE, optIn: true, gpc: false })).toEqual({ analytics: null, ads: null, showBanner: true });
    expect(decideOnLoad({ stored: NONE, optIn: true, gpc: true })).toEqual({ analytics: null, ads: null, showBanner: true });
  });

  it('turns both on, implicitly, elsewhere, and keeps ads off for a browser sending GPC', () => {
    expect(decideOnLoad({ stored: NONE, optIn: false, gpc: false })).toEqual({
      analytics: { value: true, source: 'implicit' },
      ads: { value: true, source: 'implicit' },
      showBanner: false,
    });
    expect(decideOnLoad({ stored: NONE, optIn: false, gpc: true }).ads).toEqual({ value: false, source: 'gpc', gpcAtDecision: true });
  });

  it('keeps a stored choice without asking again', () => {
    const stored = { analytics: analytics({ value: false }), ads: ads({ value: false }) };
    expect(decideOnLoad({ stored, optIn: true, gpc: false })).toEqual({ analytics: null, ads: null, showBanner: false });
  });

  it('rewrites only the ads choice to a GPC refusal when GPC appears, unless it is an override saved under GPC', () => {
    const stored = { analytics: analytics(), ads: ads() };
    expect(decideOnLoad({ stored, optIn: false, gpc: true })).toEqual({
      analytics: null,
      ads: { value: false, source: 'gpc', gpcAtDecision: true },
      showBanner: false,
    });
    const saved = { analytics: analytics(), ads: ads({ source: 'settings', noticeShown: 'gpc', gpcAtDecision: true }) };
    expect(decideOnLoad({ stored: saved, optIn: false, gpc: true }).ads).toBeNull();
    const before = { analytics: analytics(), ads: ads({ source: 'settings', noticeShown: 'account', gpcAtDecision: false }) };
    expect(decideOnLoad({ stored: before, optIn: false, gpc: true }).ads).toEqual({
      value: false,
      source: 'gpc',
      gpcAtDecision: true,
    });
  });

  it('asks again for a category that lapsed, keeping the ads refusal', () => {
    const stored = { analytics: null, ads: ads({ value: false }) };
    expect(decideOnLoad({ stored, optIn: true, gpc: false })).toEqual({ analytics: null, ads: null, showBanner: true });
    expect(decideOnLoad({ stored, optIn: false, gpc: false }).analytics).toEqual({ value: true, source: 'implicit' });
  });
});

describe('writesForClick', () => {
  it('accepts both on "accept all" with nothing against ads', () => {
    expect(writesForClick({ stored: null, role: 'all', window: 'banner', toggles: null, notice: false, gpc: false })).toEqual({
      analytics: { value: true, source: 'banner' },
      ads: { value: true, source: 'banner', noticeShown: false, gpcAtDecision: false },
    });
  });

  it('turns only analytics on for "accept all" under GPC, writing the ads refusal as GPC', () => {
    expect(writesForClick({ stored: null, role: 'all', window: 'settings', toggles: null, notice: 'gpc', gpc: true })).toEqual({
      analytics: { value: true, source: 'settings' },
      ads: { value: false, source: 'gpc', noticeShown: false, gpcAtDecision: true },
    });
  });

  it('leaves the ads choice as it is for "accept all" while the account is opted out', () => {
    expect(writesForClick({ stored: null, role: 'all', window: 'banner', toggles: null, notice: 'account', gpc: false })).toEqual({
      analytics: { value: true, source: 'banner' },
    });
  });

  it('refuses both on "reject all", keeping the notice only for a choice made in settings', () => {
    expect(writesForClick({ stored: null, role: 'necessary', window: 'banner', toggles: null, notice: 'gpc', gpc: true })).toEqual({
      analytics: { value: false, source: 'banner' },
      ads: { value: false, source: 'banner', noticeShown: false, gpcAtDecision: true },
    });
    expect(writesForClick({ stored: null, role: 'necessary', window: 'settings', toggles: null, notice: 'account', gpc: false }).ads).toEqual(
      { value: false, source: 'settings', noticeShown: 'account', gpcAtDecision: false },
    );
  });

  it('saves the switches as set, marking ads switched on under a notice as an override', () => {
    expect(
      writesForClick({ stored: null, role: 'save', window: 'settings', toggles: { analytics: false, ads: true }, notice: 'account', gpc: true }),
    ).toEqual({
      analytics: { value: false, source: 'settings' },
      ads: { value: true, source: 'settings', noticeShown: 'account', gpcAtDecision: true },
    });
    expect(
      writesForClick({ stored: null, role: 'save', window: 'settings', toggles: { analytics: true, ads: true }, notice: false, gpc: false }).ads,
    ).toEqual({ value: true, source: 'settings', noticeShown: false, gpcAtDecision: false });
  });
});

describe('writesForClick with an override in force', () => {
  const override = ads({ source: 'settings', noticeShown: 'gpc', gpcAtDecision: true });

  it('keeps an override when "accept all" leaves ads on', () => {
    expect(writesForClick({ stored: override, role: 'all', window: 'settings', toggles: null, notice: false, gpc: true })).toEqual({
      analytics: { value: true, source: 'settings' },
    });
  });

  it('keeps an override when a save leaves the ads switch on', () => {
    const toggles = { analytics: false, ads: true };
    expect(writesForClick({ stored: override, role: 'save', window: 'settings', toggles, notice: false, gpc: true })).toEqual({
      analytics: { value: false, source: 'settings' },
    });
  });

  it('writes a plain consent over a plain consent, and a refusal over an override', () => {
    expect(writesForClick({ stored: ads(), role: 'all', window: 'banner', toggles: null, notice: false, gpc: false }).ads).toEqual({
      value: true,
      source: 'banner',
      noticeShown: false,
      gpcAtDecision: false,
    });
    expect(writesForClick({ stored: override, role: 'necessary', window: 'settings', toggles: null, notice: false, gpc: true }).ads)
      .toMatchObject({ value: false });
  });
});

describe('reportBody', () => {
  it('reports each category the visitor chose, with its id', () => {
    const body = reportBody({ analytics: analytics(), ads: ads({ value: false, source: 'gpc' }) }, CONSENT_REVISION, NOW);
    expect(body).toEqual({
      decisions: [
        { decisionId: ID_A, category: 'analytics', value: true, source: 'banner', noticeShown: false, gpcAtDecision: false, decidedAt: NOW },
        { decisionId: ID_B, category: 'ads', value: false, source: 'gpc', noticeShown: false, gpcAtDecision: false, decidedAt: NOW },
      ],
      revision: CONSENT_REVISION,
      sentAt: NOW,
    });
  });

  it('leaves out regional defaults and choices without an id, and sends nothing when none is left', () => {
    const body = reportBody({ analytics: analytics({ source: 'implicit' }), ads: ads({ decisionId: undefined }) }, 1, NOW);
    expect(body).toBeNull();
    expect(reportBody(NONE, 1, NOW)).toBeNull();
  });
});

describe('adsNotice', () => {
  it('shows the account notice to a signed-in visitor whose ads are stopped by an opt-out', () => {
    expect(adsNotice({ signedIn: true, outcome: { allowed: false, notice: 'gpc' }, gpc: true, ads: null })).toBe('account');
    expect(adsNotice({ signedIn: true, outcome: { allowed: false, notice: 'account' }, gpc: false, ads: null })).toBe('account');
    expect(adsNotice({ signedIn: true, outcome: { allowed: true, notice: null }, gpc: true, ads: null })).toBe(false);
  });

  it('shows the GPC notice to a signed-out browser sending GPC, unless it saved an override under GPC', () => {
    expect(adsNotice({ signedIn: false, outcome: { allowed: false, notice: 'gpc' }, gpc: true, ads: null })).toBe('gpc');
    const saved = ads({ source: 'settings', noticeShown: 'gpc', gpcAtDecision: true });
    expect(adsNotice({ signedIn: false, outcome: { allowed: true, notice: null }, gpc: true, ads: saved })).toBe(false);
    expect(adsNotice({ signedIn: false, outcome: { allowed: true, notice: null }, gpc: false, ads: null })).toBe(false);
  });
});

describe('countryFromTrace', () => {
  it('reads the loc line', () => {
    expect(countryFromTrace('fl=1\nip=1.2.3.4\nloc=DE\ntls=TLSv1.3\n')).toBe('DE');
  });

  it('returns null without one', () => {
    expect(countryFromTrace('fl=1\n')).toBeNull();
    expect(countryFromTrace('<html>not found</html>')).toBeNull();
  });
});

describe('fetchCountry', () => {
  const ORIGIN = 'https://app.example.com';

  it('asks the same-origin trace endpoint without credentials', async () => {
    const request = vi.fn(async () => new Response('loc=US\n'));
    expect(await fetchCountry(ORIGIN, request as never)).toBe('US');
    expect(request).toHaveBeenCalledWith(
      'https://app.example.com/cdn-cgi/trace',
      { credentials: 'omit' },
      expect.objectContaining({ replaySafe: true }),
    );
  });

  it('returns null when the endpoint fails, answers an error, or is slower than the limit', async () => {
    expect(await fetchCountry(ORIGIN, async () => Promise.reject(new Error('down')))).toBeNull();
    expect(await fetchCountry(ORIGIN, async () => new Response('loc=US', { status: 404 }))).toBeNull();
    const slow = (_url: string, _init: RequestInit, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    expect(await fetchCountry(ORIGIN, slow as never, 10)).toBeNull();
  });
});
