// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowDown } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';
import { useFollowColumn } from '@web/pages/project/chat/use-follow-column';

interface MessageListProps {
  messages: ReadonlyArray<ChatMessage>;
  /** Whether the running turn stopped to fold its memory before answering. */
  consolidating?: boolean;
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
          {/* `h-4` is 16px, settled against the drawing (#133): a bar stands
              for a line rather than for the glyphs on it, which is also the
              height `Skeleton`'s own documentation gives for a line of text.
              The question keeps its bubble's radius;
              the answer has no bubble, so it keeps the component's own. */}
          <Skeleton
            data-skeleton-bar
            className='ml-auto mb-2 h-4 rounded-lg'
            style={{ width: `${56 + round * 9}%` }}
          />
          <Skeleton data-skeleton-bar className='mb-1 h-4' style={{ width: '93%' }} />
          <Skeleton
            data-skeleton-bar
            className='h-4'
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
 * @param root0.consolidating - Whether the running turn stopped to fold memory.
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
  consolidating,
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
  // Who the column belongs to, and everything that follows from it. The
  // scroller and the box the messages are laid out in are handed over below;
  // what the reader does anywhere else is sent in.
  const column = useFollowColumn();
  const { send } = column;
  const count = messages.length;
  // Whether the greeting stands where the scroller would be.
  const empty = ready && count === 0;

  // Sending says "show me what happens next"; arriving in another
  // conversation puts a different exchange in front of the reader. Both end at
  // its last word, and both get there at once: there is nothing to watch
  // travel between two conversations, and the message just sent is held out of
  // the list until the first frame, so there is nothing to follow either.
  React.useEffect(() => {
    send('messageSent');
  }, [sentCount, send]);
  React.useEffect(() => {
    send('conversationSwitched');
  }, [conversationId, send]);

  /** Tell the column the reader opened a thinking block. */
  const thinkingOpened = React.useCallback((): void => {
    send('thinkingOpened');
  }, [send]);

  /** Load what came before, and tell the column it happened. */
  const loadEarlier = React.useCallback((): void => {
    send('earlierLoaded');
    onLoadEarlier?.();
  }, [send, onLoadEarlier]);

  /** Take the reader back to the newest message and stay there. */
  const backToEnd = React.useCallback((): void => {
    send('wayBackPressed');
  }, [send]);

  // The empty state centres itself with `h-full`, and the scroll viewport
  // cannot give it one: Radix wraps its children in an auto-height block, so
  // a percentage height there resolves against the content and the centring
  // collapses to the top of the column. Outside it, the same class centres
  // against the column — which is what puts the greeting beside the composer
  // its own arrow points at. `StudioRecentPage` keeps its pending and error
  // states outside for this reason.
  if (empty) {
    return (
      <div className='relative flex min-h-0 flex-1 flex-col'>
        <ChatEmpty onQuickAction={onQuickAction} frozen={navigating} />
      </div>
    );
  }

  return (
    <div className='relative flex min-h-0 flex-1 flex-col'>
      <ScrollArea
        className='min-h-0 flex-1'
        viewportRef={column.setViewport}
        data-testid='message-list'
      >
        {!ready ? (
          skeleton ? <MessageSkeleton /> : null
        ) : (
          <div ref={column.setContent} className='flex flex-col gap-2 p-3'>
            {/* At the top, because that is where the conversation continues
              upward. Without it a conversation past its first page simply
              begins in the middle, with nothing on screen saying that what
              came before is still there. */}
            {hasEarlier ? (
              <Button
                variant='outline'
                size='sm'
                className='self-center'
                onClick={loadEarlier}
                data-testid='chat-load-earlier'
              >
                {t('chat.loadEarlier')}
              </Button>
            ) : null}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                // Only the bubble that is still waiting has anywhere to put it,
                // and handing the same value to every bubble takes the whole
                // list through a render each time a fold starts and ends.
                consolidating={m.streaming === true ? consolidating : undefined}
                // Opening a thinking block is the one press in this column
                // that changes its height, and the reader who made it wants
                // to read what appeared. Following would take it off the top
                // of the screen: measured in a browser, a paragraph 247px
                // down a viewport grown by 400px ended up 153px above it.
                // Handing the column over rather than skipping this one
                // growth -- the block is usually opened while a turn is still
                // being written, and skipping once would let the next chunk
                // carry the reader off anyway. The way back appears as this
                // runs. Whether this should hand the column over at all is
                // #254: it answers to no line of the task it belongs to.
                onThinkingOpen={thinkingOpened}
              />
            ))}
          </div>
        )}
      </ScrollArea>
      {/* Over the foot of the column rather than in it: it is a way back, not
          part of the conversation, and a row of its own would push the newest
          message up every time the reader looked away. */}
      {column.showWayBack ? (
        <Button
          data-testid='back-to-latest'
          variant='outline'
          size='icon'
          onClick={backToEnd}
          aria-label={t('chat.backToLatest')}
          className='absolute inset-x-0 bottom-3 mx-auto size-[var(--btn-inline)] rounded-full bg-popover shadow-md'
        >
          <ArrowDown className='size-3.5' aria-hidden='true' />
        </Button>
      ) : null}
    </div>
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
