// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { CreditWallet } from '@web/pages/studio/container/container-types';
import { expiringDays } from '@web/pages/studio/container/credit-util';
import { CreditLotBadge } from '@web/pages/studio/shared/badges';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface CreditsTabProps {
  wallet: CreditWallet;
  /** The viewer's studio role — Members / guests (`null`) cannot top up or refund (DD §3.6). */
  studioRole: StudioRole | null;
  /** Epoch ms for gift-expiry math; injected so tests are deterministic. */
  now?: number;
}

/**
 * The Credits tab (spec §3.6) — the studio wallet: the cached total balance
 * (read directly, never recomputed — spec §4 invariant 4), the spend-order
 * hint + 3-step visual, the paid + gift lot cards, and the recent-activity
 * ledger. Gift cards and refunds appear only when present / permitted: team
 * studios have no gift lots, and only Admins see top-up / refund actions
 * (DD §3.6). Gift lots within their expiry window show a warning badge.
 * @param props the wallet, the viewer's studio role and the current time.
 * @param props.wallet the studio credit wallet.
 * @param props.studioRole the viewer's studio role.
 * @param props.now the current time in epoch milliseconds.
 * @returns the Credits tab content.
 */
export function CreditsTab({
  wallet,
  studioRole,
  now = Date.now(),
}: CreditsTabProps): React.JSX.Element {
  const t = useTranslation();
  const isAdmin = studioRole === 'admin';
  const hasGift = wallet.giftLots.length > 0;
  return (
    <div className='flex max-w-3xl flex-col gap-6'>
      <div>
        <p className='text-xs uppercase tracking-wide text-muted-foreground'>
          {t('studio.container.credits.balance')}
        </p>
        <p
          data-testid='wallet-balance'
          className='text-3xl font-semibold text-foreground'
        >
          {wallet.balanceCached.toLocaleString()}
        </p>
        <p className='mt-1 text-xs text-muted-foreground'>
          {t('studio.container.credits.hint')}
        </p>
      </div>

      {isAdmin ? (
        <div>
          <button
            type='button'
            className='rounded-chrome bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90'
          >
            {t('studio.container.credits.topup')}
          </button>
        </div>
      ) : null}

      <div className='grid gap-4 sm:grid-cols-2'>
        <section className='rounded-content-md border border-border p-4'>
          <h3 className='mb-3 text-sm font-semibold'>
            {t('studio.container.credits.paidTitle')}
          </h3>
          <ul className='flex flex-col gap-3'>
            {wallet.paidLots.map((lot) => (
              <li key={lot.id} className='flex flex-col items-start gap-1'>
                <CreditLotBadge source='paid' />
                <p className='text-sm text-muted-foreground'>
                  {t('studio.container.credits.remaining', {
                    amount: lot.amountRemaining.toLocaleString(),
                  })}
                </p>
                {isAdmin && lot.isRefundable && lot.amountRemaining > 0 ? (
                  <button
                    type='button'
                    className='text-xs text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  >
                    {t('studio.container.credits.refund')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {hasGift ? (
          <section className='rounded-content-md border border-border p-4'>
            <h3 className='mb-3 text-sm font-semibold'>
              {t('studio.container.credits.giftTitle')}
            </h3>
            <ul className='flex flex-col gap-3'>
              {wallet.giftLots.map((lot) => {
                const days = expiringDays(lot.expiresAt, now);
                return (
                  <li key={lot.id} className='flex flex-col items-start gap-1'>
                    <CreditLotBadge
                      source={lot.source}
                      expiringDays={days ?? undefined}
                    />
                    <p className='text-sm text-muted-foreground'>
                      {t('studio.container.credits.remaining', {
                        amount: lot.amountRemaining.toLocaleString(),
                      })}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>

      {/* Spend order (locked mock .order): label + numbered circle steps. */}
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2 rounded-content-md border border-border bg-elevated px-3 py-2.5'>
        <span className='whitespace-nowrap border-r border-border pr-3 text-xs font-bold text-muted-foreground'>
          {t('studio.container.credits.orderTitle')}
        </span>
        {[
          t('studio.container.credits.orderStep1'),
          t('studio.container.credits.orderStep2'),
          t('studio.container.credits.orderStep3'),
        ].map((label, index) => (
          <React.Fragment key={label}>
            {index > 0 ? (
              <span aria-hidden='true' className='text-neutral-400'>
                →
              </span>
            ) : null}
            <span className='flex items-center gap-1.5'>
              <span className='flex h-[18px] w-[18px] items-center justify-center rounded-full bg-muted text-[11px] font-bold text-foreground'>
                {index + 1}
              </span>
              <span className='whitespace-nowrap text-xs font-semibold'>
                {label}
              </span>
            </span>
          </React.Fragment>
        ))}
      </div>

      <div>
        <h3 className='mb-2 text-sm font-semibold'>
          {t('studio.container.credits.activityTitle')}
        </h3>
        <table className='w-full text-left text-sm'>
          <thead className='text-xs text-muted-foreground'>
            <tr>
              <th className='py-1 font-medium'>
                {t('studio.container.credits.colType')}
              </th>
              <th className='py-1 font-medium'>
                {t('studio.container.credits.colSource')}
              </th>
              <th className='py-1 text-right font-medium'>
                {t('studio.container.credits.colAmount')}
              </th>
              <th className='py-1 text-right font-medium'>
                {t('studio.container.credits.colTime')}
              </th>
            </tr>
          </thead>
          <tbody>
            {wallet.ledger.map((entry) => (
              <tr key={entry.id} className='border-t border-border'>
                <td className='py-1.5'>
                  {t(`studio.container.credits.ledgerType.${entry.type}`)}
                </td>
                <td className='py-1.5 text-muted-foreground'>
                  {entry.description}
                </td>
                <td
                  className={`py-1.5 text-right tabular-nums ${
                    entry.amount > 0
                      ? 'text-status-success-foreground'
                      : 'text-foreground'
                  }`}
                >
                  {entry.amount > 0 ? '+' : ''}
                  {entry.amount.toLocaleString()}
                </td>
                <td className='py-1.5 text-right text-muted-foreground'>
                  {entry.createdAt.slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
