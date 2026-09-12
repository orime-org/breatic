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
 * How close to the bottom still counts as being at the bottom, in pixels.
 *
 * A reader parked at the end is never exactly at it — a partly scrolled last
 * line, a rounded-off device pixel — so an exact test would let go of the
 * bottom the moment anything moved. This is the usual size of that allowance
 * in a streaming chat column.
 */
const AT_BOTTOM_SLACK_PX = 64;

/**
 * How long after a press its growth is still the reader's own.
 *
 * A press is laid out by the next frame and the observer runs on the one
 * after, so the answer is two frames -- 33ms at 60Hz, 67ms where frames come
 * half as often. This is that with room to spare, and short enough that a
 * reply arriving right after a press is still followed.
 *
 * The upper end of that is the one thing here that is not ours to promise:
 * when a press is laid out is up to the machine, and growth that arrives
 * after this window is followed like any other -- what the reader opened
 * leaves the top of the screen. Long tasks, a font swapping in, or a fold
 * that settles its height in two passes are each a way to land outside it.
 */
const PRESS_SETTLES_MS = 100;

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
  const viewportRef = React.useRef<HTMLDivElement>(null);
  // What the messages are laid out in, which is what grows when one of them
  // settles its own height after arriving.
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Whether the reader was at the end last time they moved. Recorded as they
  // scroll rather than measured when new content arrives, because by then the
  // content has already made the column taller and there is no way left to
  // tell "the reader scrolled away" from "the reply grew". Measuring after
  // the fact reads a reader who never moved as one who left, and since the
  // gap only widens from there, following never starts again for that turn.
  const stickToBottom = React.useRef(true);
  // The same fact, in the form the screen can read. The ref is what the
  // scroll handlers act on -- they run on every scroll event and must not
  // render -- so the state beside it is set only when the answer changes.
  const [awayFromEnd, setAwayFromEnd] = React.useState(false);
  // How many messages arrived while the reader was away. Counted from where
  // the column stood when they left: a number counted from the start of the
  // conversation would say the whole history is new.
  const countWhenLeft = React.useRef(0);
  const count = messages.length;
  // Whether the greeting stands where the scroller would be. Read by the
  // effect that wires the scroller up as well as by the branch that draws the
  // greeting, so the two cannot disagree about which one is on screen.
  const empty = ready && count === 0;
  // Read from the scroll listener, which is attached once and would otherwise
  // be reading the length the list had when it was attached -- so every
  // message arriving after that would be counted as missed, and the pill
  // would offer to catch the reader up on the whole conversation.
  const countNow = React.useRef(count);
  countNow.current = count;
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
   * Instant: this is the column keeping up with a turn as it is written, and
   * a smooth scroll raises events all the way down that each read as "the
   * reader is far from the end", which would switch following off mid-turn.
   * The press that asks to come back travels instead, and says so by setting
   * `travelling` first.
   */
  const goToBottom = React.useCallback((): void => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

  /**
   * Whether the column is on its way back to the end under its own power.
   *
   * A journey raises the same scroll events a reader does, so without this
   * the first of them reads as the reader leaving and puts the way-back
   * button on screen for the length of the journey.
   */
  const travelling = React.useRef(false);
  // Where the column stood at the last scroll event, which is what says
  // whether the one being read now moved towards the end or away from it.
  const lastTop = React.useRef(0);

  /**
   * Put every reading of where the reader stood back to "at the end, nothing
   * missed".
   *
   * Five of them describe that one fact, and they belong together because each
   * is about the exchange the reader was in: whether the column follows,
   * whether the way back is offered, how much arrived while they were away,
   * whether a journey of the column's own is still under way, and where the
   * column stood when the reader was last heard from. Carried into another
   * conversation, each speaks for a column no longer on screen -- the button
   * offers a return to a latest message this conversation does not have, and
   * the journey latch swallows every scroll the reader makes here until one of
   * them happens to reach the end.
   *
   * The scroll handler writes four of these as well, which is why they have
   * one named home: a reset covering some of them leaves the rest speaking for
   * a conversation that is gone.
   */
  const returnToEnd = React.useCallback((): void => {
    stickToBottom.current = true;
    travelling.current = false;
    countWhenLeft.current = countNow.current;
    // Nowhere yet, which is what "the reader has not been heard from here" is
    // written as: the callers take the column to the end straight after, and
    // the scroll that raises puts a real reading in its place.
    lastTop.current = 0;
    setAwayFromEnd(false);
  }, []);

  /**
   * When the reader last pressed something inside this column.
   *
   * Any press counts. What makes this column taller under one is a fold
   * opening, and following that takes the thing they opened off the top of the
   * screen -- measured in a browser, a paragraph 247px down the viewport grown
   * by 400px ended up 153px above it. The presses that change no height at all
   * (copy, sources, a square in a picture row) cost nothing by being read this
   * way.
   *
   * A time rather than a count of frames: a hidden document is skipped by the
   * rendering steps altogether, so a release owed to an animation frame is
   * never paid while the reader is on another tab, and the growth that piled
   * up meanwhile is broadcast into a latch still holding. Coming back is
   * exactly when the picture row wants the end in view. Reading the clock also
   * means a second press simply extends the window rather than racing the
   * first one's release.
   */
  const pressedAt = React.useRef(Number.NEGATIVE_INFINITY);

  /**
   * Take the column to the end, unless the reader is the reason it grew.
   *
   * The one place following happens. Two signals ask for it -- the content
   * changing size, and a message arriving or growing -- and whose growth this
   * is belongs to following itself rather than to one of the two ways of
   * asking: a rule written on one signal is silent on the other, and which of
   * them carries a given growth is not what the rule is about.
   */
  const follow = React.useCallback((): void => {
    if (performance.now() - pressedAt.current < PRESS_SETTLES_MS) return;
    if (stickToBottom.current) goToBottom();
  }, [goToBottom]);

  // Before the effect that follows, so a message the reader just sent is
  // already allowed to pull the column down by the time it runs.
  React.useEffect(() => {
    // Scrolling up says "let me read"; sending says "show me what happens
    // next". Only the first should stop the column following, and scroll
    // position alone cannot tell them apart — which is why this is watched
    // separately. Without it, someone who scrolled up and then sent
    // something sees nothing move at all: not their own message, not a word
    // of the reply.
    returnToEnd();
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
  }, [sentCount, conversationId, goToBottom, returnToEnd]);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    /** Record where the reader put themselves, while it is still true. */
    const remember = (): void => {
      const top = viewport.scrollTop;
      const distance = viewport.scrollHeight - top - viewport.clientHeight;
      const atEnd = distance <= AT_BOTTOM_SLACK_PX;
      // A journey of the column's own only ever moves towards the end, so
      // moving the other way is the reader taking it back -- the one reading
      // that covers a scrollbar drag and a touch, neither of which raises an
      // event of its own. It covers only that half: a reader who finds the
      // journey slow and pushes it along moves the way the journey moves, and
      // `endJourney` is what hears them. Arriving ends it too: a journey that
      // reaches the end has nothing left to do.
      const backwards = top < lastTop.current;
      lastTop.current = top;
      if (travelling.current) {
        if (!atEnd && !backwards) return;
        travelling.current = false;
      }
      if (!atEnd && stickToBottom.current) countWhenLeft.current = countNow.current;
      stickToBottom.current = atEnd;
      setAwayFromEnd(!atEnd);
    };

    /**
     * Give the column back to whoever is scrolling it.
     *
     * A browser calls off its own scrolling at the first scroll the reader
     * makes, whichever way that scroll goes, and a journey called off never
     * arrives -- so the arrival that would have released the latch never
     * comes, and every event after it reads as the column's own. Position
     * cannot stand in for this: it tells a reader pulling back and says
     * nothing about one pushing along.
     */
    const endJourney = (): void => {
      travelling.current = false;
    };

    /**
     * Note a press in this column.
     *
     * The measurement a picture row takes of itself follows no press at all,
     * and that is what tells the two kinds of growth apart.
     */
    const notePress = (): void => {
      pressedAt.current = performance.now();
    };

    // A column that changes width rewraps every line, so the same words take a
    // different number of them. Nothing else notices a column that narrows:
    // the message count and the last bubble's shape are both unchanged, the
    // content only grows taller, and scrollTop stays where it was with no
    // scroll event to say so. A reader who was watching the last line of a
    // reply is then left looking at the middle of it — the narrower the
    // column, the further from the end they land.
    const observer = new ResizeObserver(follow);

    viewport.addEventListener('scroll', remember, { passive: true });
    viewport.addEventListener('wheel', endJourney, { passive: true });
    viewport.addEventListener('keydown', endJourney);
    // Capture, so a press still counts when something inside the column stops
    // the click going further. The phase buys nothing against the growth
    // itself: the observer runs in the rendering steps, which is after the
    // whole dispatch either way.
    viewport.addEventListener('click', notePress, { capture: true });
    observer.observe(viewport);
    // And the content, which changes size without the scroller around it
    // changing at all. A message can settle its own height after it is on
    // screen — a row of pictures draws at a floor width on its first frame and
    // again at the width it measures once it knows its room — and none of the
    // signals above move when it does: same message, same shape, same viewport
    // box, no scroll event. What grew is below the fold by then, and so is
    // anything the bubble draws under it.
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      viewport.removeEventListener('scroll', remember);
      viewport.removeEventListener('wheel', endJourney);
      viewport.removeEventListener('keydown', endJourney);
      viewport.removeEventListener('click', notePress, { capture: true });
      observer.disconnect();
    };
    // `ready` because there is no content element at all until the messages
    // are here: the skeleton carries no ref, so `contentRef.current` is null
    // on that side and the observer has nothing to watch.
    // `empty` because the greeting stands in place of the scroller,
    // and nothing here can attach until the first message brings it: an effect
    // keyed on the flag alone runs once against nothing and never again, which
    // leaves a conversation that started empty with no scroll listener and no
    // observers at all. Not the message count: the content element survives
    // messages arriving, and rebuilding the observer for each of them would
    // also hand every new one a first callback of its own.
  }, [follow, ready, empty]);

  React.useEffect(() => {
    follow();
  }, [count, lastShape, follow]);

  /**
   * Take the reader back to the newest message and stay there.
   *
   * Travels rather than arrives: the reader chose this, and watching the
   * column move is what tells them where they went. Following is switched
   * back on before it starts, so a turn that lands mid-journey keeps the end
   * in view.
   */
  const backToEnd = React.useCallback(() => {
    returnToEnd();
    const viewport = viewportRef.current;
    if (!viewport) return;
    travelling.current = true;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  }, [returnToEnd]);

  const missed = Math.max(0, count - countWhenLeft.current);

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
        viewportRef={viewportRef}
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
              />
            ))}
          </div>
        )}
      </ScrollArea>
      {/* Over the foot of the column rather than in it: it is a way back, not
          part of the conversation, and a row of its own would push the newest
          message up every time the reader looked away. */}
      {awayFromEnd && count > 0 ? (
        <Button
          data-testid='back-to-latest'
          variant='outline'
          size='icon'
          onClick={backToEnd}
          // What arrived while the reader was away is said in the name rather
          // than beside the arrow: a reader who cannot see the arrow is the
          // one the count is worth saying to.
          aria-label={
            missed > 0
              ? t('chat.backToLatest.withNew', { count: missed })
              : t('chat.backToLatest.plain')
          }
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
