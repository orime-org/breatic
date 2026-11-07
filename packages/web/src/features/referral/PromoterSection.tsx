// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Copy } from 'lucide-react';
import { getLocale } from '@breatic/shared';
import type { AccountReferral } from '@web/data/api/referral';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { SectionHeading } from '@web/features/membership/SectionHeading';
import { PromoterApplyDialog } from '@web/features/referral/PromoterApplyDialog';
import { useAccountReferral, zheOf } from '@web/features/referral/referral-query';

/**
 * The membership panel's "Promoter program" section (inner#1868 §10, table 12.11).
 *
 * Like the referral code section it draws cached data even when a background
 * read fails, and draws nothing while payments are off.
 * @returns The section, or null when there is nothing to show.
 */
export function PromoterSection(): React.JSX.Element | null {
  const t = useTranslation();
  const { data, isPending, isLoadingError, refetch } = useAccountReferral();
  const retry = React.useCallback((): void => {
    void refetch();
  }, [refetch]);

  let body: React.ReactNode;
  if (data === null) return null;
  if (data !== undefined) body = <PromoterBody view={data} />;
  else if (isPending || !isLoadingError) body = <Skeleton data-testid='promoter-loading' className='h-16 w-full rounded-content-sm' />;
  else {
    body = (
      <div className='flex items-center justify-between rounded-content-sm border border-border px-4 py-3 text-sm'>
        <span className='text-status-error'>{t('membership.referral.loadFailed')}</span>
        <Button type='button' variant='outline' size='sm' onClick={retry}>{t('membership.referral.retry')}</Button>
      </div>
    );
  }
  return (
    <section className='flex flex-col gap-2'>
      <SectionHeading>{t('membership.promoter.heading')}</SectionHeading>
      {body}
    </section>
  );
}

/**
 * Copies text and says so.
 * @param text - What to copy.
 * @param done - The confirmation.
 */
function copy(text: string, done: string): void {
  void navigator.clipboard?.writeText(text).then(() => toast.success(done));
}

/**
 * What a promoter or applicant sees, by state.
 * @param props - The view.
 * @param props.view - The account's referral view.
 * @returns The section's body.
 */
function PromoterBody({ view }: { view: AccountReferral }): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const figure = React.useMemo(
    () => ({ percent: view.firstPeriodDiscountPercent, zhe: zheOf(view.firstPeriodDiscountPercent) }),
    [view.firstPeriodDiscountPercent],
  );
  const { promoter, program } = view;
  const card = 'flex items-center justify-between gap-4 rounded-content-sm border border-border px-4 py-3';
  const dialog = <PromoterApplyDialog open={open} onOpenChange={setOpen} termsVersion={program.termsVersion} />;

  if (promoter.state === 'approved') {
    const off = promoter.codeStatus !== 'active';
    return (
      <div className='flex flex-col gap-3 rounded-content-sm border border-border px-4 py-3'>
        <div className='flex items-center justify-between'>
          <span className='text-sm'>{t('membership.promoter.yourCode')}</span>
          {off ? <span className='rounded-md bg-accent px-2 py-0.5 text-xs text-muted-foreground'>{t('membership.promoter.disabled')}</span> : null}
        </div>
        <div className='flex items-center gap-2'>
          <span className={off ? 'text-lg font-semibold tracking-wide text-muted-foreground line-through' : 'text-lg font-semibold tracking-wide'}>
            {promoter.code}
          </span>
          {off ? null : (
            <Button type='button' variant='ghost' size='sm' className='gap-1.5' icon={<Copy className='h-3.5 w-3.5' />} onClick={() => copy(promoter.code, t('membership.promoter.copied'))}>
              {t('membership.promoter.copyCode')}
            </Button>
          )}
        </div>
        {off ? (
          <p className='text-xs text-muted-foreground'>
            {promoter.codeStatus === 'removed' ? t('membership.promoter.removedDetail') : t('membership.promoter.disabledDetail')}
          </p>
        ) : (
          <>
            <div className='flex items-center gap-2'>
              <Input readOnly value={promoter.link} aria-label={t('membership.promoter.copyLink')} className='text-muted-foreground' />
              <Button type='button' variant='outline' className='gap-1.5' icon={<Copy className='h-3.5 w-3.5' />} onClick={() => copy(promoter.link, t('membership.promoter.copied'))}>
                {t('membership.promoter.copyLink')}
              </Button>
            </div>
            <p className='text-xs text-muted-foreground'>{t('membership.promoter.shareHint', figure)}</p>
          </>
        )}
      </div>
    );
  }
  if (promoter.state === 'pending') {
    const date = new Date(promoter.submittedAt).toLocaleDateString(getLocale());
    return (
      <div className={card}>
        <div className='flex flex-col gap-0.5'>
          <span className='text-sm'>{t('membership.promoter.pending')}</span>
          <span className='text-xs text-muted-foreground'>{t('membership.promoter.pendingDetail', { date })}</span>
        </div>
        <span className='rounded-md bg-accent px-2 py-0.5 text-xs'>{t('membership.promoter.pendingBadge')}</span>
      </div>
    );
  }
  if (promoter.state === 'rejected') {
    return (
      <div className={card}>
        <div className='flex flex-col gap-0.5'>
          <span className='text-sm'>{t('membership.promoter.rejected')}</span>
          {promoter.note ? <span className='text-xs text-muted-foreground'>{t('membership.promoter.rejectedNote', { note: promoter.note })}</span> : null}
        </div>
        {program.open ? <Button type='button' variant='outline' onClick={() => setOpen(true)}>{t('membership.promoter.applyAgain')}</Button> : null}
        {dialog}
      </div>
    );
  }
  if (!program.open) {
    return <div className={card}><span className='text-sm'>{t('membership.promoter.closed')}</span></div>;
  }
  return (
    <div className={card}>
      <div className='flex flex-col gap-0.5'>
        <span className='text-sm'>{t('membership.promoter.pitch')}</span>
        <span className='text-xs text-muted-foreground'>{t('membership.promoter.pitchDetail', figure)}</span>
      </div>
      <Button type='button' variant='outline' onClick={() => setOpen(true)}>{t('membership.promoter.apply')}</Button>
      {dialog}
    </div>
  );
}
