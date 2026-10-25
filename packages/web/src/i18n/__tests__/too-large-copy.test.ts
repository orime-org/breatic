// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two sentences a request refused as too large is said with
 * (inner#1006 design §5 and §12 N1; test spec §7.4 E09, E10): the server's
 * `server.error.payload_too_large`, naming the limit through the ICU
 * placeholder `{limit}` and shown by the page too, and one for when the page
 * holds no limit, which names no number at all. Every shipped locale has both,
 * and none keeps the page's former copy of the first, `errorTooLarge`.
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

describe.each(LOCALE_CATALOGS)('%s', (_tag, catalog) => {
  it('has payload_too_large, carrying the {limit} placeholder', () => {
    const message = readPath(catalog, 'server.error.payload_too_large');
    expect(typeof message).toBe('string');
    expect(message as string).toContain('{limit}');
  });

  it('no longer has errorTooLarge, which said the same thing in other words', () => {
    expect(readPath(catalog, 'canvas.generatePanel.errorTooLarge')).toBeUndefined();
  });

  it('has errorTooLargeNoLimit, with no placeholder and no number', () => {
    const message = readPath(catalog, 'canvas.generatePanel.errorTooLargeNoLimit');
    expect(typeof message).toBe('string');
    expect((message as string).trim()).not.toBe('');
    expect(message as string).not.toContain('{');
    expect(message as string).not.toMatch(/\d/);
  });
});

describe('the English sentences', () => {
  it('errorTooLargeNoLimit reads as decided in N1', () => {
    const [, en] = LOCALE_CATALOGS[0];
    expect(readPath(en, 'canvas.generatePanel.errorTooLargeNoLimit')).toBe(
      'This request is too large. Shorten the prompt or the text it refers to.',
    );
  });
});
