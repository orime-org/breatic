// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { CreditEstimate } from '@breatic/shared/pricing';

/** The shape of `t` this reads. */
type Translate = (key: string, params?: Record<string, string | number | Date>) => string;

/**
 * What the panel prints beside the star for one estimate.
 *
 * Part-credits round up: a fraction of a credit is not a thing that gets
 * charged.
 * @param estimate - The run's estimate.
 * @param t - The translation function.
 * @returns The number, marked with how it bounds the charge.
 */
export function creditEstimateText(estimate: CreditEstimate, t: Translate): string {
  const credits = Math.ceil(estimate.credits);
  switch (estimate.bound) {
    case 'exact':
      return String(credits);
    case 'at_least':
      return `≥ ${credits}`;
    case 'at_most':
      return `≤ ${credits}`;
    case 'per_thousand_chars':
      return t('canvas.generatePanel.creditsPerThousandChars', { credits });
  }
}
