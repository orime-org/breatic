// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The pieces the Motion Space's panels are built from: the panel that docks inside the Space on the right and how it
 * scrolls an item into view, how a time in a result reads, and how long a row is. The bar's icon button lives in
 * `components/BarButton.tsx`.
 */

import * as React from 'react';
import { X } from 'lucide-react';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * A time in a result as the play bar, the annotation panel and the cards show it: minutes, seconds and tenths.
 * @param seconds - The time.
 * @returns The text.
 * @throws {never} Never.
 */
export function formatMotionTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * Scroll an item into a panel's scroller and nothing else: by the least distance, and not at all when it shows already.
 * @param viewport - The scroller.
 * @param item - The item.
 * @throws {never} Never.
 */
export function revealWithin(viewport: HTMLElement, item: HTMLElement): void {
  const view = viewport.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  const top = box.top < view.top ? viewport.scrollTop + box.top - view.top
    : box.bottom > view.bottom ? viewport.scrollTop + box.bottom - view.bottom : null;
  if (top !== null) viewport.scrollTo({ top, behavior: 'smooth' });
}

/** A panel's frame. */
interface MotionPanelProps {
  testId: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * A floating panel docked inside the Space on the right, above the bar (#1490 design §7.1); it stays open while the
 * user works elsewhere and closes from its X, its button again or Esc.
 * @param props - The panel.
 * @param props.testId - Its test hook.
 * @param props.title - Its heading.
 * @param props.onClose - Closes it.
 * @param props.children - Its content.
 * @returns The panel.
 * @throws {never} Never.
 */
export function MotionPanel({ testId, title, onClose, children }: MotionPanelProps): React.JSX.Element {
  const t = useTranslation();
  return <section data-testid={testId} className='absolute bottom-[4.5rem] right-3 top-3 z-10 flex w-80 flex-col overflow-hidden rounded-chrome border border-border bg-popover shadow'>
    <header className='flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3'>
      <h3 className='truncate text-sm font-semibold'>{title}</h3>
      <Button type='button' variant='ghost' size='compact' className='px-1' aria-label={t('spaces.webAnimation.closePanel')} onClick={onClose} icon={<X className='size-4' />} />
    </header>
    <div className='flex min-h-0 flex-1 flex-col'>{children}</div>
  </section>;
}

/** A preview that could not load. */
interface PreviewUnavailableProps {
  onRetry: () => void;
  /** Whether the retry is waiting for the server. */
  retrying?: boolean;
}

/**
 * What a Motion preview shows when it could not load (#1490 design §7.3): unavailable, and a retry. It fills the box it
 * is placed in.
 * @param props - The retry.
 * @param props.onRetry - Loads it again.
 * @param props.retrying - Whether the retry is waiting.
 * @returns The note.
 * @throws {never} Never.
 */
export function PreviewUnavailable({ onRetry, retrying = false }: PreviewUnavailableProps): React.JSX.Element {
  const t = useTranslation();
  return <div className='absolute inset-0 flex flex-wrap content-center items-center justify-center gap-x-2 gap-y-1 bg-muted p-1 text-xs text-foreground'>
    <span>{t('timeline.webAnimation.unavailable')}</span>
    <Button type='button' variant='outline' size='compact' loading={retrying} onClick={onRetry}>{t('timeline.retry')}</Button>
  </div>;
}

/** A finished create or modification. */
export type PlayableRow = Extract<WebAnimationRowView, { kind: 'web_animation_create' | 'web_animation_modify' }> & { resultSourceVersionId: string };

/**
 * Whether a row is a finished create or modification, whose result plays and takes annotations.
 * @param row - The row.
 * @returns True for one.
 * @throws {never} Never.
 */
export function playable(row: WebAnimationRowView | undefined): row is PlayableRow {
  return row !== undefined && row.kind !== 'web_animation_export' && row.status === 'succeeded' && row.resultSourceVersionId !== null;
}

/**
 * A row's length in whole seconds.
 * @param row - The row.
 * @returns The seconds.
 * @throws {never} Never.
 */
export function rowSeconds(row: WebAnimationRowView): number {
  if (row.kind !== 'web_animation_export') return row.input.durationSeconds;
  return Math.round(row.input.durationFrames * row.input.fps.den / row.input.fps.num);
}
