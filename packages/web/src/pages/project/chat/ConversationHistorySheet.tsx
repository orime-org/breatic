import type * as React from 'react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@web/components/ui/sheet';
import { useTranslation } from '@web/i18n/use-translation';

export interface ConversationSummary {
  id: string;
  name: string;
  /** 1-line preview of the most recent agent / user turn. */
  preview?: string;
  /** ISO timestamp of the latest message (used to compute relative time). */
  updatedAt: string;
  messageCount: number;
}

interface ConversationHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: ReadonlyArray<ConversationSummary>;
  activeId?: string;
  onPick: (id: string) => void;
}

/**
 * Bucket of the relative timestamp + the params needed for an ICU
 * MessageFormat plural string. Pure — no React, no `t()` call — so
 * the buckets can be tested without an i18n runtime.
 */
export interface RelativeTime {
  key:
    | 'chat.relative.justNow'
    | 'chat.relative.minutesAgo'
    | 'chat.relative.hoursAgo'
    | 'chat.relative.yesterday'
    | 'chat.relative.daysAgo'
    | 'chat.relative.weeksAgo'
    | 'chat.relative.monthsAgo'
    | 'chat.relative.isoDate';
  params?: Record<string, string | number>;
}

/**
 * Bucket an ISO timestamp into a relative-time key + params, so callers
 * can `t(rel.key, rel.params)` to render the localized label. Falls back
 * to ISO date when the timestamp is older than a year (or unparseable).
 * @param iso - The ISO timestamp of the latest message.
 * @param now - The reference "now" epoch in ms (defaults to current time).
 * @returns The relative-time key plus optional ICU plural params.
 */
function relativeTime(iso: string, now = Date.now()): RelativeTime {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return { key: 'chat.relative.isoDate', params: { date: iso } };
  const diffMs = now - parsed;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return { key: 'chat.relative.justNow' };
  if (min < 60) return { key: 'chat.relative.minutesAgo', params: { count: min } };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { key: 'chat.relative.hoursAgo', params: { count: hr } };
  if (hr < 48) return { key: 'chat.relative.yesterday' };
  const day = Math.floor(hr / 24);
  if (day < 7) return { key: 'chat.relative.daysAgo', params: { count: day } };
  if (day < 30) return { key: 'chat.relative.weeksAgo', params: { count: Math.floor(day / 7) } };
  if (day < 365) return { key: 'chat.relative.monthsAgo', params: { count: Math.floor(day / 30) } };
  return {
    key: 'chat.relative.isoDate',
    params: { date: new Date(parsed).toISOString().slice(0, 10) },
  };
}

/**
 * Side sheet that lists the project's previous conversations.
 *
 * Layout (2026-05-21 spec):
 *   SESSION list                                            [X]
 *   ───────────────────────────────────────────────────────
 *   ●  Main plot research                  ← active row + dot
 *      We discussed cyberpunk setting and…
 *      5 minutes ago
 *   ───────────────────────────────────────────────────────
 *   ○  Character design
 *      Lin Xia's growth arc and motives…
 *      yesterday
 *
 * Active state uses `bg-accent` row highlight + `bg-foreground` dot
 * (neutral, no brand) per ADR 14 brand-guard policy — Direction B
 * Tweaks ground truth: neutral-first, no brand-red accents in chrome.
 * @param root0 - The component props.
 * @param root0.open - Whether the history sheet is open.
 * @param root0.onOpenChange - Called with the next open state when the sheet toggles.
 * @param root0.conversations - The conversation summaries to list.
 * @param root0.activeId - The id of the currently active conversation, if any.
 * @param root0.onPick - Called with a conversation id when a row is selected.
 * @returns The left-side sheet listing the project's previous conversations.
 */
export function ConversationHistorySheet({
  open,
  onOpenChange,
  conversations,
  activeId,
  onPick,
}: ConversationHistorySheetProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='left-floating'
        className='w-80 p-0'
        data-testid='conversation-history-sheet'
      >
        <SheetHeader className='px-4 py-3'>
          <SheetTitle className='text-[13px] font-medium uppercase tracking-wide text-muted-foreground'>
            {t('chat.history.title')}
          </SheetTitle>
          <SheetDescription className='sr-only'>
            {t('chat.history.description')}
          </SheetDescription>
        </SheetHeader>
        <ul
          className='flex flex-col gap-px overflow-y-auto'
          data-testid='conversation-history-list'
          role='list'
        >
          {conversations.length === 0 ? (
            <li className='px-4 py-3 text-[13px] text-muted-foreground'>
              {t('chat.history.empty')}
            </li>
          ) : (
            conversations.map((c) => {
              const isActive = c.id === activeId;
              const rel = relativeTime(c.updatedAt);
              return (
                <li key={c.id} role='listitem'>
                  <button
                    type='button'
                    onClick={() => onPick(c.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-accent ${
                      isActive ? 'bg-accent' : ''
                    }`}
                    data-testid={`conversation-${c.id}`}
                  >
                    <span
                      aria-hidden
                      className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${
                        isActive ? 'bg-foreground' : 'bg-muted-foreground/40'
                      }`}
                    />
                    <span className='flex min-w-0 flex-1 flex-col gap-1'>
                      <span className='truncate text-[14px] font-semibold text-foreground'>
                        {c.name}
                      </span>
                      {c.preview ? (
                        <span className='truncate text-[12px] text-muted-foreground'>
                          {c.preview}
                        </span>
                      ) : null}
                      <span className='text-[11px] tabular-nums text-muted-foreground'>
                        {t(rel.key, rel.params)}
                      </span>
                    </span>
                  </button>
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
