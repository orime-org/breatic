// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The language a user picked has to reach the server, or the server cannot
 * answer in it.
 *
 * `changeLocale` writes `localStorage` and swaps the UI catalog; it does not
 * touch the network. The server reads `Accept-Language`, which the browser
 * sends from the OS/browser setting. Those are two different languages, and
 * nothing joined them — so an English browser with the UI switched to Chinese
 * got English error text no matter how much of the backend went through `t()`.
 *
 * These tests drive the real axios instance through a stub adapter rather
 * than inspecting the interceptor function, because the failure that shipped
 * was never a wrong function — it was no function at all. A test that calls a
 * helper directly passes just as happily when nothing registers it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setLocale, getLocale } from '@breatic/shared';
import type { AxiosRequestConfig } from 'axios';

import { request } from '@web/data/api/request';

/**
 * Send one request through the real instance with a stub adapter, and report
 * the headers axios ended up sending.
 * @param config - Extra config merged into the request.
 * @returns The outgoing headers, normalised to a plain object.
 */
async function headersSentFor(
  config: AxiosRequestConfig = {},
): Promise<Record<string, string>> {
  let seen: Record<string, string> = {};
  await request.request({
    url: '/anything',
    // The adapter runs after every request interceptor, so what it sees is
    // what would have gone on the wire.
    adapter: (cfg) => {
      seen = Object.fromEntries(
        Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, String(v)]),
      );
      return Promise.resolve({
        data: { data: null },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: cfg,
      });
    },
    ...config,
  });
  return seen;
}

afterEach(() => {
  // `vitest.setup.ts` selects `en` before any suite runs; leave it there.
  setLocale('en');
});

describe('every request carries the language the user chose', () => {
  it('sends Accept-Language matching the active locale', async () => {
    setLocale('zh-CN');
    const headers = await headersSentFor();
    expect(headers['Accept-Language']).toBe('zh-CN');
  });

  it('follows the user to a different language', async () => {
    // What the language switcher does, and what has to reach the server.
    for (const locale of ['ja', 'ko', 'zh-TW', 'en'] as const) {
      setLocale(locale);
      const headers = await headersSentFor();
      expect(headers['Accept-Language']).toBe(locale);
    }
  });

  it('sends the exact locale, not a prefix the server would re-guess', async () => {
    // The server prefix-matches `zh-*` to the first supported `zh-` entry,
    // which is `zh-CN`. Sending `zh-TW` outright means it matches exactly
    // instead, so a traditional-Chinese UI cannot get simplified error text.
    setLocale('zh-TW');
    const headers = await headersSentFor();
    expect(headers['Accept-Language']).toBe('zh-TW');
    expect(headers['Accept-Language']).not.toBe('zh-CN');
  });

  it('leaves a caller-supplied Accept-Language alone', async () => {
    setLocale('ja');
    const headers = await headersSentFor({
      headers: { 'Accept-Language': 'de' },
    });
    expect(headers['Accept-Language']).toBe('de');
  });

  it('does not disturb the headers the instance already sets', async () => {
    setLocale('ko');
    const headers = await headersSentFor();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('reads the locale per request, not once at module load', async () => {
    // The instance is a module-level singleton created at import time. If the
    // header were baked in then, it would be stuck at whatever locale was
    // active during the first import for the life of the page.
    setLocale('ja');
    expect((await headersSentFor())['Accept-Language']).toBe('ja');
    setLocale('zh-CN');
    expect((await headersSentFor())['Accept-Language']).toBe('zh-CN');
    expect(getLocale()).toBe('zh-CN');
  });
});
