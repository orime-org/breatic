// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { usePublishView } from '@web/pages/project/use-publish-view';
import { useFollowStore } from '@web/stores/follow';

const open: Array<{ doc: Y.Doc; awareness: Awareness }> = [];
let visibility: DocumentVisibilityState = 'visible';

/**
 * Build a real awareness over a throwaway meta document.
 * @returns The awareness.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  open.push({ doc, awareness });
  return awareness;
}

/** The `view` field as this hook writes it. */
interface PublishedView {
  spaceId: string | null;
  at: number;
  focused: boolean;
}

/**
 * Read whom this tab says it follows.
 * @param awareness - The awareness.
 * @returns The followed user id, or null.
 */
function following(awareness: Awareness): string | null {
  const state = awareness.getLocalState() as { following?: { id: string } | null } | null;
  return state?.following?.id ?? null;
}

/**
 * Read the published view.
 * @param awareness - The awareness.
 * @returns The view field, or null.
 */
function view(awareness: Awareness): PublishedView | null {
  const state = awareness.getLocalState() as { view?: PublishedView | null } | null;
  return state?.view ?? null;
}

/**
 * Switch the page's visibility and tell the document.
 * @param next - The new visibility.
 */
function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  useFollowStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const { doc, awareness } of open.splice(0)) {
    awareness.destroy();
    doc.destroy();
  }
});

describe('usePublishView', () => {
  it('publishes the Space in front, focus and wall-clock time when it mounts', () => {
    const awareness = makeAwareness();
    const before = Date.now();
    renderHook(() => usePublishView(awareness, 's1'));
    expect(view(awareness)).toMatchObject({ spaceId: 's1', focused: true });
    expect(view(awareness)!.at).toBeGreaterThanOrEqual(before);
  });

  it('publishes whom this user follows, rewritten when following starts, switches or stops', () => {
    const awareness = makeAwareness();
    renderHook(() => usePublishView(awareness, 's1'));
    expect(following(awareness)).toBeNull();
    act(() => useFollowStore.getState().start('u1', 'Li Lei'));
    expect(following(awareness)).toBe('u1');
    expect(view(awareness)).toMatchObject({ spaceId: 's1' });
    act(() => useFollowStore.getState().start('u2', 'Han Meimei'));
    expect(following(awareness)).toBe('u2');
    act(() => useFollowStore.getState().stop('button'));
    expect(following(awareness)).toBeNull();
  });

  it('keeps saying whom this tab follows while the browser tab is hidden and its view is withdrawn', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const awareness = makeAwareness();
    renderHook(() => usePublishView(awareness, 's1'));
    setVisibility('hidden');
    expect(view(awareness)).toBeNull();
    expect(following(awareness)).toBe('u1');
  });

  it('publishes the member already being followed when it mounts', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const awareness = makeAwareness();
    renderHook(() => usePublishView(awareness, 's1'));
    expect(following(awareness)).toBe('u1');
  });

  it('republishes when the Space in front changes, and publishes null when every tab is closed', () => {
    const awareness = makeAwareness();
    const { rerender } = renderHook((id: string | null) => usePublishView(awareness, id), { initialProps: 's1' as string | null });
    rerender('s2');
    expect(view(awareness)?.spaceId).toBe('s2');
    rerender(null);
    expect(view(awareness)).toMatchObject({ spaceId: null });
  });

  it('rewrites focused when the window gains or loses focus', () => {
    const awareness = makeAwareness();
    renderHook(() => usePublishView(awareness, 's1'));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect(view(awareness)?.focused).toBe(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    expect(view(awareness)?.focused).toBe(true);
  });

  it('withdraws the view while the browser tab is hidden and writes it back when shown', () => {
    const awareness = makeAwareness();
    renderHook(() => usePublishView(awareness, 's1'));
    setVisibility('hidden');
    expect(view(awareness)).toBeNull();
    expect(awareness.getLocalState()).not.toBeNull();
    setVisibility('visible');
    expect(view(awareness)?.spaceId).toBe('s1');
  });

  it('does not publish while mounted in a hidden tab', () => {
    visibility = 'hidden';
    const awareness = makeAwareness();
    renderHook(() => usePublishView(awareness, 's1'));
    expect(view(awareness)).toBeNull();
  });

  it('writes the view back after the state is wiped from outside', async () => {
    const awareness = makeAwareness();
    renderHook(() => usePublishView(awareness, 's1'));
    awareness.setLocalState({});
    await vi.waitFor(() => expect(view(awareness)?.spaceId).toBe('s1'));
  });

  it('takes the view down when it unmounts, leaving the entry listed', () => {
    const awareness = makeAwareness();
    const { unmount } = renderHook(() => usePublishView(awareness, 's1'));
    unmount();
    expect(view(awareness)).toBeNull();
    expect(awareness.getLocalState()).not.toBeNull();
  });

  it('takes down whom this tab follows when it unmounts', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const awareness = makeAwareness();
    const { unmount } = renderHook(() => usePublishView(awareness, 's1'));
    unmount();
    expect(following(awareness)).toBeNull();
  });

  it('writes nothing without an awareness', () => {
    expect(() => renderHook(() => usePublishView(null, 's1'))).not.toThrow();
  });
});
