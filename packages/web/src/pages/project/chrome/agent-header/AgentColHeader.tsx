import { History, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface AgentColHeaderProps {
  conversationName: string;
  messageCount: number;
  onOpenHistory: () => void;
  onNewConversation: () => void;
}

/**
 * Agent column header — sits above the ChatPanel:
 *   [☰ history] · [conversation name + message chip] · [+ new conversation]
 *
 * History sheet + composer state lives in the chat store; this header
 * just wires the triggers.
 */
export function AgentColHeader({
  conversationName,
  messageCount,
  onOpenHistory,
  onNewConversation,
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
      >
        <History className='h-[18px] w-[18px]' />
      </Button>
      <div className='flex min-w-0 flex-1 items-center gap-2'>
        <span className='truncate text-sm font-medium'>
          {conversationName}
        </span>
        <span
          className='shrink-0 rounded-full bg-muted px-2 py-[1px] text-[10px] text-muted-foreground tabular-nums'
          data-testid='message-chip'
        >
          {messageCount}
        </span>
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
