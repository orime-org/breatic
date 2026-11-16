// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getLocale } from '@breatic/shared';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import {
  fetchSpendLimits,
  removeMemberSpendLimit,
  saveMemberSpendLimit,
  saveSpendLimits,
  spendLimitsQueryKey,
  type SpendLimitMember,
} from '@web/data/api/spend-limits';
import { usersApi } from '@web/data/api/users';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { toast } from '@web/lib/toast';

const KEY = 'studio.container.credits.spendCap';

/** A limit as the admin edits it: none, or an amount still being typed. */
type Draft = { kind: 'none' } | { kind: 'amount'; text: string };

/**
 * The draft a stored limit opens as.
 * @param value - The stored limit, or null for none.
 * @returns The draft.
 */
function draftOf(value: string | null): Draft {
  return value === null ? { kind: 'none' } : { kind: 'amount', text: formatCreditAmount(value).replace(/,/g, '') };
}

/**
 * The amount a draft sends, or undefined while it is not a usable number.
 * @param draft - The draft.
 * @returns The credits, null for none, undefined when unusable.
 */
function valueOf(draft: Draft): number | null | undefined {
  if (draft.kind === 'none') return null;
  const credits = Number(draft.text.trim());
  return draft.text.trim() !== '' && Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}

/**
 * One limit, with `不设` and an amount per month.
 * @param props - The limit.
 * @param props.label - What it limits.
 * @param props.hint - How it applies.
 * @param props.draft - Its draft.
 * @param props.onChange - Takes the next draft.
 * @returns The control.
 */
function CapInput({ label, hint, draft, onChange }: { label: string; hint: string; draft: Draft; onChange: (next: Draft) => void }): React.JSX.Element {
  const t = useTranslation();
  const id = React.useId();
  const amount = draft.kind === 'amount' ? draft.text : '';
  return (
    <div className='flex flex-col gap-2'>
      <div className='text-sm font-medium'>{label}</div>
      <div className='text-xs text-muted-foreground'>{hint}</div>
      <RadioGroup
        value={draft.kind}
        onValueChange={(kind) => onChange(kind === 'none' ? { kind: 'none' } : { kind: 'amount', text: amount === '' ? '0' : amount })}
        className='flex items-center gap-4'
        aria-label={label}
      >
        <label htmlFor={`${id}-none`} className='flex items-center gap-1.5 text-sm'>
          <RadioGroupItem id={`${id}-none`} value='none' />
          {t(`${KEY}.notSet`)}
        </label>
        <label htmlFor={`${id}-amount`} className='flex items-center gap-1.5 text-sm'>
          <RadioGroupItem id={`${id}-amount`} value='amount' />
          {t(`${KEY}.perMonth`)}
          <Input
            value={amount}
            inputMode='decimal'
            autoComplete='off'
            disabled={draft.kind !== 'amount'}
            aria-label={label}
            onChange={(event) => onChange({ kind: 'amount', text: event.target.value })}
            className='h-7 w-24 text-sm tabular-nums'
          />
          {t('studio.container.credits.unit')}
        </label>
      </RadioGroup>
    </div>
  );
}

/**
 * The limit in force, in words: none, zero, or an amount.
 * @param value - The limit, or null for none.
 * @param t - The translate function.
 * @returns The words.
 */
function limitText(value: string | null, t: ReturnType<typeof useTranslation>): string {
  if (value === null) return t(`${KEY}.unlimited`);
  if (Number(value) === 0) return t(`${KEY}.zero`);
  return t(`${KEY}.amount`, { amount: formatCreditAmount(value) });
}

/**
 * A team Studio's monthly spend limits on its credits tab (inner#1968, design
 * 3.10): the Studio's total and the per-person default, what was spent this
 * month and when it resets, and everyone who can spend here with what they
 * spent and the limit in force. Only the admin reads it; the server's 403 for
 * anyone else and 404 for a personal Studio leave the section out.
 * @param props - The Studio.
 * @param props.slug - The Studio's slug.
 * @returns The section, or nothing for anyone but a team Studio's admin.
 */
export function SpendCapsSection({ slug }: { slug: string }): React.JSX.Element | null {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = spendLimitsQueryKey(slug);
  const query = useQuery({ queryKey, queryFn: () => fetchSpendLimits(slug), retry: false });
  const view = query.data;
  const ids = React.useMemo(() => view?.members.map((member) => member.userId) ?? [], [view]);
  const people = useQuery({
    queryKey: ['users-by-ids', ...ids],
    queryFn: () => usersApi.getByIds(ids),
    enabled: ids.length > 0,
    retry: false,
  }).data;
  const nameOf = React.useMemo(() => new Map((people ?? []).map((person) => [person.id, person.name])), [people]);

  const [studioDraft, setStudioDraft] = React.useState<Draft>({ kind: 'none' });
  const [memberDraft, setMemberDraft] = React.useState<Draft>({ kind: 'none' });
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState<SpendLimitMember | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const reset = React.useCallback((): void => {
    if (view === undefined) return;
    setStudioDraft(draftOf(view.studioMonthly));
    setMemberDraft(draftOf(view.memberDefault));
  }, [view]);
  React.useEffect(reset, [reset]);

  const saveFailed = t(`${KEY}.saveFailed`);
  const savedLine = t(`${KEY}.saved`);
  const studioValue = valueOf(studioDraft);
  const memberValue = valueOf(memberDraft);
  const dirty = view !== undefined && (
    JSON.stringify(studioDraft) !== JSON.stringify(draftOf(view.studioMonthly)) ||
    JSON.stringify(memberDraft) !== JSON.stringify(draftOf(view.memberDefault))
  );
  const save = React.useCallback(async (): Promise<void> => {
    if (studioValue === undefined || memberValue === undefined) return;
    setSaving(true);
    try {
      await saveSpendLimits(slug, { studioMonthly: studioValue, memberDefault: memberValue });
      await queryClient.invalidateQueries({ queryKey });
      toast.success(savedLine);
    } catch {
      toast.error(saveFailed);
    } finally {
      setSaving(false);
    }
  }, [slug, studioValue, memberValue, queryClient, queryKey, savedLine, saveFailed]);

  const restore = React.useCallback(async (userId: string): Promise<void> => {
    setRestoring(userId);
    try {
      await removeMemberSpendLimit(slug, userId);
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error(saveFailed);
    } finally {
      setRestoring(null);
    }
  }, [slug, queryClient, queryKey, saveFailed]);

  if (view === undefined) return null;
  const resetsAt = new Date(view.nextResetAt).toLocaleString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const studioCapped = view.studioMonthly !== null && Number(view.studioSpent) >= Number(view.studioMonthly);

  return (
    <section className='flex flex-col gap-4 rounded-content-md border border-border p-4' data-testid='studio-spend-caps'>
      <h3 className='text-sm font-semibold'>{t(`${KEY}.title`)}</h3>
      <div className='grid grid-cols-2 gap-6'>
        <CapInput label={t(`${KEY}.studioMonthly`)} hint={t(`${KEY}.studioMonthlyHint`)} draft={studioDraft} onChange={setStudioDraft} />
        <CapInput label={t(`${KEY}.memberDefault`)} hint={t(`${KEY}.memberDefaultHint`)} draft={memberDraft} onChange={setMemberDraft} />
      </div>
      <div className='flex items-center justify-between gap-4 border-t border-border pt-4'>
        <div className='flex gap-8 text-sm'>
          <div>
            <div className='text-xs text-muted-foreground'>{t(`${KEY}.studioSpent`)}</div>
            <div className={studioCapped ? 'tabular-nums text-status-error' : 'tabular-nums'}>
              {view.studioMonthly === null
                ? t(`${KEY}.amount`, { amount: formatCreditAmount(view.studioSpent) })
                : t(`${KEY}.amount`, { amount: `${formatCreditAmount(view.studioSpent)} / ${formatCreditAmount(view.studioMonthly)}` })}
            </div>
          </div>
          <div>
            <div className='text-xs text-muted-foreground'>{t(`${KEY}.resetsAt`)}</div>
            <div>{resetsAt}</div>
          </div>
        </div>
        <div className='flex gap-2'>
          <Button variant='outline' disabled={!dirty || saving} onClick={reset}>{t('common.cancel')}</Button>
          <Button disabled={!dirty || studioValue === undefined || memberValue === undefined} loading={saving} onClick={() => void save()}>
            {t(`${KEY}.save`)}
          </Button>
        </div>
      </div>
      <table className='w-full text-left text-sm'>
        <thead className='text-xs text-muted-foreground'>
          <tr>
            <th className='py-1 font-medium'>{t(`${KEY}.colMember`)}</th>
            <th className='py-1 font-medium'>{t(`${KEY}.colRelation`)}</th>
            <th className='py-1 text-right font-medium'>{t(`${KEY}.colSpent`)}</th>
            <th className='py-1 pl-6 font-medium'>{t(`${KEY}.colEffective`)}</th>
            <th className='py-1' />
          </tr>
        </thead>
        <tbody>
          {view.members.map((member) => {
            const former = member.relation === 'former';
            const atCap = !former && member.effective !== null && Number(member.spent) >= Number(member.effective);
            return (
              <tr key={member.userId} className={former ? 'border-t border-border text-muted-foreground' : 'border-t border-border'}>
                <td className='py-2.5'>{nameOf.get(member.userId) ?? '—'}</td>
                <td>{t(`${KEY}.${member.relation === 'studio_member' ? 'relationStudioMember' : member.relation === 'project_collaborator' ? 'relationProjectCollaborator' : 'relationFormer'}`)}</td>
                <td className='text-right tabular-nums'>{formatCreditAmount(member.spent)}</td>
                <td className='pl-6'>
                  {former ? '—' : (
                    <span className='flex items-center gap-1.5'>
                      <span className='text-xs text-muted-foreground'>{t(`${KEY}.${member.override === null ? 'sourceDefault' : 'sourceOverride'}`)}</span>
                      <span>{limitText(member.effective, t)}</span>
                      {atCap ? <Badge variant='destructive'>{t(`${KEY}.atCap`)}</Badge> : null}
                    </span>
                  )}
                </td>
                <td className='text-right'>
                  {former ? null : (
                    <span className='inline-flex gap-1'>
                      <Button size='compact' variant='outline' onClick={() => setEditing(member)}>{t(`${KEY}.override`)}</Button>
                      {member.override === null ? null : (
                        <Button size='compact' variant='ghost' loading={restoring === member.userId} onClick={() => void restore(member.userId)}>
                          {t(`${KEY}.restoreDefault`)}
                        </Button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing === null ? null : (
        <OverrideDialog
          slug={slug}
          member={editing}
          name={nameOf.get(editing.userId) ?? '—'}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** What one person's own limit is set to in the dialog. */
type OverrideMode = 'amount' | 'none' | 'zero';

/**
 * Set one person's own monthly limit: an amount, none, or zero.
 * @param props - The person.
 * @param props.slug - The Studio.
 * @param props.member - Their row.
 * @param props.name - Their name.
 * @param props.onClose - Closes the dialog.
 * @returns The dialog.
 */
function OverrideDialog({ slug, member, name, onClose }: { slug: string; member: SpendLimitMember; name: string; onClose: () => void }): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const id = React.useId();
  const start = member.effective;
  const [mode, setMode] = React.useState<OverrideMode>(start === null ? 'none' : Number(start) === 0 ? 'zero' : 'amount');
  const [text, setText] = React.useState(start !== null && Number(start) > 0 ? formatCreditAmount(start).replace(/,/g, '') : '');
  const [saving, setSaving] = React.useState(false);
  const amount = valueOf({ kind: 'amount', text });
  const credits = mode === 'none' ? null : mode === 'zero' ? 0 : amount;
  const saveFailed = t(`${KEY}.saveFailed`);
  const save = React.useCallback(async (): Promise<void> => {
    if (credits === undefined) return;
    setSaving(true);
    try {
      await saveMemberSpendLimit(slug, member.userId, credits);
      await queryClient.invalidateQueries({ queryKey: spendLimitsQueryKey(slug) });
      onClose();
    } catch {
      toast.error(saveFailed);
    } finally {
      setSaving(false);
    }
  }, [credits, slug, member.userId, queryClient, onClose, saveFailed]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(`${KEY}.overrideTitle`, { name })}</DialogTitle>
          <DialogDescription>{t(`${KEY}.overrideHint`)}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={mode} onValueChange={(next) => setMode(next as OverrideMode)} className='gap-2'>
          <label htmlFor={`${id}-amount`} className='flex items-center gap-1.5 text-sm'>
            <RadioGroupItem id={`${id}-amount`} value='amount' />
            {t(`${KEY}.perMonth`)}
            <Input
              value={text}
              inputMode='decimal'
              autoComplete='off'
              disabled={mode !== 'amount'}
              aria-label={t(`${KEY}.perMonth`)}
              onChange={(event) => setText(event.target.value)}
              className='h-7 w-24 text-sm tabular-nums'
            />
            {t('studio.container.credits.unit')}
          </label>
          <label htmlFor={`${id}-none`} className='flex items-center gap-1.5 text-sm'>
            <RadioGroupItem id={`${id}-none`} value='none' />
            {t(`${KEY}.unlimited`)}
          </label>
          <label htmlFor={`${id}-zero`} className='flex items-center gap-1.5 text-sm'>
            <RadioGroupItem id={`${id}-zero`} value='zero' />
            {t(`${KEY}.zero`)}
          </label>
        </RadioGroup>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={credits === undefined} loading={saving} onClick={() => void save()}>{t(`${KEY}.save`)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
