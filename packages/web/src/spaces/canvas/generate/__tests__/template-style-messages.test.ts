// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template style words (inner#1817) download on demand, once per locale,
 * and join the locale's catalog; a failed download is reported and answered
 * with false.
 */
import { captureException } from '@sentry/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetLocales, setLocale, setLocaleMessages, t } from '@breatic/shared';

import { templateStyleMessagesLoader } from '../template-style-messages';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const WORDS = { canvas: { template: { styleSet: { 'film-styles': { style: { a: { name: 'Woodcut' } } } } } } };

beforeEach(() => {
  setLocaleMessages('en', { canvas: { template: { title: 'Templates' } } });
  setLocale('en');
});

afterEach(() => {
  resetLocales();
  vi.mocked(captureException).mockClear();
});

describe('templateStyleMessagesLoader', () => {
  it('merges the locale\'s style words into its catalog and answers true', async () => {
    const ensure = templateStyleMessagesLoader({ en: () => Promise.resolve({ default: WORDS }) });
    await expect(ensure('en')).resolves.toBe(true);
    expect(t('canvas.template.styleSet.film-styles.style.a.name')).toBe('Woodcut');
    expect(t('canvas.template.title')).toBe('Templates');
  });

  it('downloads a locale once however often it is asked', async () => {
    const load = vi.fn(() => Promise.resolve({ default: WORDS }));
    const ensure = templateStyleMessagesLoader({ en: load });
    await Promise.all([ensure('en'), ensure('en')]);
    await ensure('en');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports a failed download and answers false', async () => {
    const ensure = templateStyleMessagesLoader({ en: () => Promise.reject(new Error('chunk 404')) });
    await expect(ensure('en')).resolves.toBe(false);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { error_boundary: 'template-styles-chunk', locale: 'en' } });
  });

  it('answers false for a locale with no style catalog', async () => {
    const ensure = templateStyleMessagesLoader({});
    await expect(ensure('en')).resolves.toBe(false);
  });
});
