// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Layout, PanelImperativeHandle } from 'react-resizable-panels';

import { STORAGE_KEYS } from '@web/lib/storage-keys';
import {
  AGENT_PANEL_ID,
  RESIZE_HANDLE_WIDTH,
} from '@web/pages/project/agent-column-width';
import { useAgentColumnWidth } from '@web/pages/project/use-agent-column-width';

const KEY = STORAGE_KEYS.agentColumnWidth;

/**
 * The imperative handle is only used to resize; the hook reads widths out of
 * the layout the callback is handed, so `getSize` is here to prove it is NOT
 * consulted for that.
 */
function fakeHandle(): PanelImperativeHandle & { resize: ReturnType<typeof vi.fn> } {
  return {
    getSize: () => ({ inPixels: -1, asPercentage: -1 }),
    resize: vi.fn(),
    collapse: vi.fn(),
    expand: vi.fn(),
    isCollapsed: () => false,
  };
}

/** A stand-in for the Group's root element; only its width is read. */
function fakeGroup(clientWidth: number): HTMLDivElement {
  return { clientWidth } as HTMLDivElement;
}

/** The layout the library hands the callback: panel id to its percentage. */
function layoutWithAgentAt(pixels: number, panelsWidth: number): Layout {
  const percentage = (pixels / panelsWidth) * 100;
  return { [AGENT_PANEL_ID]: percentage, space: 100 - percentage };
}

const BY_USER = { isUserInteraction: true };
const BY_LIBRARY = { isUserInteraction: false };

/** A 1400px window: the two columns divide 1399 of it. */
const GROUP = 1400;
const PANELS = GROUP - RESIZE_HANDLE_WIDTH;

describe('useAgentColumnWidth', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('the width the column starts at', () => {
    it('is the minimum when nothing is stored', () => {
      const { result } = renderHook(() => useAgentColumnWidth());
      expect(result.current.defaultSize).toBe('320px');
    });

    it('is the stored width', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      expect(result.current.defaultSize).toBe('500px');
    });

    it('is the minimum when the stored value is unusable', () => {
      window.localStorage.setItem(KEY, '640abc');
      const { result } = renderHook(() => useAgentColumnWidth());
      expect(result.current.defaultSize).toBe('320px');
    });
  });

  describe('what the user does to the handle', () => {
    it('stores the width the layout says the column is going to', () => {
      const { result } = renderHook(() => useAgentColumnWidth());
      result.current.panelRef.current = fakeHandle();
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(500, PANELS), BY_USER));

      expect(window.localStorage.getItem(KEY)).toBe('500');
    });

    it('reads the width out of the layout, not out of the panel', () => {
      // The library reports a layout change synchronously, before React has
      // re-rendered, so the panel's own measurements are still one step
      // behind. A keyboard resize is a single change with nothing after it to
      // paper over the gap, so the layout is the only usable source.
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(570, PANELS), BY_USER));

      expect(window.localStorage.getItem(KEY)).toBe('570');
    });

    it('replaces an earlier width, so a drag inside a squeezed window wins', () => {
      window.localStorage.setItem(KEY, '600');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;

      // Window is narrow: the user drags to 400, which becomes the set width.
      result.current.groupRef.current = fakeGroup(900);
      act(() =>
        result.current.onLayoutChanged(
          layoutWithAgentAt(400, 900 - RESIZE_HANDLE_WIDTH),
          BY_USER,
        ),
      );
      expect(window.localStorage.getItem(KEY)).toBe('400');

      // Window widens again. The column goes back to 400, not to the old 600.
      result.current.groupRef.current = fakeGroup(GROUP);
      act(() => result.current.onLayoutChanged(layoutWithAgentAt(340, PANELS), BY_LIBRARY));
      expect(handle.resize).toHaveBeenCalledWith(400);
    });
  });

  describe('what the library does on its own', () => {
    it('puts the column back on the width the user set', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(579, PANELS), BY_LIBRARY));

      expect(handle.resize).toHaveBeenCalledWith(500);
    });

    it('leaves a column that is already where it belongs alone', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(500, PANELS), BY_LIBRARY));

      expect(handle.resize).not.toHaveBeenCalled();
    });

    it('leaves a sub-pixel difference alone, so restoring does not loop', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(500.4, PANELS), BY_LIBRARY));

      expect(handle.resize).not.toHaveBeenCalled();
    });

    it('squeezes the column when the window cannot hold the set width', () => {
      window.localStorage.setItem(KEY, '640');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;
      // 900 wide window: the space region keeps 420, so the column gets 479.
      result.current.groupRef.current = fakeGroup(900);

      act(() =>
        result.current.onLayoutChanged(
          layoutWithAgentAt(640, 900 - RESIZE_HANDLE_WIDTH),
          BY_LIBRARY,
        ),
      );

      expect(handle.resize).toHaveBeenCalledWith(479);
    });

    it('never writes the width the library arrived at', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      result.current.panelRef.current = fakeHandle();
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(579, PANELS), BY_LIBRARY));

      expect(window.localStorage.getItem(KEY)).toBe('500');
    });
  });

  describe('when the column is not on screen', () => {
    it('does nothing without a handle', () => {
      const { result } = renderHook(() => useAgentColumnWidth());
      result.current.panelRef.current = null;
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(500, PANELS), BY_USER));

      expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it('does nothing without a group element to measure', () => {
      const { result } = renderHook(() => useAgentColumnWidth());
      result.current.panelRef.current = fakeHandle();
      result.current.groupRef.current = null;

      act(() => result.current.onLayoutChanged(layoutWithAgentAt(500, PANELS), BY_USER));

      expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it('does nothing when the collapsed column is absent from the layout', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;
      result.current.groupRef.current = fakeGroup(GROUP);

      act(() => result.current.onLayoutChanged({ space: 100 }, BY_LIBRARY));

      expect(handle.resize).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(KEY)).toBe('500');
    });

    it('does nothing while the group has not been measured', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle();
      result.current.panelRef.current = handle;
      result.current.groupRef.current = fakeGroup(0);

      act(() => result.current.onLayoutChanged({ [AGENT_PANEL_ID]: 50, space: 50 }, BY_LIBRARY));

      expect(handle.resize).not.toHaveBeenCalled();
    });
  });
});
