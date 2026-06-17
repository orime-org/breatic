// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { MessagesSquare, Plus } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';

import { TitleEditable } from '@web/pages/project/chrome/top-bar/TitleEditable';

interface AgentColHeaderProps {
  conversationName: string;
  messageCount: number;
  onOpenHistory: () => void;
  onNewConversation: () => void;
  onRenameConversation: (next: string) => void;
}

/**
 * Agent column header — sits above the ChatPanel:
 *   [💬 open history] [count chip] [conversation name (editable)] [+ new]
 *
 * Layout (2026-05-21 user spec, revised):
 *   - History trigger uses `MessagesSquare` icon (the mock's original
 *     glyph) — semantics "list of past conversations", which the user
 *     judged more accurate than `PanelLeftOpen` ("open a side panel")
 *     after seeing the first cut.
 *   - Count chip sits immediately to the right of the icon, NOT inside
 *     the title, so it visually pairs with the history action ("how many
 *     conversations behind that button").
 *   - Conversation name uses `TitleEditable` (same as TopBar project
 *     title) — click to edit, Enter / blur commit, Escape cancel.
 *
 * History sheet + composer state lives in the chat store; this header
 * just wires the triggers.
 * @param root0 - Component props.
 * @param root0.conversationName - Current conversation name shown in the editable title.
 * @param root0.messageCount - Number of past conversations displayed in the count chip.
 * @param root0.onOpenHistory - Opens the conversation history sheet.
 * @param root0.onNewConversation - Starts a new conversation.
 * @param root0.onRenameConversation - Commits a new conversation name when the title is edited.
 * @returns The agent column header row with history, count chip, editable title, and new-conversation actions.
 */
export function AgentColHeader({
  conversationName,
  messageCount,
  onOpenHistory,
  onNewConversation,
  onRenameConversation,
}: AgentColHeaderProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <header
      data-testid='agent-col-header'
      className='flex shrink-0 items-center border-b border-border bg-background'
      style={{ height: 40, padding: '0 var(--space-4)', gap: 'var(--space-2)' }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant='chrome-ghost'
            size='chrome'
            aria-label={t('chrome.tooltip.openHistory')}
            onClick={onOpenHistory}
            data-testid='open-conversation-history'
          >
            <MessagesSquare className='h-[18px] w-[18px]' />
          </Button>
        </TooltipTrigger>
        <TooltipContent side='bottom'>
          {t('chrome.tooltip.openHistory')}
        </TooltipContent>
      </Tooltip>
      <span
        className='inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-muted px-[6px] text-2xs font-medium tabular-nums text-muted-foreground'
        data-testid='conversation-count-chip'
        aria-label={t('chrome.aria.conversationCount', { count: messageCount })}
      >
        {messageCount}
      </span>
      <div className='flex min-w-0 flex-1 items-center'>
        <TitleEditable
          value={conversationName}
          onChange={onRenameConversation}
          maxWidth={180}
        />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant='chrome-ghost'
            size='chrome'
            aria-label={t('chrome.tooltip.newConversation')}
            onClick={onNewConversation}
            data-testid='new-conversation'
          >
            <Plus className='h-[18px] w-[18px]' />
          </Button>
        </TooltipTrigger>
        <TooltipContent side='bottom'>
          {t('chrome.tooltip.newConversation')}
        </TooltipContent>
      </Tooltip>
    </header>
  );
}
