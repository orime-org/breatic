// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { usePublishView } from '@web/pages/project/use-publish-view';

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

/**
 * Read the published view.
 * @param awareness - The awareness.
 * @returns The view field, or null.
 */
function view(awareness: Awareness): { spaceId: string | null; at: number; focused: boolean } | null {
  const state = awareness.getLocalState() as { view?: { spaceId: string | null; at: number; focused: boolean } | null } | null;
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

  it('writes nothing without an awareness', () => {
    expect(() => renderHook(() => usePublishView(null, 's1'))).not.toThrow();
  });
});
