import { Image, Music, PenTool } from 'lucide-react';

import { useCurrentUserStore } from '@/stores';

interface QuickAction {
  id: string;
  icon: typeof Image;
  label: string;
}

const QUICK_ACTIONS: ReadonlyArray<QuickAction> = [
  { id: 'image', icon: Image, label: '生成一张赛博朋克风格图' },
  { id: 'music', icon: Music, label: '配一段 lo-fi 背景音乐' },
  { id: 'pen', icon: PenTool, label: '帮我写一段产品描述' },
];

interface ChatEmptyProps {
  onQuickAction?: (label: string) => void;
}

/**
 * New conversation empty state — shown when the active conversation has
 * zero messages. Mirrors mock `chat-empty` (finalized.html lines 599-626
 * + 1152-1160):
 *
 *   嗨, <name>!                              ← bold foreground greeting
 *   试试 @ 节点提问                          ← muted instruction
 *   或直接在下方输入对话 ↓
 *   [🖼️ 生成一张赛博朋克风格图]              ← stacked quick actions
 *   [🎵 配一段 lo-fi 背景音乐]
 *   [✏️ 帮我写一段产品描述]
 *
 * Greeting uses the current user's name (`useCurrentUserStore`); falls
 * back to a plain "嗨!" when unauthenticated (dev / pre-login).
 */
export function ChatEmpty({ onQuickAction }: ChatEmptyProps) {
  const userName = useCurrentUserStore((s) => s.user?.name);
  const greeting = userName ? `嗨, ${userName}!` : '嗨!';

  return (
    <div
      data-testid='chat-empty'
      className='flex flex-col items-center px-4 py-8 text-center text-[13px] leading-relaxed text-muted-foreground'
    >
      <strong className='mb-2 block text-foreground'>{greeting}</strong>
      <p className='leading-relaxed'>
        试试 @ 节点提问
        <br />
        或直接在下方输入对话 ↓
      </p>
      <div className='mt-4 flex w-full flex-col gap-1.5'>
        {QUICK_ACTIONS.map((qa) => {
          const Icon = qa.icon;
          return (
            <button
              key={qa.id}
              type='button'
              onClick={() => onQuickAction?.(qa.label)}
              className='flex items-center gap-2 rounded-md border border-border bg-transparent px-3 py-2 text-left text-[12px] text-foreground transition-colors hover:bg-accent'
              data-testid={`chat-empty-qa-${qa.id}`}
            >
              <Icon className='h-4 w-4 shrink-0 text-muted-foreground' />
              <span>{qa.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
