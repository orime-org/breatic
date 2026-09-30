// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the panel prints beside the star, for each way an estimate bounds the
 * charge (#2156): the number itself, a lower bound while a source's length is
 * unknown, an upper bound when a reused source may skip a step, and a price
 * per thousand characters while a text-priced model has no text.
 */

import { describe, it, expect } from 'vitest';

import { creditEstimateText } from '@web/spaces/canvas/generate/credit-estimate-text';

/**
 * Stands in for `t`, echoing the key and its credits.
 * @param key - The locale key.
 * @param params - Its ICU params.
 * @returns A string naming both.
 */
function t(key: string, params?: Record<string, unknown>): string {
  return `${key}:${String(params?.credits)}`;
}

describe('creditEstimateText', () => {
  // A run is charged in part-credits, so the figure keeps them: at most two
  // decimals, as every other credit amount on the site is shown.
  it('prints an exact estimate as the number, part-credits kept', () => {
    expect(creditEstimateText({ credits: 47.5, bound: 'exact' }, t)).toBe('47.5');
  });

  it('shows at most two decimals', () => {
    expect(creditEstimateText({ credits: 3.456, bound: 'at_least' }, t)).toBe('≥ 3.46');
  });

  it('marks a lower bound', () => {
    expect(creditEstimateText({ credits: 5, bound: 'at_least' }, t)).toBe('≥ 5');
  });

  it('marks an upper bound', () => {
    expect(creditEstimateText({ credits: 772.5, bound: 'at_most' }, t)).toBe('≤ 772.5');
  });

  it('prices per thousand characters through the locale', () => {
    expect(creditEstimateText({ credits: 10.25, bound: 'per_thousand_chars' }, t)).toBe(
      'canvas.generatePanel.creditsPerThousandChars:10.25',
    );
  });
});
