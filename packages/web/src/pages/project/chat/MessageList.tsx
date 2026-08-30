// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';

interface MessageListProps {
  messages: ReadonlyArray<ChatMessage>;
  /**
   * The conversation has arrived and can be drawn.
   *
   * Different from having no messages: an empty chat invites the user to
   * start one, and showing that over a conversation still on its way makes
   * their own history flash past as if it were not there. So nothing is
   * drawn at all until this is true -- including, and especially, the
   * greeting that belongs to an empty conversation.
   */
  ready?: boolean;
  /**
   * The wait has gone on long enough to be worth showing.
   *
   * A separate question from {@link ready}, and it has to be: the answer
   * usually arrives inside the 300ms the panel waits before asking for one, and
   * a skeleton that comes and goes inside that reads as a flicker. So the first gate decides whether
   * there is anything to draw, and this one decides whether to say we are
   * waiting.
   */
  skeleton?: boolean;
  /**
   * How many times the reader has pressed send in this panel.
   *
   * Only the fact that it changed is used. Sending is a thing the reader
   * does, and nothing about the list can stand in for it: the same messages
   * arrive when the server is asked for them again, with different ids and a
   * reply in the form it was stored — a change with no reader behind it.
   */
  sentCount?: number;
  /**
   * Which conversation these messages belong to.
   *
   * Read only to notice that it changed: arriving in another conversation puts
   * a different exchange in front of the reader, and it starts at its last
   * word -- wherever they had scrolled to in the one before says nothing about
   * this one.
   */
  conversationId?: string;
  /** The conversation reaches back further than what is on screen. */
  hasEarlier?: boolean;
  /** Load what comes before the messages on screen. */
  onLoadEarlier?: () => void;
  onQuickAction?: (label: string) => void;
  /** The panel is on its way to another conversation. */
  navigating?: boolean;
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
 * What a conversation looks like before it has arrived.
 *
 * Shaped like the messages it stands in for -- one wide block for a reply, one
 * narrow one held to the right for a question -- so what replaces it does not
 * jump. It is drawn only once the wait has run past the point where anything
 * is worth saying about it; the gate for that is the caller's.
 * @returns The placeholder rows.
 */
function MessageSkeleton(): React.JSX.Element {
  return (
    <div className='flex flex-col p-3' data-testid='message-skeleton' aria-hidden>
      {[0, 1, 2].map((round) => (
        <div key={round} className='mb-3.5'>
          {/* One question, two lines of answer, laid out the way real messages
              are. A stack of blocks reads as "something is blinking", not as a
              conversation, and a conversation is what the reader is waiting
              for. The widths grow group by group so it reads as content rather
              than as three identical cells. */}
          {/* `h-3` is what the rest of the app uses for a line of text
              standing in for itself. The question keeps its bubble's radius;
              the answer has no bubble, so it keeps the component's own. */}
          <Skeleton
            data-skeleton-bar
            className='ml-auto mb-2 h-3 rounded-lg'
            style={{ width: `${56 + round * 9}%` }}
          />
          <Skeleton data-skeleton-bar className='mb-1 h-3' style={{ width: '93%' }} />
          <Skeleton
            data-skeleton-bar
            className='h-3'
            style={{ width: `${64 + round * 8}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Scrollable message column. Follows a reply as it is written, but only while
 * the reader is at the bottom: once they scroll up, the column stays where
 * they put it until they come back down. Renders `<ChatEmpty />` when there
 * are no messages yet (new conversation greeting + quick actions).
 * @param root0 - The component props.
 * @param root0.messages - The messages to render in order.
 * @param root0.ready - The conversation has arrived and can be drawn.
 * @param root0.skeleton - The wait is long enough to be worth showing.
 * @param root0.conversationId - Which conversation these messages belong to.
 * @param root0.sentCount - How many times the reader has pressed send.
 * @param root0.hasEarlier - The conversation reaches back further than this.
 * @param root0.onLoadEarlier - Called to load what comes before these.
 * @param root0.onQuickAction - Called with a quick-action label from the empty state.
 * @param root0.navigating - The panel is on its way to another conversation.
 * @returns The scrollable message column, or the empty-conversation state.
 */
function MessageListInner({
  messages,
  ready = false,
  skeleton = false,
  sentCount,
  conversationId,
  hasEarlier = false,
  onLoadEarlier,
  onQuickAction,
  navigating = false,
}: MessageListProps): React.JSX.Element {
  const t = useTranslation();
  const viewportRef = React.useRef<HTMLDivElement>(null);
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
  /**
   * Puts this column at its end, writing its own scroller and nothing else.
   *
   * `scrollIntoView` walks up the tree and moves every scroller on the way, and
   * the project page is one of them: measured in a browser, a page parked at
   * scrollLeft 141 was dragged back to 11 by a single call, so a reader in a
   * narrow window lost their place on every reply.
   *
   * Instant, not smooth — a smooth scroll raises scroll events all the way
   * down, and every one of them reads as "the reader is far from the end"
   * until it lands, which would switch following off mid-turn.
   */
  const goToBottom = React.useCallback((): void => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

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
    // And go there now, rather than waiting for something to arrive. Nothing
    // is going to: the message just sent is held out of the list until the
    // first frame (B1), so the count and the last bubble's shape -- what the
    // effect below watches -- are both unchanged by the press. Following
    // alone would leave the column exactly where the reader scrolled it,
    // which reads as the press having done nothing.
    goToBottom();
    // And on arriving in another conversation, for the same reason as sending:
    // what is in front of the reader now is not what they scrolled away from.
    // Done here rather than by keying this component on the conversation --
    // that tore down the scroller, every bubble in it and the observers around
    // them, to set one boolean back to true, and the scroller it left behind
    // stayed on screen as an empty half-column.
  }, [sentCount, conversationId, goToBottom]);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    /** Record where the reader put themselves, while it is still true. */
    const remember = (): void => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottom.current = distance <= AT_BOTTOM_SLACK_PX;
    };

    // A column that changes width rewraps every line, so the same words take a
    // different number of them. Nothing else notices: the message count and
    // the last bubble's shape are both unchanged, and the browser keeps
    // scrollTop where it was rather than raising a scroll event. A reader who
    // was watching the last line of a reply is then left looking at the middle
    // of it — the narrower the column, the further from the end they land.
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) goToBottom();
    });

    viewport.addEventListener('scroll', remember, { passive: true });
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', remember);
      observer.disconnect();
    };
  }, [goToBottom]);

  React.useEffect(() => {
    if (stickToBottom.current) goToBottom();
  }, [count, lastShape, goToBottom]);

  return (
    <ScrollArea
      className='min-h-0 flex-1'
      viewportRef={viewportRef}
      data-testid='message-list'
    >
      {!ready ? (
        skeleton ? <MessageSkeleton /> : null
      ) : count === 0 ? (
        <ChatEmpty onQuickAction={onQuickAction} frozen={navigating} />
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
