import { AlertTriangle, History } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/use-translation';

export interface SpaceActivityEvent {
  id: string;
  /** Human-readable event sentence (e.g. "Yuki Jia deleted BGM node n42"). */
  message: string;
  /** ISO timestamp for relative time display. */
  occurredAt: string;
  /** Short tag (e.g. `missing-node`, `space-deleted`). */
  tag: string;
  /** Space name the event affected, for context. */
  spaceName: string;
  /** Whether this event is still unread for the current user. */
  unread: boolean;
}

interface SpaceHistoryButtonProps {
  events?: ReadonlyArray<SpaceActivityEvent>;
  /** True if any event is unread — drives the bell-dot indicator. */
  hasUnread?: boolean;
  onMarkRead?: (id: string) => void;
}

/**
 * Bucket of the relative timestamp + the params needed for an ICU
 * MessageFormat plural string. Pure — no React, no `t()` call — so
 * the buckets can be tested without an i18n runtime.
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

/**
 * Bucket an ISO timestamp into a relative-time key + params so callers
 * can `t(rel.key, rel.params)` to render the localized label. Falls back
 * to ISO date when the timestamp is older than a year (or unparseable).
 */
function relativeTime(iso: string, now = Date.now()): RelativeTime {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed))
    return { key: 'spaces.history.relative.isoDate', params: { date: iso } };
  const diffMs = now - parsed;
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
    params: { date: new Date(parsed).toISOString().slice(0, 10) },
  };
}

/**
 * Space activity history — chrome-baseline `.bell-dot` button on the
 * right side of the space header. Shows project-shared data events
 * (create / delete / lock / missing-node) per user spec image 44.
 *
 * Popover anatomy:
 *   - header: title + count line
 *   - list rows: warning icon + message + relative time + tag + space name
 *   - mark-read checkbox on the right of each row
 *
 * PR scope: chrome shell + stub events; the real feed lands when the
 * backend space-events stream is wired (BUG-XXX or follow-up PR).
 */
export function SpaceHistoryButton({
  events = [],
  hasUnread,
  onMarkRead,
}: SpaceHistoryButtonProps) {
  const t = useTranslation();
  const totalUnread = hasUnread ?? events.some((e) => e.unread);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label={t('spaces.history.label')}
          title={t('spaces.history.title')}
          data-testid='space-history-trigger'
          className='relative'
          style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
        >
          <History className='h-[18px] w-[18px]' />
          {totalUnread ? (
            <span
              className='absolute rounded-full bg-status-error-border'
              style={{ top: 5, right: 5, width: 6, height: 6 }}
              data-testid='space-history-unread-dot'
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-[360px] p-0'
        data-testid='space-history-popover'
      >
        <header className='border-b border-border px-4 py-3'>
          <h3 className='text-[14px] font-semibold text-foreground'>
            {t('spaces.history.header')}
          </h3>
          <p className='text-[12px] text-muted-foreground'>
            {t('spaces.history.description', { count: events.length })}
          </p>
        </header>
        <ul
          className='flex max-h-[420px] flex-col overflow-y-auto'
          role='list'
          data-testid='space-history-list'
        >
          {events.length === 0 ? (
            <li className='px-4 py-3 text-[13px] text-muted-foreground'>
              {t('spaces.history.empty')}
            </li>
          ) : (
            events.map((evt) => {
              const rel = relativeTime(evt.occurredAt);
              return (
                <li
                  key={evt.id}
                  role='listitem'
                  data-testid={`space-history-event-${evt.id}`}
                  className={cn(
                    'flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0',
                    evt.unread && 'bg-accent/40',
                  )}
                >
                  <AlertTriangle
                    className='mt-0.5 h-4 w-4 shrink-0 text-status-warning-foreground'
                    aria-hidden
                  />
                  <div className='flex min-w-0 flex-1 flex-col gap-1'>
                    <p className='text-[13px] leading-relaxed text-foreground'>
                      {evt.message}
                    </p>
                    <p className='text-[11px] tabular-nums text-muted-foreground'>
                      {t(rel.key, rel.params)} · {evt.tag} · {evt.spaceName}
                    </p>
                  </div>
                  <button
                    type='button'
                    role='checkbox'
                    aria-checked={!evt.unread}
                    aria-label={
                      evt.unread
                        ? t('spaces.history.markUnread')
                        : t('spaces.history.markRead')
                    }
                    onClick={() => evt.unread && onMarkRead?.(evt.id)}
                    data-testid={`space-history-mark-read-${evt.id}`}
                    className={cn(
                      'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
                      evt.unread
                        ? 'border-border bg-transparent hover:border-foreground'
                        : 'border-foreground bg-foreground text-background',
                    )}
                  >
                    {!evt.unread ? (
                      <svg
                        viewBox='0 0 12 12'
                        className='h-3 w-3'
                        aria-hidden
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                      >
                        <path d='M2 6l2.5 2.5L10 3' strokeLinecap='round' />
                      </svg>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export { relativeTime };
