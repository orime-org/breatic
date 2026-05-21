import { MessagesSquare, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { TitleEditable } from '@/pages/project/chrome/top-bar/TitleEditable';

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
 */
export function AgentColHeader({
  conversationName,
  messageCount,
  onOpenHistory,
  onNewConversation,
  onRenameConversation,
}: AgentColHeaderProps) {
  return (
    <header
      data-testid='agent-col-header'
      className='flex shrink-0 items-center border-b border-border bg-background'
      style={{ height: 40, padding: '0 var(--space-4)', gap: 'var(--space-2)' }}
    >
      <Button
        variant='chrome-ghost'
        size='chrome'
        aria-label='Open conversation history'
        onClick={onOpenHistory}
        data-testid='open-conversation-history'
      >
        <MessagesSquare className='h-[18px] w-[18px]' />
      </Button>
      <span
        className='inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-muted px-[6px] text-[11px] font-medium tabular-nums text-muted-foreground'
        data-testid='conversation-count-chip'
        aria-label={`${messageCount} conversations`}
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
      <Button
        variant='chrome-ghost'
        size='chrome'
        aria-label='New conversation'
        onClick={onNewConversation}
        data-testid='new-conversation'
      >
        <Plus className='h-[18px] w-[18px]' />
      </Button>
    </header>
  );
}
