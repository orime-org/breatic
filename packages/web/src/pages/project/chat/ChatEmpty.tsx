// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Images, PencilLine, Sparkles } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useCurrentUserStore } from '@web/stores';
import { useTranslation } from '@web/i18n/use-translation';

interface QuickAction {
  id: string;
  icon: typeof Images;
  labelKey: 'findReference' | 'writePrompt' | 'refinePrompt';
}

/**
 * What the agent is for, said as three things a user can click.
 *
 * They follow the two lines the product is built around: gathering material,
 * and writing the prompts that turn it into something. Generating the image
 * itself is not among them — that happens on the canvas, and an agent that
 * offers to do it here is offering something it does not do.
 */
const QUICK_ACTIONS: ReadonlyArray<QuickAction> = [
  { id: 'find-reference', icon: Images, labelKey: 'findReference' },
  { id: 'write-prompt', icon: Sparkles, labelKey: 'writePrompt' },
  { id: 'refine-prompt', icon: PencilLine, labelKey: 'refinePrompt' },
];

interface ChatEmptyProps {
  onQuickAction?: (label: string) => void;
}

/**
 * New conversation empty state — shown when the active conversation has
 * zero messages. Mirrors the chrome-baseline mock `chat-empty`:
 *
 *   Hi, <name>!                              ← bold foreground greeting
 *   Try asking @ a node                      ← muted instruction
 *   Or type your prompt below ↓
 *   [🖼️ Find me a reference]                 ← stacked quick actions,
 *   [✨ Write a prompt for this]                see QUICK_ACTIONS above
 *   [✏️ Refine this prompt]
 *
 * Greeting uses the current user's name (`useCurrentUserStore`); falls
 * back to a plain greeting when unauthenticated (dev / pre-login). All
 * strings come from `chat.empty.*` so the surface localizes through
 * the LangSwitcher.
 * @param root0 - The component props.
 * @param root0.onQuickAction - Called with a quick-action label when one is picked.
 * @returns The empty-conversation greeting with stacked quick-action buttons.
 */
export function ChatEmpty({
  onQuickAction,
}: ChatEmptyProps): React.JSX.Element {
  const t = useTranslation();
  const userName = useCurrentUserStore((s) => s.user?.name);
  const greeting = userName
    ? t('chat.empty.greetingWithName', { name: userName })
    : t('chat.empty.greetingDefault');

  return (
    <div
      data-testid='chat-empty'
      className='flex flex-col items-center px-4 py-8 text-center text-sm leading-relaxed text-muted-foreground'
    >
      <strong className='mb-2 block text-foreground'>{greeting}</strong>
      <p className='leading-relaxed'>{t('chat.empty.hintDirect')}</p>
      <div className='mt-4 flex w-full flex-col gap-1.5'>
        {QUICK_ACTIONS.map((qa) => {
          const Icon = qa.icon;
          const label = t(`chat.empty.quick.${qa.labelKey}`);
          return (
            <Button
              key={qa.id}
              type='button'
              variant={null}
              size={null}
              onClick={() => onQuickAction?.(label)}
              className='flex items-center gap-2 rounded-md border border-border bg-transparent px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent'
              data-testid={`chat-empty-qa-${qa.id}`}
            >
              <Icon className='h-4 w-4 shrink-0 text-muted-foreground' />
              <span>{label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
