// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';

interface MessageListProps {
  messages: ReadonlyArray<ChatMessage>;
  onQuickAction?: (label: string) => void;
}

/**
 * Scrollable message column. Auto-scrolls to the bottom whenever the
 * message count grows so the user follows along with the assistant's
 * streaming output. Renders `<ChatEmpty />` when there are no messages
 * yet (new conversation greeting + quick actions).
 * @param root0 - The component props.
 * @param root0.messages - The messages to render in order.
 * @param root0.onQuickAction - Called with a quick-action label from the empty state.
 * @returns The scrollable message column, or the empty-conversation state.
 */
export function MessageList({
  messages,
  onQuickAction,
}: MessageListProps): React.JSX.Element {
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const count = messages.length;
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [count]);

  return (
    // Native scroller (#1773, user-ratified 2026-07-15): every scrollbar in
    // the app is the native thin overlay styled by the global rules in
    // index.css — one look repo-wide (this previously rendered a Radix
    // ScrollArea bar that looked different from the native bars elsewhere).
    <div className='min-h-0 flex-1 overflow-y-auto' data-testid='message-list'>
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
    </div>
  );
}
