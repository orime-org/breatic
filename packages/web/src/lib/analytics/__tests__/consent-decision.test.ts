// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { CONSENT_REVISION, type AccountAdsView, type BrowserChoice, type BrowserChoices } from '@breatic/shared';
import {
  adsSituation,
  adsViewFor,
  cookieAfterWrites,
  countryFromTrace,
  decideOnLoad,
  fetchCountry,
  readAdsSharing,
  writesForClick,
  type AdsSituation,
} from '@web/lib/analytics/consent-decision';

const NOW = '2026-10-12T01:00:00.000Z';

const choice = (over: Partial<BrowserChoice> = {}): BrowserChoice => ({
  value: true,
  source: 'banner',
  decidedAt: NOW,
  revision: CONSENT_REVISION,
  ...over,
});
const NONE: BrowserChoices = { analytics: null, ads: null };
const open: AccountAdsView = { optedOut: false, source: null };
const optedOut: AccountAdsView = { optedOut: true, source: 'settings' };

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
    expect(decideOnLoad({ stored: NONE, optIn: false, gpc: true }).ads).toEqual({ value: false, source: 'gpc' });
  });

  it('keeps a stored choice without asking again', () => {
    const stored = { analytics: choice(), ads: choice({ value: false }) };
    expect(decideOnLoad({ stored, optIn: true, gpc: false })).toEqual({ analytics: null, ads: null, showBanner: false });
  });

  it('rewrites only an ads consent to a GPC refusal when GPC appears, whatever its source', () => {
    for (const source of ['banner', 'settings', 'implicit'] as const) {
      const stored = { analytics: choice(), ads: choice({ source }) };
      expect(decideOnLoad({ stored, optIn: true, gpc: true })).toEqual({
        analytics: null,
        ads: { value: false, source: 'gpc' },
        showBanner: false,
      });
    }
    const refused = { analytics: choice(), ads: choice({ value: false }) };
    expect(decideOnLoad({ stored: refused, optIn: true, gpc: true }).ads).toBeNull();
  });

  it('asks again for analytics after a revision change, keeping the ads refusal', () => {
    const stored = { analytics: null, ads: choice({ value: false }) };
    expect(decideOnLoad({ stored, optIn: true, gpc: false })).toEqual({ analytics: null, ads: null, showBanner: true });
  });
});

describe('adsSituation — the click table row (design §4.4.4)', () => {
  it.each<[string, { browserAds: boolean | null; gpc: boolean; account: AccountAdsView }, AdsSituation]>([
    ['GPC first, whatever else', { browserAds: true, gpc: true, account: optedOut }, 'gpc'],
    ['this browser refused ads', { browserAds: false, gpc: false, account: 'unknown' }, 'browserRefused'],
    ['the account opted out', { browserAds: true, gpc: false, account: optedOut }, 'accountOptedOut'],
    ['the account opted out and the browser has no choice', { browserAds: null, gpc: false, account: optedOut }, 'accountOptedOut'],
    ['the account is not known yet', { browserAds: true, gpc: false, account: 'unknown' }, 'accountUnknown'],
    ['nothing against ads, signed in', { browserAds: true, gpc: false, account: open }, 'open'],
    ['nothing against ads, signed out', { browserAds: null, gpc: false, account: 'signedOut' }, 'open'],
  ])('%s', (_label, input, expected) => {
    expect(adsSituation(input)).toBe(expected);
  });
});

describe('writesForClick, nothing against ads', () => {
  const base = { situation: 'open' as const, browserAds: null, signedIn: false };

  it('accepts or refuses both from the banner', () => {
    expect(writesForClick({ ...base, press: 'all', window: 'banner', toggles: null })).toEqual({
      kind: 'write',
      writes: { analytics: { value: true, source: 'banner' }, ads: { value: true, source: 'banner' } },
      put: null,
    });
    expect(writesForClick({ ...base, press: 'necessary', window: 'banner', toggles: null })).toEqual({
      kind: 'write',
      writes: { analytics: { value: false, source: 'banner' }, ads: { value: false, source: 'banner' } },
      put: null,
    });
  });

  it('writes the switches as set from settings, with no confirmation', () => {
    expect(writesForClick({ ...base, press: 'save', window: 'settings', toggles: { analytics: false, ads: true } })).toEqual({
      kind: 'write',
      writes: { analytics: { value: false, source: 'settings' }, ads: { value: true, source: 'settings' } },
      put: null,
    });
  });

  it('closes the account switch first when a signed-in press writes ads off', () => {
    const signedIn = { ...base, signedIn: true };
    expect(writesForClick({ ...signedIn, press: 'necessary', window: 'banner', toggles: null })).toMatchObject({ put: false });
    expect(
      writesForClick({ ...signedIn, press: 'save', window: 'settings', toggles: { analytics: true, ads: false } }),
    ).toMatchObject({ put: false });
    expect(writesForClick({ ...signedIn, press: 'all', window: 'banner', toggles: null })).toMatchObject({ put: null });
  });
});

describe('writesForClick under GPC', () => {
  const base = { situation: 'gpc' as const, browserAds: false, signedIn: false };

  it('turns on analytics only from "accept all", writing ads as a GPC refusal in the banner', () => {
    expect(writesForClick({ ...base, press: 'all', window: 'banner', toggles: null })).toEqual({
      kind: 'write',
      writes: { analytics: { value: true, source: 'banner' }, ads: { value: false, source: 'gpc' } },
      put: null,
    });
    expect(writesForClick({ ...base, press: 'all', window: 'settings', toggles: null })).toEqual({
      kind: 'write',
      writes: { analytics: { value: true, source: 'settings' } },
      put: null,
    });
  });

  it('writes only analytics on a save, since the ads switch cannot be moved', () => {
    for (const ads of [true, false]) {
      expect(writesForClick({ ...base, press: 'save', window: 'settings', toggles: { analytics: true, ads } })).toEqual({
        kind: 'write',
        writes: { analytics: { value: true, source: 'settings' } },
        put: null,
      });
    }
  });

  it('records the GPC refusal from either window while this browser has no ads choice, so the banner does not ask again', () => {
    const fresh = { ...base, browserAds: null };
    for (const press of ['all', 'save'] as const) {
      expect(writesForClick({ ...fresh, press, window: 'settings', toggles: { analytics: true, ads: false } })).toEqual({
        kind: 'write',
        writes: { analytics: { value: true, source: 'settings' }, ads: { value: false, source: 'gpc' } },
        put: null,
      });
    }
  });

  it('refuses both on "reject all"', () => {
    expect(writesForClick({ ...base, press: 'necessary', window: 'settings', toggles: null })).toEqual({
      kind: 'write',
      writes: { analytics: { value: false, source: 'settings' }, ads: { value: false, source: 'settings' } },
      put: null,
    });
  });
});

describe('writesForClick while ads are opted out here', () => {
  for (const [situation, browserAds] of [
    ['browserRefused', false],
    ['accountOptedOut', null],
    ['accountOptedOut', true],
  ] as const) {
    describe(`${situation} with this browser's ads ${String(browserAds)}`, () => {
      const base = { situation, browserAds, signedIn: situation === 'accountOptedOut' };

      it('turns on analytics only from the banner, leaving ads off', () => {
        const outcome = writesForClick({ ...base, press: 'all', window: 'banner', toggles: null });
        expect(outcome).toMatchObject({ kind: 'write', writes: { analytics: { value: true, source: 'banner' } } });
        const expectedAds = browserAds === null ? { value: false, source: 'banner' } : undefined;
        expect(outcome.kind === 'write' && outcome.writes.ads).toEqual(expectedAds ?? undefined);
      });

      it('asks for confirmation before turning ads on from settings', () => {
        expect(writesForClick({ ...base, press: 'all', window: 'settings', toggles: null })).toEqual({ kind: 'confirm' });
        expect(
          writesForClick({ ...base, press: 'save', window: 'settings', toggles: { analytics: false, ads: true } }),
        ).toEqual({ kind: 'confirm' });
      });

      it('writes ads on once confirmed, and leaves ads alone when declined', () => {
        const press = { ...base, press: 'save' as const, window: 'settings' as const, toggles: { analytics: false, ads: true } };
        expect(writesForClick({ ...press, confirmed: true })).toEqual({
          kind: 'write',
          writes: { analytics: { value: false, source: 'settings' }, ads: { value: true, source: 'settings' } },
          put: base.signedIn ? true : null,
        });
        expect(writesForClick({ ...press, confirmed: false })).toEqual({
          kind: 'write',
          writes: { analytics: { value: false, source: 'settings' } },
          put: null,
        });
      });

      it('writes a refusal without asking', () => {
        expect(
          writesForClick({ ...base, press: 'save', window: 'settings', toggles: { analytics: true, ads: false } }),
        ).toMatchObject({ kind: 'write', writes: { ads: { value: false, source: 'settings' } } });
      });
    });
  }

  it('opens the account switch when a signed-in browser that refused here confirms', () => {
    const press = { situation: 'browserRefused' as const, browserAds: false, signedIn: true, toggles: null };
    expect(writesForClick({ ...press, press: 'all', window: 'settings', confirmed: true })).toMatchObject({ put: true });
  });
});

describe('writesForClick on a save that leaves the ads switch untouched', () => {
  const untouched = { press: 'save' as const, window: 'settings' as const, toggles: { analytics: true, ads: null } };

  it('writes analytics alone and leaves the account switch as it was', () => {
    expect(writesForClick({ ...untouched, situation: 'browserRefused', browserAds: false, signedIn: true })).toEqual({
      kind: 'write',
      writes: { analytics: { value: true, source: 'settings' } },
      put: null,
    });
  });

  it('saves analytics without waiting for an account switch it does not touch', () => {
    expect(writesForClick({ ...untouched, situation: 'accountUnknown', browserAds: true, signedIn: true })).toEqual({
      kind: 'write',
      writes: { analytics: { value: true, source: 'settings' } },
      put: null,
    });
  });
});

describe('writesForClick while the account switch is unknown', () => {
  const base = { situation: 'accountUnknown' as const, signedIn: true };

  it('turns on analytics only from the banner and leaves the ads choice as it is', () => {
    for (const browserAds of [null, true]) {
      expect(writesForClick({ ...base, browserAds, press: 'all', window: 'banner', toggles: null })).toEqual({
        kind: 'write',
        writes: { analytics: { value: true, source: 'banner' } },
        put: null,
      });
    }
  });

  it('waits for the account before turning ads on from settings', () => {
    expect(writesForClick({ ...base, browserAds: true, press: 'all', window: 'settings', toggles: null })).toEqual({
      kind: 'wait',
    });
  });

  it('refuses at once, closing the account switch first', () => {
    expect(writesForClick({ ...base, browserAds: true, press: 'necessary', window: 'banner', toggles: null })).toEqual({
      kind: 'write',
      writes: { analytics: { value: false, source: 'banner' }, ads: { value: false, source: 'banner' } },
      put: false,
    });
  });
});

describe('adsViewFor', () => {
  it('lets ads run only when the browser consents, sends no GPC and the account allows', () => {
    expect(adsViewFor({ browserAds: true, gpc: false, account: open })).toMatchObject({ allowed: true, known: true, adsOn: true });
    expect(adsViewFor({ browserAds: true, gpc: false, account: 'signedOut' })).toMatchObject({ allowed: true, status: 'browser' });
    expect(adsViewFor({ browserAds: true, gpc: false, account: optedOut })).toMatchObject({
      allowed: false,
      known: true,
      status: 'account',
      optedOut: true,
      adsOn: false,
    });
    expect(adsViewFor({ browserAds: true, gpc: true, account: open })).toMatchObject({
      allowed: false,
      status: 'gpc',
      optedOut: true,
      adsOn: false,
    });
  });

  it('keeps ads off while the account is unknown, without counting it as a refusal, and presets the switch from this browser', () => {
    expect(adsViewFor({ browserAds: true, gpc: false, account: 'unknown' })).toEqual({
      allowed: false,
      known: false,
      status: null,
      optedOut: false,
      adsOn: true,
    });
  });

  it('counts this browser’s own refusal, missing choice or GPC as known at once', () => {
    for (const [browserAds, gpc] of [
      [false, false],
      [null, false],
      [true, true],
    ] as const) {
      expect(adsViewFor({ browserAds, gpc, account: 'unknown' })).toMatchObject({ allowed: false, known: true, adsOn: false });
    }
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

describe('readAdsSharing', () => {
  it('takes the account switch as the server answers it', () => {
    expect(readAdsSharing({ optedOut: false, source: null })).toEqual({ optedOut: false, source: null });
    expect(readAdsSharing({ optedOut: true, source: 'gpc' })).toEqual({ optedOut: true, source: 'gpc' });
  });

  it('refuses anything else, so the page treats the answer as unknown', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { optedOut: 'no', source: null },
      { optedOut: true, source: null },
      { optedOut: false, source: 'settings' },
      { optedOut: true, source: 'banner' },
    ]) {
      expect(readAdsSharing(bad)).toBeNull();
    }
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
