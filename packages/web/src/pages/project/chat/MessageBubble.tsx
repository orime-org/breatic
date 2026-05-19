import { cn } from '@/lib/utils';

import { ThinkingFold } from './ThinkingFold';
import { ToolCallCard } from './ToolCallCard';
import type { ChatMessage } from './types';

interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Renders one message in the chat list. Layout flips left/right based on
 * role; thinking + tool calls nest inside the bubble so they share the
 * bubble's column.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  return (
    <div
      data-testid='message-bubble'
      data-role={message.role}
      className={cn(
        'flex w-full',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground',
        )}
      >
        {message.thinking ? (
          <ThinkingFold thinking={message.thinking} />
        ) : null}
        <div
          className='whitespace-pre-wrap'
          data-testid='message-bubble-content'
        >
          {message.content}
          {message.streaming ? (
            <span aria-label='streaming' className='ml-1 animate-pulse'>
              ▌
            </span>
          ) : null}
        </div>
        {message.toolCalls?.map((tc) => (
          <ToolCallCard key={tc.id} toolCall={tc} />
        ))}
      </div>
    </div>
  );
}
