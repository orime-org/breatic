// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Motion Space's annotations (#1490 design §7.1, §10.1, §13.8): the one owner of opening a thread. Every entry (a
 * marker on the slider, a pin on the frame, an item in the panel, "Modified from" with open annotations, later a
 * notification) calls `openThread`, which shows the thread's result at its time, opens the annotation panel, makes the
 * thread visible there (All when it is resolved, scrolled to when it is below the fold), closes the details popover and
 * opens the thread's card. Unsent replies are kept here by thread, so a card that unmounts (closed, a result being
 * read, an annotation being added) gets its words back when it shows again; Document keeps them outside its cards too.
 */

import * as React from 'react';
import type { ThreadData } from '@blocknote/core/comments';
import type { YjsThreadStore } from '@blocknote/core/yjs';
import { readWebAnimationAnchor, type WebAnimationAnchor } from '@breatic/shared/space-content';

/** Which threads the annotation panel lists. */
export type AnnotationFilter = 'open' | 'all';

/** A thread with its anchor. */
export interface AnchoredThread {
  thread: ThreadData;
  anchor: WebAnimationAnchor;
}

/** What the annotations are tied to. */
export interface MotionAnnotationsInput {
  store: YjsThreadStore;
  /** The shown result. */
  selectedId: string | null;
  /** The thread the selection was asked to focus, until the playhead reaches its time. */
  focusThreadId: string | null;
  /** The result the shown modification started from. */
  baseExecutionId: string | null;
  /** Runs a change of the shown result once the annotation being written allows it. */
  showResult: (go: () => void) => void;
  /** Shows a result by id, focusing a thread on it. */
  locate: (executionId: string, threadId: string | null) => void;
  /** Opens the annotation panel. */
  openPanel: () => void;
  seek: (seconds: number) => void;
  /** Says the playhead reached the focused thread. */
  onFocused: (threadId: string) => void;
}

/** The annotations and what opens, closes and keeps them. */
export interface MotionAnnotations {
  threads: ThreadData[];
  /** The live threads on the shown result. */
  resultThreads: AnchoredThread[];
  /** The thread whose card is open. */
  activeThread: AnchoredThread | null;
  unresolvedCount: number;
  /** How many open threads the result a modification started from has. */
  openOnBaseCount: number;
  filter: AnnotationFilter;
  setFilter: (filter: AnnotationFilter) => void;
  /** The annotation panel's scroller. */
  viewportRef: React.RefObject<HTMLDivElement | null>;
  /** Unsent replies by thread. */
  drafts: ReadonlyMap<string, string>;
  setDraft: (threadId: string, body: string) => void;
  detailsOpen: boolean;
  setDetailsOpen: (open: boolean) => void;
  openThread: (threadId: string) => void;
  /** "Modified from": the base result's earliest open thread, or the base result itself. */
  openBase: () => void;
  closeThread: () => void;
  /** Opens the card of a thread the user just wrote on the shown result. */
  showWritten: (threadId: string) => void;
}

/**
 * The Space's annotation threads, kept current from its thread store.
 * @param store - The store.
 * @returns The threads.
 * @throws {never} Never.
 */
function useThreads(store: YjsThreadStore): ThreadData[] {
  const [threads, setThreads] = React.useState<ThreadData[]>(() => [...store.getThreads().values()]);
  React.useEffect(() => {
    setThreads([...store.getThreads().values()]);
    return store.subscribe((all) => setThreads([...all.values()]));
  }, [store]);
  return threads;
}

/**
 * A thread's anchor, when it is live and has one.
 * @param thread - The thread.
 * @returns The anchor, or null.
 * @throws {never} Never.
 */
function anchorOf(thread: ThreadData): WebAnimationAnchor | null {
  return thread.deletedAt === undefined ? readWebAnimationAnchor(thread.metadata) : null;
}

/**
 * Scroll an item into its scroller and nothing else: by the least distance, and not at all when it shows already.
 * @param viewport - The scroller.
 * @param item - The item.
 * @throws {never} Never.
 */
function revealWithin(viewport: HTMLElement, item: HTMLElement): void {
  const view = viewport.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  const top = box.top < view.top ? viewport.scrollTop + box.top - view.top
    : box.bottom > view.bottom ? viewport.scrollTop + box.bottom - view.bottom : null;
  if (top !== null) viewport.scrollTo({ top, behavior: 'smooth' });
}

/**
 * The Motion Space's annotations and the one way to open one.
 * @param input - What the annotations are tied to.
 * @returns The annotations and their controls.
 * @throws {never} Never.
 */
export function useMotionAnnotations(input: MotionAnnotationsInput): MotionAnnotations {
  const { store, selectedId, focusThreadId, baseExecutionId, showResult, locate, openPanel, seek, onFocused } = input;
  const threads = useThreads(store);
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<AnnotationFilter>('open');
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [drafts, setDrafts] = React.useState<ReadonlyMap<string, string>>(() => new Map());
  // A request to bring a thread's item into view, served once: every request is a new object, and showing the Space
  // again replays the effect with the request already served.
  const [reveal, setReveal] = React.useState<{ threadId: string } | null>(null);
  const served = React.useRef<{ threadId: string } | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);

  const resultThreads = React.useMemo(() => threads.flatMap((thread) => {
    const anchor = anchorOf(thread);
    return anchor !== null && anchor.executionId === selectedId ? [{ thread, anchor }] : [];
  }), [threads, selectedId]);
  const activeThread = React.useMemo(() => {
    const thread = threads.find((item) => item.id === activeThreadId);
    const anchor = thread === undefined ? null : anchorOf(thread);
    return thread === undefined || anchor === null ? null : { thread, anchor };
  }, [threads, activeThreadId]);
  // A thread's card belongs to its result: once another result shows, whichever entry showed it, the card closes and
  // does not come back on returning (design §7.1, §10.1). A result still being read shows none yet and closes nothing.
  const [shownId, setShownId] = React.useState(selectedId);
  if (selectedId !== shownId) {
    setShownId(selectedId);
    if (selectedId !== null && activeThread !== null && activeThread.anchor.executionId !== selectedId) setActiveThreadId(null);
  }
  const unresolvedCount = threads.filter((thread) => !thread.resolved && thread.deletedAt === undefined).length;
  // The open threads on the result a modification started from, earliest first (design §10.1).
  const openOnBase = React.useMemo(() => threads.flatMap((thread) => {
    const anchor = anchorOf(thread);
    return !thread.resolved && anchor !== null && anchor.executionId === baseExecutionId ? [{ id: thread.id, timeSeconds: anchor.timeSeconds }] : [];
  }).sort((a, b) => a.timeSeconds - b.timeSeconds), [threads, baseExecutionId]);

  const openThread = React.useCallback((threadId: string): void => {
    const thread = threads.find((item) => item.id === threadId);
    const anchor = thread === undefined ? null : anchorOf(thread);
    if (thread === undefined || anchor === null) return;
    showResult(() => {
      setDetailsOpen(false);
      setActiveThreadId(threadId);
      if (thread.resolved) setFilter('all');
      setReveal({ threadId });
      openPanel();
      locate(anchor.executionId, threadId);
    });
  }, [threads, showResult, openPanel, locate]);
  const openBase = React.useCallback((): void => {
    const earliest = openOnBase[0];
    if (earliest !== undefined) {
      openThread(earliest.id);
      return;
    }
    if (baseExecutionId === null) return;
    showResult(() => {
      setDetailsOpen(false);
      locate(baseExecutionId, null);
    });
  }, [openOnBase, openThread, baseExecutionId, showResult, locate]);
  const closeThread = React.useCallback((): void => setActiveThreadId(null), []);
  const showWritten = React.useCallback((threadId: string): void => setActiveThreadId(threadId), []);
  const setDraft = React.useCallback((threadId: string, body: string): void => setDrafts((current) => {
    const next = new Map(current);
    if (body === '') next.delete(threadId);
    else next.set(threadId, body);
    return next;
  }), []);

  // The panel opens in the same render as the request, so its scroller and the item are there now.
  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (reveal === null || reveal === served.current || viewport === null) return;
    served.current = reveal;
    const item = [...viewport.querySelectorAll<HTMLElement>('[data-thread-id]')].find((element) => element.dataset.threadId === reveal.threadId);
    if (item !== undefined) revealWithin(viewport, item);
  }, [reveal]);
  // The playhead jumps once the focused thread's result shows, and the focus is spent (design §10.1, §13.2).
  React.useEffect(() => {
    if (focusThreadId === null || activeThread === null || activeThread.thread.id !== focusThreadId || activeThread.anchor.executionId !== selectedId) return;
    seek(activeThread.anchor.timeSeconds);
    onFocused(focusThreadId);
  }, [focusThreadId, activeThread, selectedId, seek, onFocused]);

  return {
    threads, resultThreads, activeThread, unresolvedCount, openOnBaseCount: openOnBase.length, filter, setFilter, viewportRef,
    drafts, setDraft, detailsOpen, setDetailsOpen, openThread, openBase, closeThread, showWritten,
  };
}
