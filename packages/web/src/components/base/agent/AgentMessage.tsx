import React, { memo } from 'react';
import { cn } from '@/utils/classnames';

export type AgentMessageRole = 'user' | 'assistant';

type AgentMessageProps = {
  role: AgentMessageRole;
  content: React.ReactNode;
  senderName?: string;
  className?: string;
};

const AgentMessageComponent: React.FC<AgentMessageProps> = ({
  role,
  content,
  senderName,
  className,
}) => {
  const isUser = role === 'user';

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start', className)}>
      <div className={cn('flex max-w-[80%] min-w-0 flex-col', isUser ? 'items-end' : 'items-start')}>
        {senderName ? (
          <span className='mb-1 px-0.5 text-xs text-[var(--color-text-default-secondary)]'>{senderName}</span>
        ) : null}
        <div
          className={cn(
            'min-w-0 break-words rounded-xl px-3 py-2 text-sm leading-relaxed text-[var(--color-text-default-base)]',
            'bg-background-default-base',
            isUser ? 'rounded-tr-none' : 'rounded-tl-none'
          )}
        >
          {content}
        </div>
      </div>
    </div>
  );
};

const AgentMessage = memo(AgentMessageComponent);
export default AgentMessage;
