import { Image, Music, PenTool } from 'lucide-react';

import { useCurrentUserStore } from '@/stores';
import { useTranslation } from '@/i18n/use-translation';

interface QuickAction {
  id: string;
  icon: typeof Image;
  labelKey: 'image' | 'music' | 'writing';
}

const QUICK_ACTIONS: ReadonlyArray<QuickAction> = [
  { id: 'image', icon: Image, labelKey: 'image' },
  { id: 'music', icon: Music, labelKey: 'music' },
  { id: 'pen', icon: PenTool, labelKey: 'writing' },
];

interface ChatEmptyProps {
  onQuickAction?: (label: string) => void;
}

/**
 * New conversation empty state — shown when the active conversation has
 * zero messages. Mirrors mock `chat-empty` (finalized.html lines 599-626
 * + 1152-1160):
 *
 *   Hi, <name>!                              ← bold foreground greeting
 *   Try asking @ a node                      ← muted instruction
 *   Or type your prompt below ↓
 *   [🖼️ Generate a cyberpunk-style image]    ← stacked quick actions
 *   [🎵 Compose a lo-fi background track]
 *   [✏️ Write a product description]
 *
 * Greeting uses the current user's name (`useCurrentUserStore`); falls
 * back to a plain greeting when unauthenticated (dev / pre-login). All
 * strings come from `chat.empty.*` so the surface localizes through
 * the LangSwitcher.
 */
export function ChatEmpty({ onQuickAction }: ChatEmptyProps) {
  const t = useTranslation();
  const userName = useCurrentUserStore((s) => s.user?.name);
  const greeting = userName
    ? t('chat.empty.greetingWithName', { name: userName })
    : t('chat.empty.greetingDefault');

  return (
    <div
      data-testid='chat-empty'
      className='flex flex-col items-center px-4 py-8 text-center text-[13px] leading-relaxed text-muted-foreground'
    >
      <strong className='mb-2 block text-foreground'>{greeting}</strong>
      <p className='leading-relaxed'>
        {t('chat.empty.hintNodes')}
        <br />
        {t('chat.empty.hintDirect')}
      </p>
      <div className='mt-4 flex w-full flex-col gap-1.5'>
        {QUICK_ACTIONS.map((qa) => {
          const Icon = qa.icon;
          const label = t(`chat.empty.quick.${qa.labelKey}`);
          return (
            <button
              key={qa.id}
              type='button'
              onClick={() => onQuickAction?.(label)}
              className='flex items-center gap-2 rounded-md border border-border bg-transparent px-3 py-2 text-left text-[12px] text-foreground transition-colors hover:bg-accent'
              data-testid={`chat-empty-qa-${qa.id}`}
            >
              <Icon className='h-4 w-4 shrink-0 text-muted-foreground' />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
