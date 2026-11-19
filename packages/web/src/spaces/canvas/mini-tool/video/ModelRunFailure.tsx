// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { modelFailureRetryable, type EraseFailureReason, type ExpandFailureReason } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { useRunning } from '@web/stores/task-actions-in-flight';

const CATEGORY_KEYS = { model_rejected: 'personFailRejected', model_output_mismatch: 'failOutputMismatch', timeout: 'personFailTimeout', failed: 'personFailFailed', stopped: 'personFailStopped' } as const;
const ERASE_NEXT_KEYS = { model_rejected: 'eraseRejectedNext', model_output_mismatch: 'eraseMismatchNext', timeout: 'personFailRetryNext', failed: 'personFailRetryNext' } as const;
const EXPAND_NEXT_KEYS = { model_rejected: 'expandRejectedNext', timeout: 'personFailRetryNext', failed: 'personFailRetryNext' } as const;

/**
 * A failed erase or expand run (execution design §10.4, §10.5 failure tables): an erase's one step and category with its next
 * step; an expand's line per window that did not succeed, a stopped window naming the window that stopped it, and the line
 * of a failed step outside every window. Retry is offered only when shared `modelFailureRetryable` allows it.
 * @param props - The reason and the actions.
 * @param props.reason - The failure reason.
 * @param props.disabled - Whether the panel takes edits.
 * @param props.onRetry - Retries the failed items; without it no retry is offered.
 * @param props.retryIntent - The retry's press intent, which the button waits on.
 * @returns The failure block.
 * @throws {z.ZodError} When the reason is malformed.
 */
export function ModelRunFailure(props: { reason: EraseFailureReason | ExpandFailureReason; disabled: boolean; onRetry?: () => void; retryIntent?: string }): React.JSX.Element {
  const t = useTranslation();
  const retrying = Boolean(useRunning(props.retryIntent ?? ''));
  const { reason } = props;
  /**
   * One step's line.
   * @param title - What failed.
   * @param category - Why.
   * @param next - The next step.
   * @param key - The line's key.
   * @returns The line.
   * @throws {never} Never.
   */
  const line = (title: string, category: keyof typeof CATEGORY_KEYS, next: string, key: string): React.JSX.Element =>
    <li key={key} className='grid gap-0.5'><span className='font-medium'>{`${title} · ${t(`canvas.miniTool.videoUI.${CATEGORY_KEYS[category]}`)}`}</span><span>{next}</span></li>;
  let lines: React.JSX.Element[];
  if (reason.kind === 'erase') {
    lines = [line(t(`canvas.miniTool.videoUI.stepFail.${reason.step}`), reason.category, t(`canvas.miniTool.videoUI.${ERASE_NEXT_KEYS[reason.category]}`), 'erase')];
  } else {
    // A stopped window follows the first window that failed on its own.
    const blocker = reason.windows.find((window) => window.category !== 'stopped');
    lines = reason.windows.map((window) => line(t('canvas.miniTool.videoUI.windowNumber', { number: window.windowIndex + 1 }), window.category,
      window.category === 'stopped' ? t('canvas.miniTool.videoUI.windowStoppedNext', { number: (blocker?.windowIndex ?? window.windowIndex) + 1 })
        : t(`canvas.miniTool.videoUI.${EXPAND_NEXT_KEYS[window.category]}`), `window-${window.windowIndex}`));
    if (reason.shared !== null) lines.push(line(t(`canvas.miniTool.videoUI.stepFail.${reason.shared.step}`), reason.shared.category, t('canvas.miniTool.videoUI.personFailRetryNext'), 'shared'));
  }
  return <div className='grid gap-2 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground' data-testid='video-model-run-failure'>
    <ul className='grid min-w-0 gap-1.5'>{lines}</ul>
    {modelFailureRetryable(reason) && props.onRetry !== undefined ? <div className='flex justify-end'><Button variant='outline' size='compact' loading={retrying} disabled={props.disabled} onClick={props.onRetry}>{t('canvas.miniTool.videoUI.retryFailedItems')}</Button></div> : null}
  </div>;
}
