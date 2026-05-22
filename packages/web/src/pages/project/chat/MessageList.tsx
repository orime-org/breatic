import * as React from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';

import { ChatEmpty } from '@/pages/project/chat/ChatEmpty';
import { MessageBubble } from '@/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@/pages/project/chat/types';

interface MessageListProps {
  messages: ReadonlyArray<ChatMessage>;
  onQuickAction?: (label: string) => void;
}

/**
 * Scrollable message column. Auto-scrolls to the bottom whenever the
 * message count grows so the user follows along with the assistant's
 * streaming output. Renders `<ChatEmpty />` when there are no messages
 * yet (new conversation greeting + quick actions).
 */
export function MessageList({ messages, onQuickAction }: MessageListProps) {
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const count = messages.length;
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [count]);

  return (
    <ScrollArea className='flex-1' data-testid='message-list'>
      {count === 0 ? (
        <ChatEmpty onQuickAction={onQuickAction} />
      ) : (
        <div className='flex flex-col gap-2 p-3'>
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </ScrollArea>
  );
}
