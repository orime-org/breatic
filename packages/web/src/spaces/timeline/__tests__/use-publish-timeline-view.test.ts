// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { usePublishTimelineView, type PublishTimelineViewInput } from '@web/spaces/timeline/use-publish-timeline-view';
import { useFollowStore } from '@web/stores/follow';

const docs: Y.Doc[] = [];

/**
 * An awareness over a throwaway document.
 * @returns The awareness.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  docs.push(doc);
  return new Awareness(doc);
}

/**
 * A track viewport with settable scroll offsets and a fixed width.
 * @returns The element and its offset setter.
 */
function trackViewport(): { el: HTMLElement; scrollTo: (left: number, top: number) => void; setWidth: (w: number) => void } {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let left = 0;
  let top = 0;
  let width = 1112;
  Object.defineProperty(el, 'scrollLeft', { get: () => left, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => top, configurable: true });
  Object.defineProperty(el, 'clientWidth', { get: () => width, configurable: true });
  return {
    el,
    setWidth: (w) => {
      width = w;
      act(() => {
        for (const callback of resizeCallbacks) callback();
      });
    },
    scrollTo: (l, tp) => {
      left = l;
      top = tp;
      act(() => {
        el.dispatchEvent(new Event('scroll'));
      });
    },
  };
}

/**
 * Read the published field.
 * @param awareness - The awareness.
 * @returns The field, or null.
 */
function view(awareness: Awareness): Record<string, unknown> | null {
  const state = awareness.getLocalState() as { timelineView?: Record<string, unknown> | null } | null;
  return state?.timelineView ?? null;
}

/** Every ResizeObserver callback the hook registered, so a test can report a size change. */
const resizeCallbacks = new Set<() => void>();

beforeEach(() => {
  useFollowStore.getState().reset();
  vi.stubGlobal('ResizeObserver', class {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe(): void {
      resizeCallbacks.add(this.callback);
    }
    unobserve(): void {
      resizeCallbacks.delete(this.callback);
    }
    disconnect(): void {
      resizeCallbacks.delete(this.callback);
    }
  });
});

afterEach(() => {
  resizeCallbacks.clear();
  for (const doc of docs.splice(0)) doc.destroy();
  document.body.innerHTML = '';
});

describe('usePublishTimelineView', () => {
  /**
   * Inputs for one render.
   * @param awareness - The awareness.
   * @param el - The track viewport.
   * @param over - What the case sets.
   * @returns The input.
   */
  function input(awareness: Awareness, el: HTMLElement, over: Partial<PublishTimelineViewInput> = {}): PublishTimelineViewInput {
    return { awareness, viewport: el, pixelsPerFrame: 4, headerPx: 112, frame: 0, intent: 'pause', anchor: null, ...over };
  }

  it('publishes the visible frame range, track scroll and playhead on mount', async () => {
    const awareness = makeAwareness();
    const { el } = trackViewport();
    renderHook(() => usePublishTimelineView(input(awareness, el, { frame: 12 })));
    await vi.waitFor(() => expect(view(awareness)).toMatchObject({
      startFrame: 0, endFrame: 250, trackScrollTop: 0, frame: 12, intent: 'pause', anchor: null,
    }));
  });

  it('republishes after the tracks scroll', async () => {
    const awareness = makeAwareness();
    const { el, scrollTo } = trackViewport();
    renderHook(() => usePublishTimelineView(input(awareness, el)));
    await vi.waitFor(() => expect(view(awareness)).not.toBeNull());
    scrollTo(400, 30);
    await vi.waitFor(() => expect(view(awareness)).toMatchObject({ startFrame: 100, endFrame: 350, trackScrollTop: 30 }));
  });

  it('republishes when playback starts with its wall-clock anchor', async () => {
    const awareness = makeAwareness();
    const { el } = trackViewport();
    const { rerender } = renderHook((p: PublishTimelineViewInput) => usePublishTimelineView(p), { initialProps: input(awareness, el) });
    const anchor = { frame: 30, at: Date.now() };
    rerender(input(awareness, el, { intent: 'play', anchor, frame: 30 }));
    await vi.waitFor(() => expect(view(awareness)).toMatchObject({ intent: 'play', anchor, frame: 30 }));
  });

  it('publishes the anchor frame while playing, so the value changes only when playback changes', async () => {
    const awareness = makeAwareness();
    const { el } = trackViewport();
    const { rerender } = renderHook((p: PublishTimelineViewInput) => usePublishTimelineView(p), { initialProps: input(awareness, el) });
    const anchor = { frame: 30, at: Date.now() };
    rerender(input(awareness, el, { intent: 'play', anchor, frame: 30 }));
    await vi.waitFor(() => expect(view(awareness)).toMatchObject({ intent: 'play', anchor, frame: 30 }));
    const writes = vi.fn();
    awareness.on('change', writes);
    for (const frame of [31, 32, 33, 34, 35]) {
      rerender(input(awareness, el, { intent: 'play', anchor, frame }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(writes).not.toHaveBeenCalled();
    expect(view(awareness)).toMatchObject({ frame: 30, anchor });
    awareness.off('change', writes);
    // Pausing is news again, with the frame it stopped on.
    rerender(input(awareness, el, { intent: 'pause', anchor: null, frame: 36 }));
    await vi.waitFor(() => expect(view(awareness)).toMatchObject({ intent: 'pause', anchor: null, frame: 36 }));
  });

  it('republishes the visible frame range when the track viewport changes width', async () => {
    const awareness = makeAwareness();
    const { el, setWidth } = trackViewport();
    renderHook(() => usePublishTimelineView(input(awareness, el)));
    await vi.waitFor(() => expect(view(awareness)).not.toBeNull());
    const before = view(awareness)?.endFrame as number;
    setWidth(2112);
    await vi.waitFor(() => expect(view(awareness)?.endFrame).toBe(before + 250));
  });

  it('publishes no view while this tab follows a member, and its own once following stops', async () => {
    useFollowStore.getState().start('leader', 'Leader');
    const awareness = makeAwareness();
    const { el, scrollTo } = trackViewport();
    renderHook(() => usePublishTimelineView(input(awareness, el, { frame: 7 })));
    scrollTo(40, 0);
    expect(view(awareness)).toBeNull();
    act(() => useFollowStore.getState().stop('button'));
    await vi.waitFor(() => expect(view(awareness)).toMatchObject({ frame: 7 }));
    act(() => useFollowStore.getState().start('leader', 'Leader'));
    expect(view(awareness)).toBeNull();
  });

  it('publishes the view again after the page comes back from the back-forward cache', async () => {
    const awareness = makeAwareness();
    const { el } = trackViewport();
    renderHook(() => usePublishTimelineView(input(awareness, el, { frame: 12 })));
    await vi.waitFor(() => expect(view(awareness)).not.toBeNull());
    // The provider drops the local state on pagehide and puts back an empty one on restore.
    awareness.setLocalState({});
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    await vi.waitFor(() => expect(view(awareness)).toMatchObject({ frame: 12 }));
  });

  it('takes the field down at once when it unmounts', async () => {
    const awareness = makeAwareness();
    const { el } = trackViewport();
    const { unmount } = renderHook(() => usePublishTimelineView(input(awareness, el)));
    await vi.waitFor(() => expect(view(awareness)).not.toBeNull());
    unmount();
    expect(view(awareness)).toBeNull();
    expect(awareness.getLocalState()).not.toBeNull();
  });
});
