// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { TimelineClientLimits } from '@breatic/shared';
import { webAnimationDurationFrames, type WebAnimationRowView } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { useReturnFocus } from '@web/lib/overlay-focus';
import type { CreationDraftInput, CreationDraftState } from '@web/spaces/web-animation/creation-draft';
import { WEB_ANIMATION_ENGINE_NAMES, isWebAnimationEngine } from '@web/spaces/web-animation/execution-text';
import { PreviewUnavailable, playable } from '@web/spaces/web-animation/motion-parts';
import { MotionResultPlayer } from '@web/spaces/web-animation/MotionResultPlayer';

/** The open creation dialog's draft and actions. */
interface WebAnimationDialogProps {
  projectId: string;
  spaceId: string;
  draft: Exclude<CreationDraftState, { status: 'closed' }>;
  retry: boolean;
  limits: TimelineClientLimits['webAnimation'];
  /** The result a modification starts from, once read. */
  baseRow: WebAnimationRowView | undefined;
  /** Whether reading that result failed, and how to read it again. */
  baseRead: { failed: boolean; retrying: boolean; retry: () => void };
  onEdit: (patch: Partial<CreationDraftInput>) => void;
  onExecute: () => void;
  onClose: () => void;
}

/**
 * The Motion Space's New and Modify dialog (inner#1711 design §8, #1490 design §5.1): the prompt, or a modification's
 * instruction under a small preview of the result it starts from, then engine, aspect and duration; a modification whose
 * aspect or length differs from that result says the picture is laid out again. Execute fixes what is shown; while
 * it waits the fields hold and the button shows it is waiting; a refusal comes back here with the server's reason and
 * the input kept.
 * @param props - The draft and its actions.
 * @param props.projectId - The Project, through which the preview is read.
 * @param props.spaceId - The Space, for field ids.
 * @param props.draft - The open draft.
 * @param props.retry - Whether it runs a finished execution again.
 * @param props.limits - The configured bounds.
 * @param props.baseRow - The result a modification starts from, once read.
 * @param props.baseRead - Whether reading it failed, and its retry.
 * @param props.onEdit - Changes the input.
 * @param props.onExecute - Submits it.
 * @param props.onClose - Closes the dialog; a submission goes on.
 * @returns The dialog.
 * @throws {never} Never.
 */
export function WebAnimationDialog({ projectId, spaceId, draft, retry, limits, baseRow, baseRead, onEdit, onExecute, onClose }: WebAnimationDialogProps): React.JSX.Element {
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
  const changeEngine = React.useCallback((value: string): void => { if (isWebAnimationEngine(value)) onEdit({ engine: value }); }, [onEdit]);
  const changeAspect = React.useCallback((value: string): void => {
    if (value === '16:9' || value === '9:16' || value === '1:1') onEdit({ aspect: value });
  }, [onEdit]);
  // An emptied field is not a number; Execute stays unavailable until it holds a whole number in range.
  const changeDuration = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    onEdit({ durationSeconds: event.target.value.trim() === '' ? Number.NaN : Number(event.target.value) });
  }, [onEdit]);
  const fieldId = `motion-dialog-${spaceId}`;
  const modifying = input.base !== null;
  const base = playable(baseRow) ? baseRow : undefined;
  const relayout = base !== undefined && (input.aspect !== base.input.aspect || input.durationSeconds !== base.input.durationSeconds);
  const baseAspect = (base?.input.aspect ?? input.aspect).replace(':', ' / ');
  return <Dialog open onOpenChange={changeOpen}>
    <DialogContent onCloseAutoFocus={returnFocus}>
      <DialogHeader>
        <DialogTitle>{t(modifying ? 'spaces.webAnimation.dialog.modifyTitle' : retry ? 'timeline.webAnimation.dialog.retryTitle' : 'timeline.webAnimation.dialog.title')}</DialogTitle>
        {!modifying && <DialogDescription>{t('timeline.webAnimation.dialog.description')}</DialogDescription>}
      </DialogHeader>
      <form noValidate onSubmit={submit}>
        <DialogBody className='flex flex-col gap-4'>
          {modifying && <DialogDescription asChild>
            <div data-testid='web-animation-base' className='flex items-center gap-3 rounded-chrome border border-border p-2'>
              <div className='relative h-12 shrink-0 overflow-hidden rounded-chrome bg-muted' style={{ aspectRatio: baseAspect }}>
                {base === undefined
                  ? baseRead.failed ? <PreviewUnavailable onRetry={baseRead.retry} retrying={baseRead.retrying} /> : <Skeleton className='absolute inset-0 rounded-none' />
                  : <MotionResultPlayer projectId={projectId} executionId={base.id} sourceVersionId={base.resultSourceVersionId} input={base.input}
                    frame={Math.floor(webAnimationDurationFrames(base.input) / 2)} />}
              </div>
              <span className='flex min-w-0 flex-col gap-0.5'>
                <span className='break-words text-foreground'>{t('spaces.webAnimation.dialog.modifyDescription', { base: input.base?.request ?? '' })}</span>
                <span className='text-xs text-muted-foreground'>{t('spaces.webAnimation.dialog.modifyKeepsOriginal')}</span>
              </span>
            </div>
          </DialogDescription>}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor={`${fieldId}-prompt`}>{t(modifying ? 'spaces.webAnimation.dialog.instruction' : 'timeline.webAnimation.dialog.prompt')}</Label>
            <Textarea id={`${fieldId}-prompt`} data-testid='web-animation-prompt' rows={4} autoComplete='off' maxLength={limits.promptMaxLength} className='resize-none'
              placeholder={t(modifying ? 'spaces.webAnimation.dialog.instructionPlaceholder' : 'timeline.webAnimation.dialog.promptPlaceholder')} value={input.prompt} disabled={submitting} onChange={changePrompt} />
            <span className='self-end text-xs tabular-nums text-muted-foreground'>{`${input.prompt.length} / ${limits.promptMaxLength}`}</span>
          </div>
          <div className='grid grid-cols-3 gap-3'>
            <div className='flex min-w-0 flex-col gap-1.5'>
              <Label htmlFor={`${fieldId}-engine`}>{t('timeline.webAnimation.dialog.engine')}</Label>
              <Select value={input.engine} onValueChange={changeEngine} disabled={submitting}>
                <SelectTrigger id={`${fieldId}-engine`} data-testid='web-animation-engine' className='w-full'><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(WEB_ANIMATION_ENGINE_NAMES).map(([value, name]) => <SelectItem key={value} value={value}>{name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className='flex min-w-0 flex-col gap-1.5'>
              <Label id={`${fieldId}-aspect`}>{t('timeline.webAnimation.dialog.aspect')}</Label>
              {/* Every aspect side by side, picked with one click (the approved demo's creation dialog). */}
              <Tabs value={input.aspect} onValueChange={changeAspect}>
                <TabsList data-testid='web-animation-aspect' aria-labelledby={`${fieldId}-aspect`} className='h-[var(--control-height)]'>
                  {limits.aspects.map((aspect) => <TabsTrigger key={aspect} value={aspect} disabled={submitting} className='tabular-nums'>{aspect}</TabsTrigger>)}
                </TabsList>
              </Tabs>
            </div>
            <div className='flex min-w-0 flex-col gap-1.5'>
              <Label htmlFor={`${fieldId}-duration`}>{t('timeline.webAnimation.dialog.duration')}</Label>
              <Input id={`${fieldId}-duration`} data-testid='web-animation-duration' type='number' inputMode='numeric' autoComplete='off' min={min} max={max} step={1} className='w-full'
                value={Number.isFinite(input.durationSeconds) ? input.durationSeconds : ''} disabled={submitting} onChange={changeDuration} />
            </div>
          </div>
          {relayout && <p className='text-xs text-muted-foreground'>{t('spaces.webAnimation.dialog.relayout')}</p>}
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
