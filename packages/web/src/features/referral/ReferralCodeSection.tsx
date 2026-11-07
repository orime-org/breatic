// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { REFERRAL_CODE_INPUT_MAX } from '@breatic/shared';
import { useQueryClient } from '@tanstack/react-query';
import { referralApi, type AccountReferral } from '@web/data/api/referral';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { FieldError } from '@web/components/FieldError';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useMountedRef } from '@web/lib/use-mounted-ref';
import { carriedReferralCode, forgetCarriedReferralCode, forgetRefusedReferralCode } from '@web/lib/referral-carry';
import { membershipQueryKey } from '@web/features/membership/membership-query';
import { SectionHeading } from '@web/features/membership/SectionHeading';
import { referralQueryKey, useAccountReferral, zheOf } from '@web/features/referral/referral-query';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';
import { useCurrentUserStore } from '@web/stores/current-user';

const BIND_INTENT = 'referral:bind';
/** Refusals about the account rather than the code: the section is read again. */
const ACCOUNT_REFUSALS = new Set(['already_bound', 'already_paid', 'not_eligible']);

/**
 * The membership panel's "Referral code" section (inner#1868 §10, tables 12.9 and 12.10).
 *
 * The section follows the cached view: while there is data it draws the data,
 * even when a background read fails; the skeleton and the error line are for
 * the first read only. A 404 (payments off) draws nothing.
 * @returns The section, or null when there is nothing to show.
 */
export function ReferralCodeSection(): React.JSX.Element | null {
  const t = useTranslation();
  const query = useAccountReferral();
  const { data, isPending, isLoadingError, refetch } = query;
  const retry = React.useCallback((): void => {
    void refetch();
  }, [refetch]);

  if (data !== undefined) {
    if (data === null) return null;
    if (data.canBind) return <BindForm view={data} />;
    if (data.binding?.discountPending) return <BoundCode view={data} />;
    return null;
  }
  return (
    <section className='flex flex-col gap-2'>
      <SectionHeading>{t('membership.referral.heading')}</SectionHeading>
      {isPending || !isLoadingError ? (
        <Skeleton data-testid='referral-code-loading' className='h-14 w-full rounded-content-sm' />
      ) : (
        <div className='flex items-center justify-between rounded-content-sm border border-border px-4 py-3 text-sm'>
          <span className='text-status-error'>{t('membership.referral.loadFailed')}</span>
          <Button type='button' variant='outline' size='sm' onClick={retry}>
            {t('membership.referral.retry')}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The bound code and its first-period discount.
 * @param props - The view.
 * @param props.view - The account's referral view.
 * @returns The section.
 */
function BoundCode({ view }: { view: AccountReferral }): React.JSX.Element {
  const t = useTranslation();
  const percent = view.firstPeriodDiscountPercent;
  const figure = { percent, zhe: zheOf(percent) };
  return (
    <section className='flex flex-col gap-2'>
      <SectionHeading>{t('membership.referral.heading')}</SectionHeading>
      <div className='flex items-center justify-between rounded-content-sm border border-border px-4 py-3'>
        <div className='flex flex-col gap-0.5'>
          <span className='text-sm'>{t('membership.referral.bound', { code: view.binding?.code ?? '' })}</span>
          <span className='text-xs text-muted-foreground'>{t('membership.referral.boundDiscount', figure)}</span>
        </div>
        <span className='rounded-md bg-accent px-2 py-0.5 text-xs font-medium'>{t('membership.referral.badge', figure)}</span>
      </div>
    </section>
  );
}

/**
 * The backfill field for an account that may still add a code.
 * @param props - The view.
 * @param props.view - The account's referral view.
 * @returns The section.
 */
function BindForm({ view }: { view: AccountReferral }): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  const [value, setValue] = React.useState(() => carriedReferralCode() ?? '');
  const [error, setError] = React.useState<string | null>(null);
  // A waiting press outlives this form when the panel closes: the code it sends
  // is what the form shows, and its answer goes to a toast once the form is gone.
  const running = useRunning(BIND_INTENT);
  const pressing = running !== undefined;
  const shown = typeof running === 'string' ? running : value;
  const mounted = useMountedRef();
  const percent = view.firstPeriodDiscountPercent;
  const figure = React.useMemo(() => ({ percent, zhe: zheOf(percent) }), [percent]);

  const bind = React.useCallback((): void => {
    const code = value.trim();
    if (code === '') {
      setError(t('membership.referral.required'));
      return;
    }
    void runOnce(BIND_INTENT, {
      scope: 'referral',
      meta: code,
      prepare: () => code,
      send: (key, body: string) => referralApi.bind(body, key),
      onDone: (answer: AccountReferral): undefined => {
        client.setQueryData(referralQueryKey(userId), answer);
        // Binding may have expired an open checkout; the membership read follows.
        void client.invalidateQueries({ queryKey: membershipQueryKey(userId) });
        forgetCarriedReferralCode();
        toast.success(t('membership.referral.added', figure));
        return undefined;
      },
      onFailure: (err) => {
        if (err instanceof ApiException && err.status === 422 && err.reason === 'invalid_code') {
          forgetRefusedReferralCode(code);
          if (mounted.current) setError(err.message);
          else toast.error(err.message);
          return;
        }
        toast.error(err instanceof ApiException ? err.message : t('membership.referral.loadFailed'));
        if (err instanceof ApiException && err.reason !== undefined && ACCOUNT_REFUSALS.has(err.reason)) {
          void client.invalidateQueries({ queryKey: referralQueryKey(userId) });
        }
      },
    });
  }, [value, t, client, userId, figure, mounted]);

  return (
    <section className='flex flex-col gap-2'>
      <SectionHeading>{t('membership.referral.heading')}</SectionHeading>
      <p className='text-sm text-muted-foreground'>{t('membership.referral.intro', figure)}</p>
      <div className='flex items-start gap-2'>
        <div className='flex w-64 flex-col gap-1'>
          <Input
            aria-label={t('membership.referral.heading')}
            autoComplete='off'
            value={shown}
            placeholder={t('membership.referral.placeholder')}
            maxLength={REFERRAL_CODE_INPUT_MAX}
            readOnly={pressing}
            aria-invalid={!!error || undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
        <Button type='button' variant='outline' loading={pressing} onClick={bind}>
          {t('membership.referral.add')}
        </Button>
      </div>
    </section>
  );
}
