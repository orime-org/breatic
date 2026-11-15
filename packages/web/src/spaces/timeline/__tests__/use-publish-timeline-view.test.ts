// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { usePublishTimelineView, type PublishTimelineViewInput } from '@web/spaces/timeline/use-publish-timeline-view';

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
function trackViewport(): { el: HTMLElement; scrollTo: (left: number, top: number) => void } {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let left = 0;
  let top = 0;
  Object.defineProperty(el, 'scrollLeft', { get: () => left, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => top, configurable: true });
  Object.defineProperty(el, 'clientWidth', { get: () => 1112, configurable: true });
  return {
    el,
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

afterEach(() => {
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
