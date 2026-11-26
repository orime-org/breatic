// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { setLocale, t, type CreditDecimal, type CreditLotView, type Locale, type PurchaseRow } from '@breatic/shared';
import { PurchasesSection } from '@web/features/credits/sections/PurchasesSection';
import { AssignSection } from '@web/features/credits/sections/AssignSection';
import { RefundsSection } from '@web/features/credits/sections/RefundsSection';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { creditSourceLabelKey } from '@web/features/credits/credit-source-label';

const history = vi.fn();
const fetchCreditLots = vi.fn();
const fetchStudioCredits = vi.fn();
const designateCreditLot = vi.fn();
const requestCreditLotRefund = vi.fn();
const listUserStudios = vi.fn();

vi.mock('@web/data/api/payment', () => ({ paymentApi: {
  history: (...args: unknown[]) => history(...args),
  resendConfirmation: vi.fn(),
  tiers: async () => ({ packs: [], confirmTimeoutMs: 15000, refundLines: [], consentText: '' }),
} }));
vi.mock('@web/data/api/credits', () => ({
  fetchCreditLots: (...args: unknown[]) => fetchCreditLots(...args),
  fetchStudioCredits: (...args: unknown[]) => fetchStudioCredits(...args),
  designateCreditLot: (...args: unknown[]) => designateCreditLot(...args),
  requestCreditLotRefund: (...args: unknown[]) => requestCreditLotRefund(...args),
}));
vi.mock('@web/data/api/studios', () => ({ studiosApi: { listUserStudios: () => listUserStudios() } }));
vi.mock('@web/lib/use-scrolled-to-end', () => ({ useScrolledToEnd: () => ({ scrollerRef: () => {}, sentinelRef: () => {} }) }));

const clients: QueryClient[] = [];

/**
 * Mount the actual credit surface with its query and route context.
 * @param child - The actual component under test.
 */
function mount(child: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><MemoryRouter>{child}</MemoryRouter></QueryClientProvider>);
}

/**
 * Supply a complete enterprise lot with its immutable original contract.
 * @param over - Actual lot fields to replace.
 * @returns The API-shaped lot.
 */
function enterpriseLot(over: Partial<CreditLotView> = {}): CreditLotView {
  return {
    id: 'enterprise-lot', sourceKind: 'enterprise', giftOrigin: null, contractNumber: 'CONTRACT-174',
    purchasedCredits: '100.000000' as CreditDecimal, remainingCredits: '100.000000' as CreditDecimal,
    designatedStudioId: null, designatedStudioName: null, designated: false, paidCents: null,
    currency: null, lifecycle: 'active', refundAttempts: 0, everSpent: false, everRestored: false,
    createdAt: new Date().toISOString(), ...over,
  };
}

/**
 * Supply an acquired source independently of a Stripe payment.
 * @param kind - The actual source kind.
 * @returns The exact-decimal purchase history row.
 */
function acquisition(kind: 'enterprise' | 'compensation'): PurchaseRow {
  return {
    rowId: `${kind}-source`, sourceKind: kind, giftOrigin: null,
    contractNumber: kind === 'enterprise' ? 'CONTRACT-174' : null, paymentId: null,
    amountCents: null, totalCents: null, taxCents: null, currency: 'usd',
    creditsGranted: '100.000000' as CreditDecimal, remainingCredits: '100.000000' as CreditDecimal,
    lifecycle: 'active', designatedStudioId: null, designatedStudioName: null,
    status: null, canResend: false, createdAt: '2026-11-19T00:00:00.000Z',
  };
}

const languages: readonly { locale: Locale; gift: string; compensation: string; enterprise: string; offline: string }[] = [
  { locale: 'en', gift: 'Gift credits', compensation: 'Compensation', enterprise: 'Enterprise credits', offline: 'Contact your contract representative for enterprise credit refunds.' },
  { locale: 'zh-CN', gift: '赠送积分', compensation: '补偿', enterprise: '企业积分', offline: '企业积分退款请联系合同负责人。' },
  { locale: 'zh-TW', gift: '贈送點數', compensation: '補償', enterprise: '企業點數', offline: '企業點數退款請聯絡合約負責人。' },
  { locale: 'ja', gift: 'ギフトクレジット', compensation: '補償', enterprise: '企業クレジット', offline: '企業クレジットの返金は契約担当者にお問い合わせください。' },
  { locale: 'ko', gift: '선물 크레딧', compensation: '보상', enterprise: '기업 크레딧', offline: '기업 크레딧 환불은 계약 담당자에게 문의하세요.' },
];

const refundHeadings: readonly { locale: Locale; online: string; general: string }[] = [
  { locale: 'en', online: 'Online credit purchase refund rules', general: 'Refund rule' },
  { locale: 'zh-CN', online: '线上购买积分退款规则', general: '退款规则' },
  { locale: 'zh-TW', online: '線上購買點數退款規則', general: '退款規則' },
  { locale: 'ja', online: 'オンライン購入クレジットの返金ルール', general: '返金ルール' },
  { locale: 'ko', online: '온라인 구매 크레딧 환불 규정', general: '환불 규정' },
];

beforeEach(() => {
  vi.clearAllMocks();
  setLocale('en');
  history.mockResolvedValue({ items: [acquisition('compensation'), acquisition('enterprise')], nextCursor: null });
  fetchCreditLots.mockResolvedValue({ items: [enterpriseLot()], nextCursor: null });
  listUserStudios.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setLocale('en');
});

describe('enterprise and gift provenance in the actual product surfaces', () => {
  it('classifies recorded registration and compensation without guessing missing gift origin', () => {
    expect(creditSourceLabelKey({ sourceKind: 'gift', giftOrigin: 'registration' })).toBe('credits.source.trial');
    expect(creditSourceLabelKey({ sourceKind: 'gift', giftOrigin: 'operator' })).toBe('credits.source.gift');
    expect(creditSourceLabelKey({ sourceKind: 'gift', giftOrigin: null })).toBe('credits.source.gift');
    expect(creditSourceLabelKey({ sourceKind: 'compensation' })).toBe('credits.source.gift');
  });

  it.each(languages)('shows compensation detail and the original enterprise contract in $locale', async ({ locale, gift, compensation, enterprise }) => {
    setLocale(locale);
    mount(<PurchasesSection userId='account-174' charging />);
    const rows = await screen.findAllByTestId('purchase-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(gift);
    expect(rows[0]).toHaveTextContent(compensation);
    expect(rows[1]).toHaveTextContent(enterprise);
    expect(rows[1]).toHaveTextContent('CONTRACT-174');
    expect(rows[1]).not.toHaveTextContent('$');
    expect(screen.queryAllByTestId('purchase-status')).toHaveLength(0);
    expect(screen.queryAllByTestId('resend-confirmation')).toHaveLength(0);
  });

  it('keeps the actual charged amount on an online payment', async () => {
    history.mockResolvedValue({ items: [{ ...acquisition('enterprise'), sourceKind: 'payment', contractNumber: null, paymentId: 'payment-174', amountCents: 2000, totalCents: 2240, taxCents: 240, status: 'completed' }], nextCursor: null });
    mount(<PurchasesSection userId='account-174' charging />);
    expect(await screen.findByTestId('purchase-row')).toHaveTextContent('$22.40');
  });

  it.each(languages)('shows the enterprise offline refund action in $locale', async ({ locale, enterprise, offline }) => {
    setLocale(locale);
    mount(<RefundsSection userId='account-174' charging selling />);
    expect(await screen.findByTestId('lot-remaining')).toHaveTextContent('100');
    expect(screen.getByText(offline)).toBeInTheDocument();
    expect(document.body).toHaveTextContent(enterprise);
    expect(document.body).toHaveTextContent('CONTRACT-174');
    expect(requestCreditLotRefund).not.toHaveBeenCalled();
  });

  it.each(refundHeadings)('scopes refund rules to online credit purchases in $locale', async ({ locale, online, general }) => {
    setLocale(locale);
    mount(<RefundsSection userId='account-174' charging selling />);
    expect(await screen.findByRole('heading', { level: 3, name: online })).toBeInTheDocument();
    expect(t('credits.refundTitle')).toBe(general);
  });

  it('shows the enterprise contract while assigning personal, team and unassigned destinations', async () => {
    const user = userEvent.setup();
    let destination: string | null = null;
    listUserStudios.mockResolvedValue([{ id: 'personal-174', name: 'Personal Studio 174', type: 'personal', myStudioRole: 'admin' }, { id: 'team-174', name: 'Team Studio 174', type: 'team', myStudioRole: 'admin' }]);
    fetchCreditLots.mockImplementation(async () => ({ items: [enterpriseLot({ designatedStudioId: destination, designated: destination !== null, designatedStudioName: destination === 'personal-174' ? 'Personal Studio 174' : destination === 'team-174' ? 'Team Studio 174' : null })], nextCursor: null }));
    designateCreditLot.mockImplementation(async (_lot: string, studio: string | null) => { destination = studio; });
    mount(<AssignSection userId='account-174' charging />);
    const picker = await screen.findByRole('combobox');
    expect(document.body).toHaveTextContent('CONTRACT-174');
    for (const [name, value] of [['Personal Studio 174', 'personal-174'], ['Team Studio 174', 'team-174'], ['Unassigned', null]] as const) {
      await user.click(picker);
      await user.click(await screen.findByRole('option', { name }));
      await waitFor(() => expect(designateCreditLot).toHaveBeenLastCalledWith('enterprise-lot', value));
      await waitFor(() => expect(picker).toHaveTextContent(name));
    }
    expect(designateCreditLot).toHaveBeenCalledTimes(3);
  });

  it('shows the actual enterprise provenance on a Studio lot', async () => {
    fetchStudioCredits.mockResolvedValue({ spendable: '100.000000', debt: '0.000000', lots: [{ id: 'studio-enterprise-174', sourceKind: 'enterprise', giftOrigin: null, contractNumber: 'CONTRACT-174', purchasedCredits: '100.000000', remainingCredits: '100.000000', buyerName: 'Enterprise buyer', createdAt: '2026-11-19T00:00:00.000Z' }], ledger: { items: [], nextCursor: null } });
    mount(<CreditsTab slug='enterprise-studio-174' />);
    const lot = await screen.findByTestId('studio-lot-studio-enterprise-174');
    expect(lot).toHaveTextContent('Enterprise credits');
    expect(lot).toHaveTextContent('CONTRACT-174');
    expect(lot).toHaveTextContent('Enterprise buyer');
  });
});
