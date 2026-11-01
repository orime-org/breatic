// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { CreditLotView } from '@breatic/shared';

/**
 * Name the immutable receipt origin on every account credit list.
 * @param source - The source kind and, for gifts, its receipt provenance.
 * @returns The locale key describing how the credits arrived.
 */
export function creditSourceLabelKey(source: Pick<CreditLotView, 'sourceKind' | 'giftOrigin'>): string {
  return source.sourceKind === 'gift' && source.giftOrigin === 'operator'
    ? 'credits.source.operatorGift'
    : `credits.source.${source.sourceKind}`;
}
