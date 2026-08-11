// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';

interface MessageListProps {
  messages: ReadonlyArray<ChatMessage>;
  /**
   * The conversation has not arrived yet.
   *
   * Different from having no messages: an empty chat invites the user to
   * start one, and showing that over a conversation still on its way makes
   * their own history flash past as if it were not there.
   */
  loading?: boolean;
  onQuickAction?: (label: string) => void;
}

/**
 * Scrollable message column. Auto-scrolls to the bottom whenever the
 * message count grows so the user follows along with the assistant's
 * streaming output. Renders `<ChatEmpty />` when there are no messages
 * yet (new conversation greeting + quick actions).
 * @param root0 - The component props.
 * @param root0.messages - The messages to render in order.
 * @param root0.loading - The conversation has not arrived yet.
 * @param root0.onQuickAction - Called with a quick-action label from the empty state.
 * @returns The scrollable message column, or the empty-conversation state.
 */
export function MessageList({
  messages,
  loading = false,
  onQuickAction,
}: MessageListProps): React.JSX.Element {
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const count = messages.length;
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [count]);

  return (
    <ScrollArea className='min-h-0 flex-1' data-testid='message-list'>
      {loading ? null : count === 0 ? (
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
