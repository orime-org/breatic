// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What a watch-only video surface shows while it has no selected version (frames-split design §7.9 last paragraph, §10.6):
 * a candidate failure shows its reason, with Retry for a temporary one when the surface offers it; otherwise, once the
 * browser cannot play the original, the cover and "Preparing video…" instead of a player error.
 */

import * as React from 'react';
import { classifyVideoSourceLedgerFailure } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/** The candidate's state a surface without a selected version reads from Qp. */
export interface VideoPreparationState {
  /** The target candidate's failure code, null while it is being prepared. */
  failure: string | null;
  /** Repairs the source; absent where the surface offers no Retry (a hover preview). */
  onRetry?: () => void;
  /** Whether a Retry press is still waiting. */
  retrying?: boolean;
}

/**
 * Whether a candidate failure offers Retry: a temporary one does, a content one only shows its reason (§10.6).
 * @param failure - The failure code.
 * @returns Whether Retry is offered.
 * @throws {never} Never.
 */
export function preparationRetryable(failure: string): boolean {
  return classifyVideoSourceLedgerFailure(failure) !== 'content';
}

/**
 * The locale key naming a candidate failure (§7.12 step 2).
 * @param failure - The failure code.
 * @returns The key.
 * @throws {never} Never.
 */
export function preparationFailureKey(failure: string): string {
  if (preparationRetryable(failure)) return 'canvas.miniTool.videoUI.preparationFailed';
  return failure === 'too_long' ? 'canvas.miniTool.videoUI.tooLongToPrepare' : 'canvas.miniTool.videoUI.ledgerUnsupported';
}

interface VideoPreparationNoticeProps extends VideoPreparationState {
  /** Whether the browser failed to play the original. */
  originalFailed: boolean;
  /** The cover shown while preparing. */
  poster?: string;
  className?: string;
}

/**
 * The preparing or failed state over a surface that plays the original for display only.
 * @param props - The candidate state, whether the original failed, and the cover.
 * @returns The notice, or null while the original plays and nothing failed.
 * @throws {never} Never.
 */
export function VideoPreparationNotice(props: VideoPreparationNoticeProps): React.JSX.Element | null {
  const t = useTranslation();
  const { failure, onRetry, retrying, originalFailed, poster } = props;
  if (failure === null && !originalFailed) return null;
  const temporary = failure !== null && preparationRetryable(failure);
  return <div data-testid='video-preparation-notice' className={cn('pointer-events-auto absolute inset-0 z-20 grid place-content-center justify-items-center gap-2 bg-card p-3 text-center', props.className)}>
    {failure === null && poster !== undefined ? <img src={poster} alt='' className='pointer-events-none absolute inset-0 h-full w-full object-contain' /> : null}
    <p className={cn('relative text-xs', failure === null ? 'rounded-chrome bg-popover px-2 py-1 text-muted-foreground' : 'text-status-error-foreground')}>{t(failure === null ? 'canvas.miniTool.videoUI.preparingVideo' : preparationFailureKey(failure))}</p>
    {temporary && onRetry !== undefined ? <Button variant='outline' size='sm' className='nodrag nokey relative' loading={retrying === true} onClick={onRetry}>{t('canvas.task.action.retry')}</Button> : null}
  </div>;
}
