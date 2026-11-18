// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The pieces the Motion Space's bar and panels are built from: an icon button named by its tooltip, the panel that
 * docks inside the Space on the right, and how one row is titled and summed up.
 */

import * as React from 'react';
import { X } from 'lucide-react';
import { getLocale } from '@breatic/shared';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { CountChip } from '@web/components/CountChip';
import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { phaseKey } from '@web/spaces/web-animation/execution-text';
import { webAnimationTitle } from '@web/spaces/web-animation/web-animation-title';

/** One icon button of the bar. */
interface BarButtonProps {
  testId: string;
  label: string;
  icon: React.ReactElement<{ className?: string }>;
  onClick?: () => void;
  /** Set for a switch: whether it is on. */
  pressed?: boolean;
  /** A count shown at its top right; zero shows none. */
  count?: number;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * An icon-only button of the Motion bar, named by its tooltip (#1490 design §7.1).
 * @param props - The button.
 * @param props.testId - Its test hook.
 * @param props.label - Its name, shown on hover.
 * @param props.icon - Its icon.
 * @param props.onClick - What it does.
 * @param props.pressed - Whether it is on, for a switch.
 * @param props.count - A count at its top right.
 * @param props.disabled - Whether it is unavailable.
 * @param props.loading - Whether its press is waiting.
 * @returns The button.
 * @throws {never} Never.
 */
export const BarButton = React.memo(React.forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton(
  { testId, label, icon, onClick, pressed, count = 0, disabled = false, loading = false, ...rest },
  ref,
): React.JSX.Element {
  return <Tooltip>
    <TooltipTrigger asChild>
      <span className='relative inline-flex'>
        <Button ref={ref} {...rest} data-testid={testId} type='button' variant='ghost' size='icon' aria-label={label} aria-pressed={pressed} disabled={disabled} loading={loading}
          onClick={onClick} icon={icon} className='size-8 aria-pressed:bg-accent-strong aria-pressed:hover-enabled:bg-accent-strong' />
        {count > 0 && <CountChip count={count} className='pointer-events-none absolute -right-1.5 -top-1.5 min-w-[18px] text-center text-2xs' />}
      </span>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}));

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
  return <section data-testid={testId} className='absolute bottom-[4.5rem] right-3 top-3 z-10 flex w-80 flex-col overflow-hidden rounded-chrome border border-border bg-card shadow-md'>
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
 * The aspect of a row's frame, as the creation dialog names it, or its pixel size for an export.
 * @param row - The row.
 * @returns The text.
 * @throws {never} Never.
 */
export function rowFrame(row: WebAnimationRowView): string {
  return row.kind === 'web_animation_export' ? `${row.input.width}×${row.input.height}` : row.input.aspect;
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

/**
 * A row's summary line: frame, length, status and phase, and when it was made.
 * @param row - The row.
 * @param t - The translator.
 * @returns The line.
 * @throws {never} Never.
 */
export function rowSummary(row: WebAnimationRowView, t: (key: string, params?: Record<string, string | number>) => string): string {
  const status = t(`timeline.webAnimation.status.${row.status}`);
  const phase = row.status === 'running' && row.phase !== null ? ` · ${t(phaseKey(row.kind, row.phase))}` : '';
  const made = new Date(row.createdAt).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${rowFrame(row)} · ${t('timeline.webAnimation.durationShort', { seconds: rowSeconds(row) })} · ${status}${phase} · ${made}`;
}

/** One list row. */
interface MotionRowProps {
  row: WebAnimationRowView;
  selected: boolean;
  onPick: (row: WebAnimationRowView) => void;
}

/**
 * One execution in the list: its title and summary; a press opens it in the preview.
 * @param props - The row.
 * @param props.row - The execution.
 * @param props.selected - Whether the preview shows it.
 * @param props.onPick - Opens it.
 * @returns The row.
 * @throws {never} Never.
 */
export const MotionRow = React.memo(function MotionRow({ row, selected, onPick }: MotionRowProps): React.JSX.Element {
  const t = useTranslation();
  const pick = React.useCallback((): void => onPick(row), [onPick, row]);
  return <Button type='button' variant={null} size={null} data-testid={`motion-row-${row.id}`} aria-current={selected || undefined} onClick={pick}
    className={cn('group/row flex w-full min-w-0 flex-col items-stretch gap-0.5 border-b border-border px-3 py-2 text-left hover-enabled:bg-accent', selected && 'bg-accent-strong hover-enabled:bg-accent-strong')}>
    <span className='truncate text-xs font-medium'>{webAnimationTitle(row, t)}</span>
    <span className={cn('truncate text-2xs', selected ? 'text-row-foreground-muted' : 'text-muted-foreground group-hover/row:text-row-foreground-muted')}>{rowSummary(row, t)}</span>
  </Button>;
});
