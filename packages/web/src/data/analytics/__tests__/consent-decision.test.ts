// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { CONSENT_REVISION, type BrowserChoice, type BrowserChoices } from '@breatic/shared';
import {
  adsViewFor,
  cookieAfterWrites,
  countryFromTrace,
  decideOnLoad,
  fetchCountry,
  writesForClick,
} from '@web/data/analytics/consent-decision';

const NOW = '2026-10-12T01:00:00.000Z';

const choice = (over: Partial<BrowserChoice> = {}): BrowserChoice => ({
  value: true,
  source: 'banner',
  decidedAt: NOW,
  revision: CONSENT_REVISION,
  ...over,
});
const NONE: BrowserChoices = { analytics: null, ads: null };

describe('decideOnLoad (design §4.4.4, events that are not presses)', () => {
  it('asks first in an opt-in region and writes nothing meanwhile, GPC or not', () => {
    for (const gpc of [false, true]) {
      expect(decideOnLoad({ stored: NONE, optIn: true, gpc })).toEqual({ analytics: null, ads: null, showBanner: true });
    }
  });

  it('turns both on, implicitly, elsewhere, and writes ads as a GPC refusal for a browser sending GPC', () => {
    expect(decideOnLoad({ stored: NONE, optIn: false, gpc: false })).toEqual({
      analytics: { value: true, source: 'implicit' },
      ads: { value: true, source: 'implicit' },
      showBanner: false,
    });
    expect(decideOnLoad({ stored: NONE, optIn: false, gpc: true })).toEqual({
      analytics: { value: true, source: 'implicit' },
      ads: { value: false, source: 'gpc' },
      showBanner: false,
    });
  });

  it('keeps a stored choice without asking again', () => {
    const stored = { analytics: choice(), ads: choice({ value: false }) };
    expect(decideOnLoad({ stored, optIn: true, gpc: false })).toEqual({ analytics: null, ads: null, showBanner: false });
  });

  it('rewrites only a regional ads default to a GPC refusal when GPC appears', () => {
    const implicit = { analytics: choice({ source: 'implicit' }), ads: choice({ source: 'implicit' }) };
    expect(decideOnLoad({ stored: implicit, optIn: false, gpc: true })).toEqual({
      analytics: null,
      ads: { value: false, source: 'gpc' },
      showBanner: false,
    });
  });

  it('keeps the visitor’s own ads consent under GPC, and a refusal as it is', () => {
    for (const source of ['banner', 'settings'] as const) {
      const stored = { analytics: choice(), ads: choice({ source }) };
      expect(decideOnLoad({ stored, optIn: true, gpc: true }).ads).toBeNull();
    }
    const refused = { analytics: choice(), ads: choice({ value: false }) };
    expect(decideOnLoad({ stored: refused, optIn: true, gpc: true }).ads).toBeNull();
  });

  it('asks again for analytics after a revision change, keeping the ads refusal', () => {
    const stored = { analytics: null, ads: choice({ value: false }) };
    expect(decideOnLoad({ stored, optIn: true, gpc: false })).toEqual({ analytics: null, ads: null, showBanner: true });
  });
});

describe('writesForClick (design §4.4.4 click table)', () => {
  it('accepts or refuses both, with the window as the source', () => {
    for (const window of ['banner', 'settings'] as const) {
      expect(writesForClick({ press: 'all', window, toggles: null })).toEqual({
        analytics: { value: true, source: window },
        ads: { value: true, source: window },
      });
      expect(writesForClick({ press: 'necessary', window, toggles: null })).toEqual({
        analytics: { value: false, source: window },
        ads: { value: false, source: window },
      });
    }
  });

  it('writes both switches as set on a save', () => {
    expect(writesForClick({ press: 'save', window: 'settings', toggles: { analytics: false, ads: true } })).toEqual({
      analytics: { value: false, source: 'settings' },
      ads: { value: true, source: 'settings' },
    });
  });
});

describe('adsViewFor', () => {
  it('follows this browser’s ads choice', () => {
    expect(adsViewFor({ ads: choice(), gpc: false })).toEqual({ allowed: true });
    expect(adsViewFor({ ads: choice({ value: false }), gpc: false })).toEqual({ allowed: false });
    expect(adsViewFor({ ads: null, gpc: false })).toEqual({ allowed: false });
  });

  it('lets GPC refuse a regional default, not the visitor’s own consent', () => {
    expect(adsViewFor({ ads: choice({ source: 'implicit' }), gpc: true })).toEqual({ allowed: false });
    expect(adsViewFor({ ads: choice({ source: 'settings' }), gpc: true })).toEqual({ allowed: true });
  });
});

describe('cookieAfterWrites', () => {
  const prior: BrowserChoices = { analytics: choice(), ads: choice({ value: false, source: 'settings' }) };
  const stored = { analytics: { decidedAt: NOW, source: 'banner' }, ads: { decidedAt: NOW, source: 'settings' } };
  const LATER = '2026-10-13T01:00:00.000Z';

  it('keeps a category the press leaves out exactly as it was before the press', () => {
    const next = cookieAfterWrites({ analytics: { value: true, source: 'settings' } }, prior, stored, LATER);
    expect(next.accepted).toEqual(['analytics']);
    expect(next.data.ads).toBe(stored.ads);
    expect(next.data.analytics).toEqual({ decidedAt: LATER, source: 'settings' });
  });

  it('keeps an ads consent the press leaves out, category and entry alike', () => {
    const consenting: BrowserChoices = { analytics: choice(), ads: choice() };
    const next = cookieAfterWrites({ analytics: { value: true, source: 'settings' } }, consenting, stored, LATER);
    expect(next.accepted).toEqual(['analytics', 'ads']);
    expect(next.data.ads).toBe(stored.ads);
  });

  it('gives every written category the same time and its source', () => {
    const next = cookieAfterWrites(
      { analytics: { value: false, source: 'banner' }, ads: { value: true, source: 'banner' } },
      prior,
      stored,
      LATER,
    );
    expect(next.accepted).toEqual(['ads']);
    expect(next.data).toEqual({ analytics: { decidedAt: LATER, source: 'banner' }, ads: { decidedAt: LATER, source: 'banner' } });
  });

  it('drops an entry that is no longer in force', () => {
    const next = cookieAfterWrites({ analytics: { value: true, source: 'implicit' } }, NONE, stored, LATER);
    expect(next.data.ads).toBeUndefined();
    expect(next.accepted).toEqual(['analytics']);
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
