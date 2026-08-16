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

import { CONVERSATION_TITLE_MAX_CHARS } from '@breatic/shared';
import { TitleEditable } from '@web/pages/project/chrome/top-bar/TitleEditable';

interface AgentColHeaderProps {
  conversationName: string;
  conversationNamePlaceholder: string;
  onOpenHistory: () => void;
  onNewConversation: () => void;
  onRenameConversation: (next: string) => void;
}

/**
 * Agent column header — sits above the ChatPanel:
 *   [💬 open history] [conversation name (editable)] [+ new]
 *
 * The history trigger uses `MessagesSquare` rather than `PanelLeftOpen`:
 * what is behind it is a list of past conversations, not a side panel.
 *
 * No count. How many conversations a project holds is not something a reader
 * needs to know -- what they need is which one they are in -- and the list is
 * paged, so the number held here would not be the total anyway.
 *
 * The name uses `TitleEditable`, the same box as the project title in the top
 * bar, with the length a conversation name may run to rather than the default
 * that box carries for project names.
 *
 * The name and the words shown while there is none travel separately, because
 * they are different things: a conversation with no name holds null, and the
 * sentence on screen is standing in for it. Handing the stand-in over as the
 * name would make "call it exactly that" read as a change to nothing.
 *
 * Which conversation is on screen, and the list to choose from, live in the
 * conversation runtime; the column above assembles them and this header just
 * wires the triggers.
 * @param root0 - Component props.
 * @param root0.conversationName - The conversation's own name, empty while it has none.
 * @param root0.conversationNamePlaceholder - What the title reads while the conversation has no name.
 * @param root0.onOpenHistory - Opens the conversation history sheet.
 * @param root0.onNewConversation - Starts a new conversation.
 * @param root0.onRenameConversation - Commits a new conversation name when the title is edited.
 * @returns The agent column header row with history, editable title, and new-conversation actions.
 */
export function AgentColHeader({
  conversationName,
  conversationNamePlaceholder,
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
      <div className='flex min-w-0 flex-1 items-center'>
        <TitleEditable
          value={conversationName}
          placeholder={conversationNamePlaceholder}
          onChange={onRenameConversation}
          maxWidth={180}
          maxLength={CONVERSATION_TITLE_MAX_CHARS}
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
