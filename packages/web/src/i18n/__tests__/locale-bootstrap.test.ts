// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * English is bundled into the entry; zh-CN, zh-TW, ja and ko are downloaded as
 * their own chunks at startup or on a switch (breatic#1374).
 *
 * Each case starts from a fresh module registry, so `@breatic/shared`, the
 * bootstrap module and the mocked chunks are imported together and share one
 * engine. The engine is then reset to English alone, which is what a reader
 * has before any other locale's chunk arrives. A chunk waits on the gate a
 * case sets for it, set only after the bootstrap module has loaded so that
 * module load never waits on a gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SharedModule from '@breatic/shared';
import en from '@locales/en.json';
import type * as BootstrapModule from '@web/i18n/locale-bootstrap';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const h = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock('@sentry/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/react')>()),
  captureException: h.captureException,
}));

/** The locales downloaded as chunks of their own. */
const DOWNLOADED = ['zh-CN', 'zh-TW', 'ja', 'ko'] as const;

/** What a chunk download waits on before it hands its catalog over. */
type ChunkWait = () => Promise<void>;
const gates = new Map<string, ChunkWait>();

type Shared = typeof SharedModule;
type Bootstrap = typeof BootstrapModule;

const STORAGE_KEY = 'breatic.locale';

let shared: Shared;
let boot: Bootstrap;

interface Gate {
  open: () => void;
  fail: (error: Error) => void;
}

/**
 * Hold a locale's chunk download until the case opens or fails it.
 * @param locale - The locale whose chunk waits.
 * @returns Handles that let the download finish or reject.
 */
function hold(locale: string): Gate {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  gates.set(locale, () => promise);
  return { open, fail };
}

/**
 * Make a locale's chunk download reject.
 * @param locale - The locale whose chunk fails.
 * @param error - The rejection.
 */
function failChunk(locale: string, error: Error): void {
  gates.set(locale, () => Promise.reject(error));
}

beforeEach(async () => {
  vi.resetModules();
  gates.clear();
  // Registered per case, after the registry reset: a hoisted `vi.mock` hands
  // every case the one module its factory produced first.
  for (const locale of DOWNLOADED) {
    vi.doMock(`@locales/${locale}.json`, async (importOriginal) => {
      await gates.get(locale)?.();
      return { ...(await importOriginal<Record<string, unknown>>()) };
    });
  }
  h.captureException.mockClear();
  window.localStorage.clear();
  shared = await import('@breatic/shared');
  boot = await import('@web/i18n/locale-bootstrap');
  shared.resetLocales();
  shared.setLocaleMessages('en', en as Record<string, unknown>);
  shared.setLocale('en');
});

afterEach(() => {
  // The shared teardown imports modules after this hook; no chunk it reaches
  // may still be held or failing.
  gates.clear();
  shared.resetLocales();
});

describe('bootstrapLocale', () => {
  it('waits for the stored locale to download before switching to it', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'ja');
    const ja = hold('ja');

    const started = boot.bootstrapLocale();
    expect(shared.getLocale()).toBe('en');

    ja.open();
    await started;
    expect(shared.getLocale()).toBe('ja');
    expect(shared.getAvailableLocales()).toContain('ja');
  });

  it('shows English, keeps the stored choice and reports once when the chunk fails', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'ja');
    const error = new Error('chunk download failed');
    failChunk('ja', error);

    await boot.bootstrapLocale();

    expect(shared.getLocale()).toBe('en');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ja');
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.objectContaining({ error_boundary: 'locale-chunk' }) }),
    );
  });
});

describe('changeLocale', () => {
  it('switches a registered locale at once and downloads nothing', async () => {
    shared.setLocaleMessages('ko', {});
    const chunk = vi.fn(() => Promise.resolve());
    gates.set('ko', chunk);

    const result = boot.changeLocale('ko');
    expect(shared.getLocale()).toBe('ko');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ko');

    expect(await result).toBe('switched');
    expect(chunk).not.toHaveBeenCalled();
  });

  it('downloads a locale not registered yet, then switches and remembers it', async () => {
    const ja = hold('ja');

    const result = boot.changeLocale('ja');
    expect(shared.getLocale()).toBe('en');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    ja.open();
    expect(await result).toBe('switched');
    expect(shared.getLocale()).toBe('ja');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ja');
    expect(shared.getAvailableLocales()).toContain('ja');
  });

  it('keeps the last request when an earlier download lands after it', async () => {
    const ja = hold('ja');
    const ko = hold('ko');

    const first = boot.changeLocale('ja');
    const second = boot.changeLocale('ko');

    ko.open();
    expect(await second).toBe('switched');
    expect(shared.getLocale()).toBe('ko');

    ja.open();
    expect(await first).toBe('superseded');
    expect(shared.getLocale()).toBe('ko');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ko');
  });

  it('stays on English when English is picked while another locale downloads', async () => {
    const ja = hold('ja');

    const first = boot.changeLocale('ja');
    expect(await boot.changeLocale('en')).toBe('switched');

    ja.open();
    expect(await first).toBe('superseded');
    expect(shared.getLocale()).toBe('en');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('en');
  });

  it('leaves the language and the stored choice alone when the download fails', async () => {
    shared.setLocaleMessages('ko', {});
    await boot.changeLocale('ko');
    failChunk('ja', new Error('chunk download failed'));

    expect(await boot.changeLocale('ja')).toBe('failed');
    expect(shared.getLocale()).toBe('ko');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ko');
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

/** What the build hands the bootstrap: each locale's wording of the keys every locale needs. */
declare const __EVERY_LOCALE_MESSAGES__: Record<string, unknown>;

describe('__EVERY_LOCALE_MESSAGES__', () => {
  it('holds the reference wording of all five locales, as each locale file writes it', () => {
    const expected = Object.fromEntries(
      LOCALE_CATALOGS.map(([tag, catalog]) => [
        tag,
        { canvas: { promptMark: { reference: readPath(catalog, 'canvas.promptMark.reference') } } },
      ]),
    );
    expect(__EVERY_LOCALE_MESSAGES__).toEqual(expected);
  });
});
