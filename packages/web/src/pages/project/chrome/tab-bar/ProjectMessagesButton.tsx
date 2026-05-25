import { AlertTriangle, History, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { ProjectMessageEntry, ProjectRole } from '@breatic/shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useExclusiveOverlay } from '@/lib/use-exclusive-overlay';
import { useTranslation } from '@/i18n/use-translation';

/**
 * Project-wide message channel surfaced by the History clock icon on
 * the right of the tab bar. Backed by `meta.projectMessages` (Y.Array)
 * — replaces the legacy `SpaceHistoryButton` stub.
 *
 * Per ADR 2026-05-23 project-messages-channel: one channel, one kind
 * enum, single list with color dots — V1 skips the filter chips.
 *
 * Owner-only affordances (per ADR §B2.5 permissions matrix):
 *   - `Restore` button on each `space-deleted` entry → `space:restore` RPC
 *   - `Clear all` footer → `messages:clear { all: true }` RPC
 */
export interface ProjectMessagesButtonProps {
  messages: ReadonlyArray<ProjectMessageEntry>;
  /** Caller's role on the project. Drives owner-only affordances. */
  currentUserRole?: ProjectRole;
  /** Owner restore handler. Promise lets us show transient progress. */
  onRestore?: (spaceId: string) => Promise<void> | void;
  /** Owner clear-all handler. */
  onClearAll?: () => Promise<void> | void;
}

/**
 * Bucketed relative-time descriptor (key + ICU plural params).
 * Pure — returns the ICU message id to feed `t(rel.key, rel.params)`.
 */
export interface RelativeTime {
  key:
    | 'spaces.history.relative.justNow'
    | 'spaces.history.relative.minutesAgo'
    | 'spaces.history.relative.hoursAgo'
    | 'spaces.history.relative.yesterday'
    | 'spaces.history.relative.daysAgo'
    | 'spaces.history.relative.weeksAgo'
    | 'spaces.history.relative.monthsAgo'
    | 'spaces.history.relative.isoDate';
  params?: Record<string, string | number>;
}

function relativeTime(epochMs: number, now = Date.now()): RelativeTime {
  if (!Number.isFinite(epochMs))
    return {
      key: 'spaces.history.relative.isoDate',
      params: { date: String(epochMs) },
    };
  const diffMs = now - epochMs;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return { key: 'spaces.history.relative.justNow' };
  if (min < 60)
    return { key: 'spaces.history.relative.minutesAgo', params: { count: min } };
  const hr = Math.floor(min / 60);
  if (hr < 24)
    return { key: 'spaces.history.relative.hoursAgo', params: { count: hr } };
  if (hr < 48) return { key: 'spaces.history.relative.yesterday' };
  const day = Math.floor(hr / 24);
  if (day < 7)
    return { key: 'spaces.history.relative.daysAgo', params: { count: day } };
  if (day < 30)
    return {
      key: 'spaces.history.relative.weeksAgo',
      params: { count: Math.floor(day / 7) },
    };
  if (day < 365)
    return {
      key: 'spaces.history.relative.monthsAgo',
      params: { count: Math.floor(day / 30) },
    };
  return {
    key: 'spaces.history.relative.isoDate',
    params: { date: new Date(epochMs).toISOString().slice(0, 10) },
  };
}

/**
 * Color-dot palette per ADR project-messages-channel §kind colors.
 * Uses semantic status / accent tokens so dark / light mode both work.
 */
const KIND_DOT_CLASS: Record<ProjectMessageEntry['kind'], string> = {
  'missing-node': 'bg-status-warning-border',
  'space-created': 'bg-status-success-border',
  'space-deleted': 'bg-status-error-border',
  'space-locked': 'bg-status-info-border',
  'space-unlocked': 'bg-muted-foreground',
  'space-restored': 'bg-status-success-border',
};

const KIND_LABEL_KEY: Record<ProjectMessageEntry['kind'], string> = {
  'missing-node': 'spaces.history.kind.missingNode',
  'space-created': 'spaces.history.kind.spaceCreated',
  'space-deleted': 'spaces.history.kind.spaceDeleted',
  'space-locked': 'spaces.history.kind.spaceLocked',
  'space-unlocked': 'spaces.history.kind.spaceUnlocked',
  'space-restored': 'spaces.history.kind.spaceRestored',
};

export function ProjectMessagesButton({
  messages,
  currentUserRole,
  onRestore,
  onClearAll,
}: ProjectMessagesButtonProps) {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('project-messages');
  const isOwner = currentUserRole === 'owner';
  // Last 100 cap — older auditing belongs in a dedicated dashboard.
  const visible = messages.slice(-100).reverse();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const onClickRestore = async (spaceId: string) => {
    if (!onRestore) return;
    setBusyId(spaceId);
    try {
      await onRestore(spaceId);
    } finally {
      setBusyId(null);
    }
  };
  const onClickClear = async () => {
    if (!onClearAll) return;
    setClearing(true);
    try {
      await onClearAll();
    } finally {
      setClearing(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label={t('spaces.history.label')}
          title={t('spaces.history.title')}
          data-testid='project-messages-trigger'
          style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
        >
          <History className='h-[18px] w-[18px]' />
        </Button>
      </SheetTrigger>
      {/*
        side='right-floating' = same variant as SpaceDrawer (sits between
        TabBar and ViewportToolbar). Width 315px = 75 % of the prior
        Popover width (420 × 0.75), product-confirmed. Sheet primitive
        ships the top-right [X] close button by default.
      */}
      <SheetContent
        side='right-floating'
        className='w-[315px] p-0'
        data-testid='project-messages-sheet'
      >
        <header className='flex items-baseline justify-between gap-3 border-b border-border px-4 py-3 pr-12'>
          <div>
            <SheetTitle className='text-[14px] font-semibold text-foreground'>
              {t('spaces.history.header')}
            </SheetTitle>
            <SheetDescription className='text-[12px] text-muted-foreground'>
              {t('spaces.history.description', { count: messages.length })}
            </SheetDescription>
          </div>
          {isOwner && messages.length > 0 ? (
            <button
              type='button'
              onClick={onClickClear}
              disabled={clearing}
              data-testid='project-messages-clear-all'
              className='inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50'
            >
              <Trash2 className='h-3 w-3' aria-hidden />
              {t('spaces.history.action.clearAll')}
            </button>
          ) : null}
        </header>
        <ul
          className='flex max-h-[420px] flex-col overflow-y-auto'
          role='list'
          data-testid='project-messages-list'
        >
          {visible.length === 0 ? (
            <li className='px-4 py-3 text-[13px] text-muted-foreground'>
              {t('spaces.history.empty')}
            </li>
          ) : (
            visible.map((m) => {
              const rel = relativeTime(m.createdAt);
              const canRestore =
                isOwner && m.kind === 'space-deleted' && Boolean(m.spaceId);
              return (
                <li
                  key={m.id}
                  role='listitem'
                  data-testid={`project-messages-entry-${m.id}`}
                  className='flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0'
                >
                  <span
                    className={cn(
                      'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                      KIND_DOT_CLASS[m.kind],
                    )}
                    aria-hidden
                    data-testid={`project-messages-dot-${m.id}`}
                  />
                  {m.kind === 'missing-node' ? (
                    <AlertTriangle
                      className='mt-0.5 h-4 w-4 shrink-0 text-status-warning-foreground'
                      aria-hidden
                    />
                  ) : null}
                  <div className='flex min-w-0 flex-1 flex-col gap-1'>
                    <p className='text-[13px] leading-relaxed text-foreground'>
                      {m.message
                        ? t(m.message, m.context as Record<string, string | number> | undefined)
                        : t(KIND_LABEL_KEY[m.kind], {
                            spaceName: m.spaceName ?? '',
                            actor: m.actor ?? '',
                          })}
                    </p>
                    <p className='text-[11px] tabular-nums text-muted-foreground'>
                      {t(rel.key, rel.params)}
                      {m.spaceName ? ` · ${m.spaceName}` : ''}
                    </p>
                  </div>
                  {canRestore ? (
                    <button
                      type='button'
                      onClick={() => m.spaceId && onClickRestore(m.spaceId)}
                      disabled={busyId === m.spaceId}
                      data-testid={`project-messages-restore-${m.id}`}
                      className='mt-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-accent disabled:opacity-50'
                    >
                      <RotateCcw className='h-3 w-3' aria-hidden />
                      {t('spaces.history.action.restore')}
                    </button>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

export { relativeTime };
