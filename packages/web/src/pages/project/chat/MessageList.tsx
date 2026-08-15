// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
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
  /**
   * How many times the reader has pressed send in this panel.
   *
   * Only the fact that it changed is used. Sending is a thing the reader
   * does, and nothing about the list can stand in for it: the same messages
   * arrive when the server is asked for them again, with different ids and a
   * reply in the form it was stored — a change with no reader behind it.
   */
  sentCount?: number;
  /** The conversation reaches back further than what is on screen. */
  hasEarlier?: boolean;
  /** Load what comes before the messages on screen. */
  onLoadEarlier?: () => void;
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
 * @param root0.sentCount - How many times the reader has pressed send.
 * @param root0.hasEarlier - The conversation reaches back further than this.
 * @param root0.onLoadEarlier - Called to load what comes before these.
 * @param root0.onQuickAction - Called with a quick-action label from the empty state.
 * @returns The scrollable message column, or the empty-conversation state.
 */
function MessageListInner({
  messages,
  loading = false,
  sentCount,
  hasEarlier = false,
  onLoadEarlier,
  onQuickAction,
}: MessageListProps): React.JSX.Element {
  const t = useTranslation();
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
  // the end, so the count sits still for the whole turn. Following the last
  // message's own shape as well is what keeps the answer in view while it is
  // being written.
  //
  // Its shape, not just the words in it: how a turn ended is drawn inside the
  // same bubble — a failure box, a note that it was stopped, a card per tool
  // it used — and each of those makes the bubble taller without adding a
  // single character. Following the text alone leaves a reader who never left
  // the bottom unable to see the thing that just told them what happened.
  const lastShape = React.useMemo(() => {
    const last = messages.at(-1);
    if (!last) return '';
    return [
      last.content.length,
      last.thinking?.length ?? 0,
      last.toolCalls?.length ?? 0,
      last.streaming ? 's' : '',
      last.failed ? 'f' : '',
      last.interrupted ? 'i' : '',
    ].join('|');
  }, [messages]);
  // Before the effect that follows, so a message the reader just sent is
  // already allowed to pull the column down by the time it runs.
  React.useEffect(() => {
    // Scrolling up says "let me read"; sending says "show me what happens
    // next". Only the first should stop the column following, and scroll
    // position alone cannot tell them apart — which is why this is watched
    // separately. Without it, someone who scrolled up and then sent
    // something sees nothing move at all: not their own message, not a word
    // of the reply.
    stickToBottom.current = true;
  }, [sentCount]);

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
  }, [count, lastShape]);

  return (
    <ScrollArea className='min-h-0 flex-1' data-testid='message-list'>
      {loading ? null : count === 0 ? (
        <ChatEmpty onQuickAction={onQuickAction} />
      ) : (
        <div className='flex flex-col gap-2 p-3'>
          {/* At the top, because that is where the conversation continues
              upward. Without it a conversation past its first page simply
              begins in the middle, with nothing on screen saying that what
              came before is still there. */}
          {hasEarlier ? (
            <Button
              variant='outline'
              size='sm'
              className='self-center'
              onClick={onLoadEarlier}
              data-testid='chat-load-earlier'
            >
              {t('chat.loadEarlier')}
            </Button>
          ) : null}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </ScrollArea>
  );
}

/**
 * The column, rendered again only when what it shows has changed.
 *
 * What this stops is the panel's other traffic: a keystroke in the composer,
 * the history sheet opening, a notice appearing. None of them touch the
 * messages, so the props do not move and the column is left alone.
 *
 * It does NOT stop the streaming re-render, and cannot: every piece of a
 * reply replaces the message, which replaces the list, which is a new
 * `messages` array here. What spares the column then is one level down --
 * the panel reuses the view object of every message it is not rewriting, so
 * `MessageBubble`'s own memo bails on all of them but the one being written.
 */
export const MessageList = React.memo(MessageListInner);
