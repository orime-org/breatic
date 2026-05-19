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
      className='flex h-10 items-center gap-1 border-b border-border bg-background px-2'
    >
      <Button
        variant='ghost'
        size='icon'
        aria-label='Open conversation history'
        onClick={onOpenHistory}
      >
        <History className='h-4 w-4' />
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
        variant='ghost'
        size='icon'
        aria-label='New conversation'
        onClick={onNewConversation}
        data-testid='new-conversation'
      >
        <Plus className='h-4 w-4' />
      </Button>
    </header>
  );
}
