// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowDown } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useStickToBottom } from 'use-stick-to-bottom';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { AT_END_SLACK_PX, decideFollow } from '@web/pages/project/chat/follow-decision';
import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';

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
              for a line rather than for the glyphs on it. The app's other
              placeholders for a line of text are 12 to 14px, so this is
              deliberately the taller reading of the two, not the common one.
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
  // The scroller and the box whose growth it follows. Both refs come from the
  // library so it can attach its own listeners and observer to them: the
  // ScrollArea is handed the first through `setViewport` below, and the
  // messages are laid out in the second.
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll, state } = useStickToBottom({
    // Instant, both of them. A smooth journey raises a scroll event per frame
    // and each one reads as the reader leaving the end -- which is the thing
    // that switches following off in the middle of a turn.
    resize: 'instant',
    initial: 'instant',
  });
  const count = messages.length;
  // Whether the greeting stands where the scroller would be.
  const empty = ready && count === 0;

  /**
   * Hand the scroller to the library, and register its own box with it.
   *
   * The library observes the content and nothing else, so a viewport that
   * changes height on its own is invisible to it. Measured in a browser:
   * growing a 200px viewport to 400px made the browser clamp scrollTop from
   * 800 to 600 and raise one scroll event -- and a scroll that moves upwards
   * is how the library knows the reader has left the end. Following would
   * switch off while the reader has not moved at all.
   *
   * The library already has an answer for this shape, built for its own
   * observer: `state.resizeDifference` marks a scroll as the consequence of a
   * resize rather than the act of a reader, and its scroll handler steps over
   * any event raised while that is set. All this does is put the second box
   * through the same gate, and clear it the way the library clears its own --
   * a frame to let the scroll event arrive, a millisecond to outlast the
   * handler's own timer.
   *
   * Where the column now sits is judged here too, on every scroll, because
   * the library's own judgement sits behind that same gate and mid-turn the
   * gate is shut as often as not -- on both halves. A reader leaving the end
   * is not heard (measured on the running app, 4 of 10), and a reader coming
   * back to it does not get the lock back, while the way back is hidden from
   * them at that moment because the hook reports a column near the end as
   * being at it. Reading the geometry as the event arrives answers for every
   * way a container can be scrolled at once, including the ones that never
   * reach the library: a wheel turned over the scrollbar is written straight
   * to the viewport by Radix, from a listener on the document, and the
   * library's own wheel handler is on the viewport, which that event never
   * passes through.
   *
   * The library's own writes are the one thing to step over. `state.animation`
   * is set for the length of anything it scrolls itself, before the write, so
   * the journey the way-back button starts is not read as a reader leaving on
   * every frame of it.
   *
   * Detaching is ours too. The library's cleanup reads `scrollRef.current`
   * after React has already set it to null, so the listeners it means to
   * remove are never reached; going through the node in hand rather than
   * through the ref is what keeps ours from leaking the same way.
   * @param node - The scroller, or null as React takes it away.
   */
  const detach = React.useRef<(() => void) | null>(null);
  const setViewport = React.useCallback(
    (node: HTMLDivElement | null): void => {
      scrollRef(node);
      detach.current?.();
      detach.current = null;
      if (!node) return;
      // The height it has as we start watching, so the first change measures
      // against something real. Taking the first callback as the baseline
      // instead would spend it: an observer reports the size it found on
      // being pointed at something, and a viewport that has already grown by
      // then would have that growth read as no change at all.
      let lastHeight = node.clientHeight;
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const height = entry.contentRect.height;
        const difference = height - lastHeight;
        lastHeight = height;
        if (difference === 0) return;
        state.resizeDifference = difference;
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (state.resizeDifference === difference) state.resizeDifference = 0;
          }, 1);
        });
        // Losing room moves the end away without moving the column: scrollTop
        // is still a legal value, so the browser clamps nothing and says
        // nothing, and the content box did not change either. Measured on the
        // running app: a reader at the end who types eight lines grows the
        // composer by 137px and ends up 137px above the end of the reply,
        // with no arrow offered, because as far as the library is concerned
        // they never left.
        //
        // Where they stood is read off the geometry rather than off a flag.
        // `state.scrollDifference` is the distance now, and this resize is
        // the whole of what changed it, so subtracting it gives the distance
        // before -- and the reading holds for a reader who nudged up a few
        // pixels, whose lock is already off while the library still counts
        // them as being at the end.
        const distanceBefore = state.scrollDifference + difference;
        if (distanceBefore <= AT_END_SLACK_PX) {
          void scrollToBottom({ animation: 'instant', preserveScrollPosition: false });
        }
      });
      observer.observe(node);
      /** Settle what the column now sits at against whether it is keeping up. */
      const judge = (): void => {
        if (state.animation) return;
        const action = decideFollow(state.scrollDifference, state.isAtBottom);
        if (action === 'follow') {
          void scrollToBottom({ animation: 'instant', preserveScrollPosition: false });
        } else if (action === 'leave') {
          stopScroll();
        }
      };
      node.addEventListener('scroll', judge, { passive: true });
      detach.current = (): void => {
        observer.disconnect();
        node.removeEventListener('scroll', judge);
      };
    },
    [scrollRef, state, scrollToBottom, stopScroll],
  );

  // Sending says "show me what happens next"; arriving in another conversation
  // puts a different exchange in front of the reader. Both end at its last
  // word, and both get there at once: there is nothing to watch travel between
  // two conversations, and the message just sent is held out of the list until
  // the first frame, so there is nothing to follow either.
  React.useEffect(() => {
    void scrollToBottom({ animation: 'instant', preserveScrollPosition: false });
  }, [sentCount, conversationId, scrollToBottom]);

  /**
   * Take the reader back to the newest message and stay there.
   *
   * Travels rather than arrives: the reader chose this, and watching the
   * column move is what tells them where they went.
   */
  const backToEnd = React.useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

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
        viewportRef={setViewport}
        // Both axes scroll, so the shorthand `overflow` computes to "scroll"
        // and the library recognises this element as its scroller. It looks
        // for one by walking up from whatever the wheel landed on until
        // `getComputedStyle(el).overflow` is "scroll" or "auto"; Radix writes
        // the two axes separately, and a shorthand whose axes differ
        // serialises as "hidden scroll", which that walk passes straight
        // over. Without it the wheel handler never runs, and a reader
        // scrolling up mid-turn is written back to the end by the next
        // chunk: measured on the running app, 4 of 20 attempts.
        //
        // Important because Radix writes `overflow-x` as an inline style,
        // which a plain class cannot outrank. Nothing appears: Radix hides
        // the native bars here, the rail for this axis is not rendered
        // (`scrollbars` stays 'vertical'), and the column has nothing that
        // overflows sideways.
        viewportClassName='[overflow-x:scroll]!'
        data-testid='message-list'
      >
        {!ready ? (
          skeleton ? <MessageSkeleton /> : null
        ) : (
          <div ref={contentRef} className='flex flex-col gap-2 p-3'>
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
                // Stopping outright rather than skipping this one growth --
                // the block is usually opened while a turn is still being
                // written, and skipping once would let the next chunk carry
                // the reader off anyway. The way back appears as this runs.
                onThinkingOpen={stopScroll}
              />
            ))}
          </div>
        )}
      </ScrollArea>
      {/* Over the foot of the column rather than in it: it is a way back, not
          part of the conversation, and a row of its own would push the newest
          message up every time the reader looked away. */}
      {!isAtBottom && count > 0 ? (
        <Button
          data-testid='back-to-latest'
          variant='outline'
          size='icon'
          onClick={backToEnd}
          aria-label={t('chat.backToLatest')}
          className='absolute inset-x-0 bottom-3 mx-auto size-[var(--btn-inline)] rounded-full bg-card shadow-md'
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
