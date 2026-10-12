// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { countryFromTrace, decideOnLoad, fetchCountry } from '@web/lib/analytics/consent-decision';

const NOW = '2026-10-12T01:00:00.000Z';
const EARLIER = '2026-10-01T01:00:00.000Z';

describe('decideOnLoad', () => {
  it('asks first in an opt-in region and loads nothing meanwhile', () => {
    expect(decideOnLoad({ stored: null, optIn: true, gpc: false, now: NOW })).toEqual({
      choice: null,
      write: false,
      showBanner: true,
    });
  });

  it('turns both on, implicitly, elsewhere', () => {
    expect(decideOnLoad({ stored: null, optIn: false, gpc: false, now: NOW })).toEqual({
      choice: { analytics: true, ads: true, source: 'implicit', decidedAt: NOW },
      write: true,
      showBanner: false,
    });
  });

  it('keeps ads off for a browser sending GPC', () => {
    expect(decideOnLoad({ stored: null, optIn: false, gpc: true, now: NOW }).choice).toEqual({
      analytics: true,
      ads: false,
      source: 'gpc',
      decidedAt: NOW,
    });
  });

  it('turns implicit ads off when GPC appears later, and leaves an explicit choice alone', () => {
    const implicit = { analytics: true, ads: true, source: 'implicit' as const, decidedAt: EARLIER };
    expect(decideOnLoad({ stored: implicit, optIn: false, gpc: true, now: NOW })).toEqual({
      choice: { analytics: true, ads: false, source: 'gpc', decidedAt: NOW },
      write: true,
      showBanner: false,
    });
    const explicit = { ...implicit, source: 'banner' as const };
    expect(decideOnLoad({ stored: explicit, optIn: false, gpc: true, now: NOW })).toEqual({
      choice: explicit,
      write: false,
      showBanner: false,
    });
  });

  it('keeps a stored choice without asking again, wherever the visitor is', () => {
    const stored = { analytics: false, ads: false, source: 'banner' as const, decidedAt: EARLIER };
    expect(decideOnLoad({ stored, optIn: true, gpc: false, now: NOW })).toEqual({
      choice: stored,
      write: false,
      showBanner: false,
    });
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
