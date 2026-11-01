// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as shared from '@breatic/shared';
import type { Locale, PurchaseRow } from '@breatic/shared';
import { PurchasesSection } from '@web/features/credits/sections/PurchasesSection';

const history = vi.fn();
vi.mock('@web/data/api/payment', () => ({ paymentApi: { history: (...args: unknown[]) => history(...args), resendConfirmation: vi.fn() } }));
vi.mock('@web/lib/use-scrolled-to-end', () => ({ useScrolledToEnd: () => ({ scrollerRef: () => {}, sentinelRef: () => {} }) }));

afterEach(() => { cleanup(); shared.setLocale('en'); });

/**
 * Supply a complete acquired gift row independently of production query code.
 * @param origin - The immutable gift receipt origin.
 * @returns A full exact-decimal history row.
 */
function giftRow(origin: string): Record<string, unknown> {
  return {
    rowId: `gift-${origin}`, sourceKind: 'gift', giftOrigin: origin, paymentId: null,
    amountCents: null, totalCents: null, taxCents: null, currency: 'usd',
    creditsGranted: '100.000000', remainingCredits: '80.000000', lifecycle: 'active',
    designatedStudioId: 'personal-1', designatedStudioName: 'Personal Studio', status: null,
    createdAt: '2026-10-31T00:00:00.000Z', canResend: false,
  };
}

const lot = {
  id: 'gift-lot', sourceKind: 'gift', purchasedCredits: '100.000000', remainingCredits: '80.000000',
  designatedStudioId: 'personal-1', designatedStudioName: 'Personal Studio', designated: true,
  paidCents: null, currency: null, lifecycle: 'active', refundAttempts: 0,
  everSpent: false, everRestored: false, createdAt: '2026-10-31T00:00:00.000Z',
};

interface ViewSchema { parse: (input: unknown) => Record<string, unknown>; safeParse: (input: unknown) => { success: boolean } }

/**
 * Resolve the shared parser used by the real product API client.
 * @param name - The existing public view contract.
 * @returns Its runtime parser.
 */
function parser(name: 'purchaseRowSchema' | 'creditLotViewSchema'): ViewSchema {
  const value = (shared as unknown as Record<string, ViewSchema>)[name];
  expect(typeof value?.parse).toBe('function');
  return value!;
}

describe('gift receipt origin at the product boundary', () => {
  it.each(['registration', 'operator'])('B16 preserves %s in acquisition and lot runtime views', (origin) => {
    expect(parser('purchaseRowSchema').parse(giftRow(origin))).toMatchObject({ giftOrigin: origin });
    expect(parser('creditLotViewSchema').parse({ ...lot, giftOrigin: origin })).toMatchObject({ giftOrigin: origin });
  });

  it.each(['unknown', true])('B16 rejects invalid gift origin %s before a view is returned', (giftOrigin) => {
    expect(parser('purchaseRowSchema').safeParse({ ...giftRow('operator'), giftOrigin }).success).toBe(false);
    expect(parser('creditLotViewSchema').safeParse({ ...lot, giftOrigin }).success).toBe(false);
  });
});

const labels: readonly { locale: Locale; registration: string; operator: string }[] = [
  { locale: 'en', registration: 'Trial credits', operator: 'Gift credits' },
  { locale: 'zh-CN', registration: '体验积分', operator: '赠送积分' },
  { locale: 'zh-TW', registration: '體驗點數', operator: '贈送點數' },
  { locale: 'ja', registration: '体験クレジット', operator: 'ギフトクレジット' },
  { locale: 'ko', registration: '체험 크레딧', operator: '선물 크레딧' },
];

describe('gift receipt origin in the real acquisition list', () => {
  it.each(labels)('B16 distinguishes registration and operator gifts in $locale', async ({ locale, registration, operator }) => {
    shared.setLocale(locale);
    history.mockResolvedValue({ items: [giftRow('registration'), giftRow('operator')] as unknown as PurchaseRow[], nextCursor: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    try {
      render(<QueryClientProvider client={client}><PurchasesSection userId='account-1' billing /></QueryClientProvider>);
      const rows = await screen.findAllByTestId('purchase-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent(registration);
      expect(rows[1]).toHaveTextContent(operator);
      expect(rows[1]).not.toHaveTextContent(registration);
    } finally { cleanup(); client.clear(); }
  });
});
