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
 * How close to the bottom still counts as being at the bottom, in pixels.
 *
 * A reader parked at the end is never exactly at it — a partly scrolled last
 * line, a rounded-off device pixel — so an exact test would let go of the
 * bottom the moment anything moved. This is the usual size of that allowance
 * in a streaming chat column.
 */
const AT_BOTTOM_SLACK_PX = 64;

/**
 * Scrollable message column. Follows a reply as it is written, but only while
 * the reader is at the bottom: once they scroll up, the column stays where
 * they put it until they come back down. Renders `<ChatEmpty />` when there
 * are no messages yet (new conversation greeting + quick actions).
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
  // A streaming reply arrives as pieces appended to the message already at
  // the end, so the count sits still for the whole turn. Following its length
  // as well is what keeps the answer in view while it is being written.
  const lastLength = messages.at(-1)?.content.length ?? 0;
  React.useEffect(() => {
    const anchor = bottomRef.current;
    if (!anchor) return;

    // Only follow a reader who is already at the end. Scrolling them back
    // down on every token — which is what following unconditionally means —
    // makes the column unreadable for the whole turn, exactly when a long
    // answer is worth reading. Standard sticky-bottom behaviour.
    const viewport = anchor.closest('[data-radix-scroll-area-viewport]');
    if (viewport) {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distance > AT_BOTTOM_SLACK_PX) return;
    }

    anchor.scrollIntoView({ behavior: 'smooth' });
  }, [count, lastLength]);

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
