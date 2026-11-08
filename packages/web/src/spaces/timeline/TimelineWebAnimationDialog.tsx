// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { TimelineClientLimits } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Switch } from '@web/components/ui/switch';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { useReturnFocus } from '@web/lib/overlay-focus';
import type { CreationDraftInput, CreationDraftState } from '@web/spaces/timeline/web-animation-creation-draft';

/** Engine names are the vendor's own and stay in English. */
export const WEB_ANIMATION_ENGINE_NAMES: Readonly<Record<CreationDraftInput['engine'], string>> = { deepseek: 'DeepSeek' };

const LABEL = 'text-xs text-muted-foreground';

/** The open creation dialog's draft and actions. */
interface TimelineWebAnimationDialogProps {
  spaceId: string;
  draft: Exclude<CreationDraftState, { status: 'closed' }>;
  retry: boolean;
  limits: TimelineClientLimits['webAnimation'];
  onEdit: (patch: Partial<CreationDraftInput>) => void;
  onExecute: () => void;
  onClose: () => void;
}

/**
 * The web-animation creation dialog (inner#1711 design §8): prompt, engine, aspect, duration and the switch that
 * adds a placeholder at the playhead. Execute fixes what is shown; while it waits the fields hold and the button shows
 * it is waiting; a refusal comes back here with the server's reason and the input kept.
 * @param props - The draft and its actions.
 * @param props.spaceId - The Space, for field ids.
 * @param props.draft - The open draft.
 * @param props.retry - Whether it runs a finished execution again.
 * @param props.limits - The configured bounds.
 * @param props.onEdit - Changes the input.
 * @param props.onExecute - Submits it.
 * @param props.onClose - Closes the dialog; a submission goes on.
 * @returns The dialog.
 * @throws {never} Never.
 */
export function TimelineWebAnimationDialog({ spaceId, draft, retry, limits, onEdit, onExecute, onClose }: TimelineWebAnimationDialogProps): React.JSX.Element {
  const t = useTranslation();
  const returnFocus = useReturnFocus(true);
  const submitting = draft.status === 'submitting';
  const { input } = draft;
  const error = draft.status === 'drafting' ? draft.error : null;
  const { min, max } = limits.durationSeconds;
  const valid = input.prompt.trim() !== '' && input.prompt.length <= limits.promptMaxLength
    && Number.isInteger(input.durationSeconds) && input.durationSeconds >= min && input.durationSeconds <= max;
  const changeOpen = React.useCallback((open: boolean): void => { if (!open) onClose(); }, [onClose]);
  const submit = React.useCallback((event: React.FormEvent): void => { event.preventDefault(); onExecute(); }, [onExecute]);
  const changePrompt = React.useCallback((event: React.ChangeEvent<HTMLTextAreaElement>): void => onEdit({ prompt: event.target.value }), [onEdit]);
  const changeEngine = React.useCallback((value: string): void => { if (value === 'deepseek') onEdit({ engine: value }); }, [onEdit]);
  const changeAspect = React.useCallback((value: string): void => {
    if (value === '16:9' || value === '9:16' || value === '1:1') onEdit({ aspect: value });
  }, [onEdit]);
  // An emptied field is not a number; Execute stays unavailable until it holds a whole number in range.
  const changeDuration = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    onEdit({ durationSeconds: event.target.value.trim() === '' ? Number.NaN : Number(event.target.value) });
  }, [onEdit]);
  const changeAdd = React.useCallback((checked: boolean): void => onEdit({ addAtPlayhead: checked }), [onEdit]);
  const fieldId = `timeline-web-animation-${spaceId}`;
  return <Dialog open onOpenChange={changeOpen}>
    <DialogContent onCloseAutoFocus={returnFocus}>
      <DialogHeader>
        <DialogTitle>{t(retry ? 'timeline.webAnimation.dialog.retryTitle' : 'timeline.webAnimation.dialog.title')}</DialogTitle>
        <DialogDescription>{t('timeline.webAnimation.dialog.description')}</DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={submit}>
        <DialogBody className='flex flex-col gap-4'>
          <div className='flex flex-col gap-1'>
            <Label htmlFor={`${fieldId}-prompt`} className={LABEL}>{t('timeline.webAnimation.dialog.prompt')}</Label>
            <Textarea id={`${fieldId}-prompt`} data-testid='web-animation-prompt' rows={4} autoComplete='off' maxLength={limits.promptMaxLength} className='resize-none'
              placeholder={t('timeline.webAnimation.dialog.promptPlaceholder')} value={input.prompt} disabled={submitting} onChange={changePrompt} />
            <span className='self-end text-xs tabular-nums text-muted-foreground'>{`${input.prompt.length} / ${limits.promptMaxLength}`}</span>
          </div>
          <div className='grid grid-cols-3 gap-3'>
            <div className='flex min-w-0 flex-col gap-1'>
              <Label htmlFor={`${fieldId}-engine`} className={LABEL}>{t('timeline.webAnimation.dialog.engine')}</Label>
              <Select value={input.engine} onValueChange={changeEngine} disabled={submitting}>
                <SelectTrigger id={`${fieldId}-engine`} data-testid='web-animation-engine' className='h-8 w-full'><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(WEB_ANIMATION_ENGINE_NAMES).map(([value, name]) => <SelectItem key={value} value={value}>{name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className='flex min-w-0 flex-col gap-1'>
              <Label htmlFor={`${fieldId}-aspect`} className={LABEL}>{t('timeline.webAnimation.dialog.aspect')}</Label>
              <Select value={input.aspect} onValueChange={changeAspect} disabled={submitting}>
                <SelectTrigger id={`${fieldId}-aspect`} data-testid='web-animation-aspect' className='h-8 w-full'><SelectValue /></SelectTrigger>
                <SelectContent>{limits.aspects.map((aspect) => <SelectItem key={aspect} value={aspect}>{aspect}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className='flex min-w-0 flex-col gap-1'>
              <Label htmlFor={`${fieldId}-duration`} className={LABEL}>{t('timeline.webAnimation.dialog.duration')}</Label>
              <Input id={`${fieldId}-duration`} data-testid='web-animation-duration' type='number' inputMode='numeric' autoComplete='off' min={min} max={max} step={1} className='h-8 w-full'
                value={Number.isFinite(input.durationSeconds) ? input.durationSeconds : ''} disabled={submitting} onChange={changeDuration} />
            </div>
          </div>
          <div className='flex items-center justify-between gap-3'>
            <Label htmlFor={`${fieldId}-add`} className='text-sm'>{t('timeline.webAnimation.dialog.addAtPlayhead')}</Label>
            <Switch id={`${fieldId}-add`} data-testid='web-animation-add-at-playhead' checked={input.addAtPlayhead} onCheckedChange={changeAdd} disabled={submitting} />
          </div>
          {error !== null && <p role='alert' className='text-sm text-status-error-foreground'>{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>{t('timeline.cancel')}</Button>
          <Button type='submit' data-testid='web-animation-execute' loading={submitting} disabled={!valid}>{t('timeline.webAnimation.dialog.execute')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
