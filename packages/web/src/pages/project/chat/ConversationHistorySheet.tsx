import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

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
 * Convert ISO timestamp to a localized relative time label
 * (`X 分钟前 / X 小时前 / 昨天 / X 天前 / X 周前 / X 月前`).
 * Falls back to ISO date when older than a year.
 */
function formatRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = now - t;
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

/**
 * Side sheet that lists the project's previous conversations.
 *
 * Layout (2026-05-21 spec):
 *   SESSION 列表                                            [X]
 *   ───────────────────────────────────────────────────────
 *   ●  主线剧情研究                       ← active row + dot
 *      我们讨论了赛博朋克设定和…
 *      5 分钟前
 *   ───────────────────────────────────────────────────────
 *   ○  角色性格设计
 *      林夏的成长弧线和动机…
 *      昨天
 *
 * Active state uses `bg-accent` row highlight + `bg-foreground` dot
 * (neutral, no brand) per ADR 14 brand-guard policy — Direction B
 * Tweaks ground truth: neutral-first, no brand-red accents in chrome.
 */
export function ConversationHistorySheet({
  open,
  onOpenChange,
  conversations,
  activeId,
  onPick,
}: ConversationHistorySheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='left-floating'
        className='w-80 p-0'
        data-testid='conversation-history-sheet'
      >
        <SheetHeader className='px-4 py-3'>
          <SheetTitle className='text-[13px] font-medium uppercase tracking-wide text-muted-foreground'>
            Session 列表
          </SheetTitle>
        </SheetHeader>
        <ul
          className='flex flex-col gap-px overflow-y-auto'
          data-testid='conversation-history-list'
          role='list'
        >
          {conversations.length === 0 ? (
            <li className='px-4 py-3 text-[13px] text-muted-foreground'>
              暂无历史会话
            </li>
          ) : (
            conversations.map((c) => {
              const isActive = c.id === activeId;
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
                        {formatRelative(c.updatedAt)}
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

export { formatRelative };
