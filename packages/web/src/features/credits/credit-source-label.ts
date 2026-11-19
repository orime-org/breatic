// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CreditLotView, t } from '@breatic/shared';

type CreditSource = Pick<CreditLotView, 'sourceKind' | 'giftOrigin' | 'contractNumber'>;

/**
 * Name the immutable receipt origin on every account credit list.
 * @param source - The source kind and, for gifts, its receipt provenance.
 * @returns The locale key describing how the credits arrived.
 */
export function creditSourceLabelKey(source: CreditSource): string {
  if (source.sourceKind === 'gift') return source.giftOrigin === 'registration' ? 'credits.source.trial' : 'credits.source.gift';
  return source.sourceKind === 'compensation' ? 'credits.source.gift' : `credits.source.${source.sourceKind}`;
}

/**
 * Preserve the receipt subtype independently of the displayed credit category.
 * @param source - The immutable funding receipt.
 * @returns Its subtype key, when recorded.
 */
export function creditSourceDetailKey(source: CreditSource): string | null {
  if (source.sourceKind === 'gift') {
    if (source.giftOrigin === 'registration') return 'credits.sourceDetail.registration';
    if (source.giftOrigin === 'operator') return 'credits.sourceDetail.operator';
    return null;
  }
  if (source.sourceKind === 'compensation') return 'credits.sourceDetail.compensation';
  if (source.sourceKind === 'enterprise') return 'credits.sourceDetail.enterprise';
  return null;
}

/**
 * Show the original category, subtype and enterprise contract on credit surfaces.
 * @param source - The immutable funding receipt.
 * @param translate - The active locale translator.
 * @returns The localized source line.
 */
export function creditSourceText(source: CreditSource, translate: typeof t): string {
  const parts = [translate(creditSourceLabelKey(source))];
  const detailKey = creditSourceDetailKey(source);
  if (detailKey !== null) parts.push(translate(detailKey));
  if (source.sourceKind === 'enterprise' && source.contractNumber) parts.push(translate('credits.contractReference', { contract: source.contractNumber }));
  return parts.join(' · ');
}
