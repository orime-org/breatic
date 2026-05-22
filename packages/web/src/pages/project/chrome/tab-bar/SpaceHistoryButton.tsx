import { AlertTriangle, History } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SpaceActivityEvent {
  id: string;
  /** Human-readable event sentence (e.g. "Yuki Jia 删除了 BGM 的节点 n42"). */
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
 * Space activity history — chrome-baseline `.bell-dot` button on the
 * right side of the space header. Shows project-shared data events
 * (create / delete / lock / missing-node) per user spec image 44.
 *
 * Popover anatomy:
 *
 *   系统消息
 *   3 条 · 项目共享数据的事件记录
 *   ──────────────────────────────────────
 *   ⚠️  Yuki Jia 删除了 BGM 的节点 n42 · Marie 半身像  ☐
 *       1 天前 · missing-node · BGM Exploration
 *   ⚠️  Cyberpunk Concept 的节点 n17 已不存在...      ☐
 *       1 天前 · missing-node · Cyberpunk Concept
 *
 * PR scope: chrome shell + stub events; the real feed lands when the
 * backend space-events stream is wired (BUG-XXX or follow-up PR).
 */
export function SpaceHistoryButton({
  events = [],
  hasUnread,
  onMarkRead,
}: SpaceHistoryButtonProps) {
  const totalUnread = hasUnread ?? events.some((e) => e.unread);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label='Space 活动历史'
          title='Space 创建 / 删除 / 锁定历史'
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
            系统消息
          </h3>
          <p className='text-[12px] text-muted-foreground'>
            {events.length} 条 · 项目共享数据的事件记录
          </p>
        </header>
        <ul
          className='flex max-h-[420px] flex-col overflow-y-auto'
          role='list'
          data-testid='space-history-list'
        >
          {events.length === 0 ? (
            <li className='px-4 py-3 text-[13px] text-muted-foreground'>
              暂无空间活动。创建 / 删除 / 锁定事件会显示在这里。
            </li>
          ) : (
            events.map((evt) => (
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
                    {formatRelativeTime(evt.occurredAt)} · {evt.tag} ·{' '}
                    {evt.spaceName}
                  </p>
                </div>
                <button
                  type='button'
                  role='checkbox'
                  aria-checked={!evt.unread}
                  aria-label={evt.unread ? '标为已读' : '已读'}
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
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  if (hr < 48) return '昨天';
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  if (day < 30) return `${Math.floor(day / 7)} 周前`;
  if (day < 365) return `${Math.floor(day / 30)} 月前`;
  return new Date(t).toISOString().slice(0, 10);
}
