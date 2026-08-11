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
  // Whether the reader was at the end last time they moved. Recorded as they
  // scroll rather than measured when new content arrives, because by then the
  // content has already made the column taller and there is no way left to
  // tell "the reader scrolled away" from "the reply grew". Measuring after
  // the fact reads a reader who never moved as one who left, and since the
  // gap only widens from there, following never starts again for that turn.
  const stickToBottom = React.useRef(true);
  const count = messages.length;
  // A streaming reply arrives as pieces appended to the message already at
  // the end, so the count sits still for the whole turn. Following its length
  // as well is what keeps the answer in view while it is being written.
  const lastLength = messages.at(-1)?.content.length ?? 0;

  React.useEffect(() => {
    const viewport = bottomRef.current?.closest('[data-radix-scroll-area-viewport]');
    if (!viewport) return;

    /** Record where the reader put themselves, while it is still true. */
    const remember = (): void => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottom.current = distance <= AT_BOTTOM_SLACK_PX;
    };

    viewport.addEventListener('scroll', remember, { passive: true });
    return () => viewport.removeEventListener('scroll', remember);
    // The anchor only exists once there are messages, so this has to be able
    // to run again when the first one arrives.
  }, [count]);

  React.useEffect(() => {
    if (!stickToBottom.current) return;
    // Instant, not smooth. A smooth scroll raises scroll events all the way
    // down, and every one of them is read above as "the reader is far from
    // the end" until it lands — which would switch following off mid-turn.
    bottomRef.current?.scrollIntoView();
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
