// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useCurrentUserStore } from '@web/stores';
import { useTranslation } from '@web/i18n/use-translation';

interface QuickAction {
  id: string;
  labelKey: 'findReference' | 'writeScript' | 'buildWorkflow' | 'annotateDocument' | 'writePrompt';
}

/**
 * One suggestion for each thing the line above them says the agent can do:
 * find material, write long text, propose a generation flow on the canvas,
 * propose edits to an open Document, and write prompts.
 */
const QUICK_ACTIONS: ReadonlyArray<QuickAction> = [
  { id: 'find-reference', labelKey: 'findReference' },
  { id: 'write-script', labelKey: 'writeScript' },
  { id: 'build-workflow', labelKey: 'buildWorkflow' },
  { id: 'annotate-document', labelKey: 'annotateDocument' },
  { id: 'write-prompt', labelKey: 'writePrompt' },
];

interface ChatEmptyProps {
  onQuickAction?: (label: string) => void;
  /**
   * The panel is on its way to another conversation.
   *
   * These write into the composer, and the composer is held still for that
   * window. Left live they would put their sentence into the conversation
   * being left behind, where the reader watches it vanish as the new one
   * lands.
   */
  frozen?: boolean;
}

/**
 * New conversation empty state — shown when the active conversation has
 * zero messages. Mirrors the chrome-baseline mock `chat-empty`:
 *
 *   Hi, <name>!                              ← bold foreground greeting
 *   I can find material, write articles …    ← muted line naming what it can do
 *   [Find …] [Write a script …] …            ← quick actions, see QUICK_ACTIONS
 *
 * Greeting uses the current user's name (`useCurrentUserStore`); falls
 * back to a plain greeting when unauthenticated (dev / pre-login). All
 * strings come from `chat.empty.*` so the surface localizes through
 * the LangSwitcher.
 * @param root0 - The component props.
 * @param root0.onQuickAction - Called with a quick-action label when one is picked.
 * @param root0.frozen - The panel is on its way to another conversation.
 * @returns The empty-conversation greeting, the line saying what the agent can do, and the quick-action buttons.
 */
export function ChatEmpty({
  onQuickAction,
  frozen = false,
}: ChatEmptyProps): React.JSX.Element {
  const t = useTranslation();
  const userName = useCurrentUserStore((s) => s.user?.name);
  const greeting = userName
    ? t('chat.empty.greetingWithName', { name: userName })
    : t('chat.empty.greetingDefault');

  return (
    <div
      data-testid='chat-empty'
      className='flex h-full flex-col items-center justify-center px-4 py-8 text-center text-sm leading-relaxed text-muted-foreground'
    >
      <strong className='mb-2 block text-foreground'>{greeting}</strong>
      <p className='leading-relaxed'>{t('chat.empty.capabilities')}</p>
      <div className='mt-4 flex flex-wrap items-center justify-center gap-2'>
        {QUICK_ACTIONS.map((qa) => {
          const label = t(`chat.empty.quick.${qa.labelKey}`);
          return (
            <Button
              key={qa.id}
              type='button'
              variant={null}
              size={null}
              disabled={frozen}
              onClick={() => onQuickAction?.(label)}
              className='flex h-[var(--btn-inline)] items-center rounded-full border border-border bg-transparent px-3 text-xs text-foreground transition-colors hover:bg-accent'
              data-testid={`chat-empty-qa-${qa.id}`}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
