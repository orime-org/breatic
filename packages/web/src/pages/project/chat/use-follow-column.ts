// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  nextFollowState,
  type FollowEvent,
  type FollowState,
} from '@web/pages/project/chat/follow-machine';
import { AT_END_EPSILON_PX, readScroll } from '@web/pages/project/chat/scroll-reading';

/** The things a reader does that the column hears about from our own callbacks. */
export type ReaderAction = Extract<
  FollowEvent,
  'wayBackPressed' | 'messageSent' | 'conversationSwitched' | 'thinkingOpened' | 'earlierLoaded'
>;

/** What the column offers whoever draws it. */
export interface FollowColumn {
  /** Hand it the scroller. */
  setViewport: (node: HTMLElement | null) => void;
  /** Hand it the box the messages are laid out in. */
  setContent: (node: HTMLElement | null) => void;
  /** Whether to draw the way back to the newest message. */
  showWayBack: boolean;
  /** Tell it about something the reader did elsewhere. */
  send: (action: ReaderAction) => void;
}

/**
 * The journey the way-back button starts, taken from `use-stick-to-bottom`,
 * whose spring these are the defaults of. Kept because the feel of that
 * journey was settled on it.
 */
const SPRING = { damping: 0.7, stiffness: 0.05, mass: 1.25 };

/** What one frame is worth, so a slow frame moves the column further. */
const FRAME_MS = 1000 / 60;

interface Column {
  state: FollowState;
  viewport: HTMLElement | null;
  /** Where the column sat when the last scroll event was read. */
  lastTop: number;
  /** What we last asked the column to be, until a scroll event carries it back. */
  written: number | undefined;
  glideVelocity: number;
  /** Sub-pixel movement owed, held over until it adds up to a whole one. */
  glideCarry: number;
  glideLastTick: number;
  /** The frame the glide has booked, or zero when none is booked. */
  glideFrame: number;
  showWayBack: boolean;
  readonly listeners: Set<() => void>;
  detachViewport: (() => void) | null;
  detachContent: (() => void) | null;
}

/**
 * How far the column could still travel.
 * @param node - The scroller.
 * @returns The position of its end.
 */
function endOf(node: HTMLElement): number {
  return node.scrollHeight - node.clientHeight;
}

/**
 * Put the column at a position, and remember having asked.
 *
 * The behaviour is forced to `auto` around the write: a page that has asked
 * for smooth scrolling in CSS would otherwise turn this into a journey of its
 * own, arriving frames later at a position we have already stopped expecting.
 * What is remembered is what the column took rather than what was asked for,
 * since the browser clamps.
 * @param column - The column.
 * @param top - Where to put it.
 */
function writeTop(column: Column, top: number): void {
  const node = column.viewport;
  if (!node) return;
  const { scrollBehavior } = getComputedStyle(node);
  if (scrollBehavior !== 'auto') node.style.scrollBehavior = 'auto';
  node.scrollTop = top;
  column.written = node.scrollTop;
  if (scrollBehavior !== 'auto') node.style.scrollBehavior = scrollBehavior;
}

/**
 * Work out whether the way back is owed, and tell whoever is drawing.
 *
 * The one place that question is answered. It takes both halves: the column
 * has to belong to the reader, and there has to be somewhere below to go --
 * a held column that the browser has carried onto the end would otherwise
 * offer a way to where it already is.
 * @param column - The column.
 */
function publish(column: Column): void {
  const node = column.viewport;
  const distance = node === null ? 0 : endOf(node) - node.scrollTop;
  const owed = column.state === 'held' && distance > AT_END_EPSILON_PX;
  if (owed === column.showWayBack) return;
  column.showWayBack = owed;
  for (const listener of column.listeners) listener();
}

/**
 * Put the column where its state says it belongs.
 *
 * `following` is the only state that writes from here: `travelling` is written
 * by the journey, frame by frame, and `held` by nobody.
 * @param column - The column.
 */
function settle(column: Column): void {
  const node = column.viewport;
  if (node === null || column.state !== 'following') return;
  writeTop(column, endOf(node));
}

/**
 * Stop the journey, wherever it has got to.
 * @param column - The column.
 */
function stopGlide(column: Column): void {
  if (column.glideFrame !== 0) cancelAnimationFrame(column.glideFrame);
  column.glideFrame = 0;
}

/**
 * Move the journey on by one frame.
 *
 * The target is read fresh every frame, so a reply still being written pulls
 * the destination along rather than being jumped past. Movement worth less
 * than a whole pixel is held over: `scrollTop` cannot take it, and dropping it
 * would stall the journey short of its end.
 * @param column - The column.
 * @param tick - The frame's timestamp.
 */
function glideStep(column: Column, tick: number): void {
  column.glideFrame = 0;
  const node = column.viewport;
  if (node === null || column.state !== 'travelling') return;

  const distance = endOf(node) - node.scrollTop;
  if (distance <= AT_END_EPSILON_PX) {
    apply(column, 'glideArrived');
    return;
  }

  const elapsed = (tick - (column.glideLastTick === 0 ? tick : column.glideLastTick)) / FRAME_MS;
  column.glideLastTick = tick;
  column.glideVelocity =
    (SPRING.damping * column.glideVelocity + SPRING.stiffness * distance) / SPRING.mass;
  column.glideCarry += column.glideVelocity * elapsed;

  const before = node.scrollTop;
  writeTop(column, before + column.glideCarry);
  if (node.scrollTop !== before) column.glideCarry = 0;

  apply(column, 'glideFrame');
  if (column.state === 'travelling') {
    column.glideFrame = requestAnimationFrame((next) => {
      glideStep(column, next);
    });
  }
}

/**
 * Start the journey from wherever the column stands.
 * @param column - The column.
 */
function startGlide(column: Column): void {
  stopGlide(column);
  column.glideVelocity = 0;
  column.glideCarry = 0;
  // Left at zero for the first frame to fill in from its own stamp. Taking it
  // from `performance.now()` instead looks equivalent and is not: the two
  // share a time origin in a browser but not under jsdom, where the frame
  // stamp runs some hundreds of milliseconds behind and the journey would
  // start by being thrown backwards.
  column.glideLastTick = 0;
  column.glideFrame = requestAnimationFrame((tick) => {
    glideStep(column, tick);
  });
}

/**
 * Put an event through the transition table and do what the new state owes.
 *
 * The only place the state is written. Arriving somewhere is what starts and
 * stops the journey, so no caller has to remember to do either -- which is
 * what makes the table's ten unreachable cells unreachable.
 * @param column - The column.
 * @param event - What happened.
 */
function apply(column: Column, event: FollowEvent): void {
  const from = column.state;
  const to = nextFollowState(from, event);
  if (to !== from) {
    if (from === 'travelling') stopGlide(column);
    column.state = to;
    if (to === 'travelling') startGlide(column);
    else settle(column);
  }
  publish(column);
}

/**
 * Read one scroll event and put what it stands for through the table.
 * @param column - The column.
 */
function onScroll(column: Column): void {
  const node = column.viewport;
  if (node === null) return;
  const event = readScroll({
    top: node.scrollTop,
    lastTop: column.lastTop,
    end: endOf(node),
    written: column.written,
  });
  column.lastTop = node.scrollTop;
  column.written = undefined;
  if (event === null) publish(column);
  else apply(column, event);
}

/**
 * Watch a box and report which way it changed size.
 *
 * The first callback is the baseline: an observer reports the size it found on
 * being pointed at something, and there is no change in that.
 * @param node - The box to watch.
 * @param report - Called with the direction of every change after the first.
 * @returns How to stop watching.
 */
function watchHeight(node: HTMLElement, report: (grew: boolean) => void): () => void {
  let last: number | undefined;
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const height = entry.contentRect.height;
    const previous = last;
    last = height;
    if (previous === undefined || height === previous) return;
    report(height > previous);
  });
  observer.observe(node);
  return () => {
    observer.disconnect();
  };
}

/**
 * Build the column's mutable state.
 * @returns A column that belongs to nobody yet and is following.
 */
function createColumn(): Column {
  return {
    state: 'following',
    viewport: null,
    lastTop: 0,
    written: undefined,
    glideVelocity: 0,
    glideCarry: 0,
    glideLastTick: 0,
    glideFrame: 0,
    showWayBack: false,
    listeners: new Set(),
    detachViewport: null,
    detachContent: null,
  };
}

/**
 * A message column that keeps up with a reply while it is being written, and
 * hands itself to the reader the moment they move it.
 *
 * Who it belongs to is settled by the transition table in `follow-machine`,
 * and every event goes through it. What a scroll event stands for is settled
 * by `scroll-reading`, which rules out our own writes and the browser's clamp
 * and calls whatever is left the reader -- so the ways a column can be moved
 * do not have to be listed anywhere.
 * @returns The refs to hand it, whether to draw the way back, and how to tell
 *   it what the reader did elsewhere.
 */
export function useFollowColumn(): FollowColumn {
  const held = React.useRef<Column | null>(null);
  held.current ??= createColumn();
  const column = held.current;

  const showWayBack = React.useSyncExternalStore(
    React.useCallback(
      (listener: () => void) => {
        column.listeners.add(listener);
        return () => {
          column.listeners.delete(listener);
        };
      },
      [column],
    ),
    () => column.showWayBack,
    () => false,
  );

  const setViewport = React.useCallback(
    (node: HTMLElement | null): void => {
      column.detachViewport?.();
      column.detachViewport = null;
      column.viewport = node;
      if (node === null) return;

      /** Read whatever the browser has just told us about this column. */
      const listen = (): void => {
        onScroll(column);
      };
      node.addEventListener('scroll', listen, { passive: true });
      const unwatch = watchHeight(node, (grew) => {
        apply(column, grew ? 'viewportGrew' : 'viewportShrank');
        settle(column);
      });
      // Detaching through the node in hand rather than through a ref: React
      // has already set the ref to null by the time this runs again.
      column.detachViewport = (): void => {
        node.removeEventListener('scroll', listen);
        unwatch();
      };
      column.lastTop = node.scrollTop;
      settle(column);
      publish(column);
    },
    [column],
  );

  const setContent = React.useCallback(
    (node: HTMLElement | null): void => {
      column.detachContent?.();
      column.detachContent = null;
      if (node === null) return;
      column.detachContent = watchHeight(node, (grew) => {
        apply(column, grew ? 'contentGrew' : 'contentShrank');
        settle(column);
      });
    },
    [column],
  );

  const send = React.useCallback(
    (action: ReaderAction): void => {
      apply(column, action);
      settle(column);
    },
    [column],
  );

  React.useEffect(
    () => () => {
      stopGlide(column);
      column.detachViewport?.();
      column.detachContent?.();
      column.detachViewport = null;
      column.detachContent = null;
      column.viewport = null;
    },
    [column],
  );

  return { setViewport, setContent, showWayBack, send };
}
