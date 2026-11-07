// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { getLocale } from '@breatic/shared';
import { referralApi, type AccountReferral, type PromoterApplicationForm } from '@web/data/api/referral';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Textarea } from '@web/components/ui/textarea';
import { FieldError } from '@web/components/FieldError';
import { useTranslation } from '@web/i18n/use-translation';
import { PROMOTER_TERMS_URL } from '@web/lib/official-home';
import { toast } from '@web/lib/toast';
import { countryOptions } from '@web/features/referral/countries';
import { referralQueryKey } from '@web/features/referral/referral-query';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';
import { useCurrentUserStore } from '@web/stores/current-user';

const APPLY_INTENT = 'referral:apply';
const MAX_CHANNELS = 10;

interface FieldErrors {
  country?: string;
  channels?: string;
  plan?: string;
  agree?: string;
}

/**
 * The application form to become a promoter (inner#1868 §10, table 12.12).
 * @param props - Whether it is open, how it closes, and the terms version agreed to.
 * @param props.open - The dialog is open.
 * @param props.onOpenChange - Opens or closes it.
 * @param props.termsVersion - The promoter terms version the panel read.
 * @returns The dialog.
 */
export function PromoterApplyDialog({
  open,
  onOpenChange,
  termsVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  termsVersion: string;
}): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  const [country, setCountry] = React.useState('');
  const [channels, setChannels] = React.useState<string[]>(['']);
  const [plan, setPlan] = React.useState('');
  const [agreed, setAgreed] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [termsNotice, setTermsNotice] = React.useState(false);
  const pressing = useRunning(APPLY_INTENT) !== undefined;
  const countries = React.useMemo(() => countryOptions(getLocale()), []);

  const submit = React.useCallback((): void => {
    const filled = channels.map((c) => c.trim()).filter((c) => c !== '');
    const next: FieldErrors = {};
    if (country === '') next.country = t('membership.promoter.countryRequired');
    if (filled.length === 0) next.channels = t('membership.promoter.channelsRequired');
    if (plan.trim() === '') next.plan = t('membership.promoter.planRequired');
    if (!agreed) next.agree = t('membership.promoter.agreeRequired');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void runOnce(APPLY_INTENT, {
      scope: 'referral',
      prepare: (): PromoterApplicationForm => ({ country, channels: filled, plan: plan.trim(), termsVersion }),
      send: (key, body: PromoterApplicationForm) => referralApi.apply(body, key),
      onDone: (answer: AccountReferral): undefined => {
        client.setQueryData(referralQueryKey(userId), answer);
        onOpenChange(false);
        toast.success(t('membership.promoter.submitted'));
        return undefined;
      },
      onFailure: (err) => {
        if (err instanceof ApiException && err.reason === 'terms_changed') {
          setAgreed(false);
          setTermsNotice(true);
          void client.invalidateQueries({ queryKey: referralQueryKey(userId) });
          return;
        }
        toast.error(err instanceof ApiException ? err.message : t('membership.referral.loadFailed'));
        if (err instanceof ApiException && err.status === 409) {
          onOpenChange(false);
          void client.invalidateQueries({ queryKey: referralQueryKey(userId) });
        }
      },
    });
  }, [channels, country, plan, agreed, termsVersion, t, client, userId, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>{t('membership.promoter.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('membership.promoter.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-4'>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='promoter-country'>{t('membership.promoter.country')}</Label>
            <Select value={country} onValueChange={(v) => { setCountry(v); setErrors((e) => ({ ...e, country: undefined })); }}>
              <SelectTrigger id='promoter-country' aria-label={t('membership.promoter.country')} aria-invalid={!!errors.country || undefined}>
                <SelectValue placeholder={t('membership.promoter.countryPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {countries.map((c) => <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {errors.country ? <FieldError>{errors.country}</FieldError> : null}
          </div>

          <div className='flex flex-col gap-1.5'>
            <div className='flex items-baseline justify-between'>
              <Label>{t('membership.promoter.channels')}</Label>
              <span className='text-xs text-muted-foreground'>{t('membership.promoter.channelsHint')}</span>
            </div>
            {channels.map((channel, i) => (
              <div key={i} className='flex gap-2'>
                <Input
                  autoComplete='off'
                  maxLength={200}
                  value={channel}
                  placeholder={i === 0 ? t('membership.promoter.channelPlaceholder') : undefined}
                  aria-invalid={!!errors.channels || undefined}
                  onChange={(e) => {
                    const value = e.target.value;
                    setChannels((list) => list.map((c, j) => (j === i ? value : c)));
                    setErrors((er) => ({ ...er, channels: undefined }));
                  }}
                />
                {channels.length > 1 ? (
                  <Button type='button' variant='ghost' size='icon' aria-label={t('membership.promoter.removeChannel')}
                    onClick={() => setChannels((list) => list.filter((_, j) => j !== i))}>
                    <Trash2 className='h-3.5 w-3.5' />
                  </Button>
                ) : null}
              </div>
            ))}
            {channels.length < MAX_CHANNELS ? (
              <Button type='button' variant='link' size='compact' className='w-fit px-0 text-xs text-muted-foreground'
                onClick={() => setChannels((list) => [...list, ''])}>
                <Plus className='h-3 w-3' />{t('membership.promoter.addChannel')}
              </Button>
            ) : null}
            {errors.channels ? <FieldError>{errors.channels}</FieldError> : null}
          </div>

          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='promoter-plan'>{t('membership.promoter.plan')}</Label>
            <Textarea
              id='promoter-plan'
              rows={4}
              maxLength={2000}
              value={plan}
              placeholder={t('membership.promoter.planPlaceholder')}
              aria-invalid={!!errors.plan || undefined}
              onChange={(e) => { setPlan(e.target.value); setErrors((er) => ({ ...er, plan: undefined })); }}
            />
            {errors.plan ? <FieldError>{errors.plan}</FieldError> : null}
          </div>

          {termsNotice ? <FieldError role='alert'>{t('membership.promoter.termsChanged')}</FieldError> : null}
          <div className='flex flex-col gap-1'>
            <label className='flex items-start gap-2 text-sm'>
              <Checkbox
                checked={agreed}
                aria-invalid={!!errors.agree || undefined}
                onCheckedChange={(v) => { setAgreed(v === true); setTermsNotice(false); setErrors((er) => ({ ...er, agree: undefined })); }}
              />
              <span>
                {t('membership.promoter.agreeLead')}{' '}
                <a href={PROMOTER_TERMS_URL} target='_blank' rel='noopener noreferrer' className='inline-flex items-center gap-0.5 underline'>
                  {t('membership.promoter.termsLink')}<ExternalLink className='h-3 w-3' />
                </a>
              </span>
            </label>
            {errors.agree ? <FieldError>{errors.agree}</FieldError> : null}
          </div>
        </div>
        <DialogFooter>
          <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>{t('membership.promoter.cancel')}</Button>
          <Button type='button' loading={pressing} onClick={submit}>{t('membership.promoter.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
