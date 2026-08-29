// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { STORAGE_KEYS } from '@web/lib/storage-keys';
import { useAgentColumnWidth } from '@web/pages/project/use-agent-column-width';

const KEY = STORAGE_KEYS.agentColumnWidth;

/**
 * A stand-in for the Panel's imperative handle. `asPercentage` is derived the
 * way the library derives it — the panel's share of the two panels' combined
 * width — because that is what the hook reads the container width back out of.
 */
function fakeHandle(
  inPixels: number,
  panelsWidth: number,
): PanelImperativeHandle & { resize: ReturnType<typeof vi.fn> } {
  return {
    getSize: () => ({ inPixels, asPercentage: (inPixels / panelsWidth) * 100 }),
    resize: vi.fn(),
    collapse: vi.fn(),
    expand: vi.fn(),
    isCollapsed: () => false,
  };
}

const BY_USER = { isUserInteraction: true };
const BY_LIBRARY = { isUserInteraction: false };

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
    it('stores the width a drag ended on', () => {
      const { result } = renderHook(() => useAgentColumnWidth());
      result.current.panelRef.current = fakeHandle(500, 1400);

      act(() => result.current.onLayoutChanged({}, BY_USER));

      expect(window.localStorage.getItem(KEY)).toBe('500');
    });

    it('replaces an earlier width, so a drag inside a squeezed window wins', () => {
      window.localStorage.setItem(KEY, '600');
      const { result } = renderHook(() => useAgentColumnWidth());

      // Window is narrow: the user drags to 400, which becomes the set width.
      const narrow = fakeHandle(400, 900);
      result.current.panelRef.current = narrow;
      act(() => result.current.onLayoutChanged({}, BY_USER));
      expect(window.localStorage.getItem(KEY)).toBe('400');

      // Window widens again. The column goes back to 400, not to the old 600.
      const wide = fakeHandle(340, 1400);
      result.current.panelRef.current = wide;
      act(() => result.current.onLayoutChanged({}, BY_LIBRARY));
      expect(wide.resize).toHaveBeenCalledWith(400);
    });
  });

  describe('what the library does on its own', () => {
    it('puts the column back on the width the user set', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle(579, 1400);
      result.current.panelRef.current = handle;

      act(() => result.current.onLayoutChanged({}, BY_LIBRARY));

      expect(handle.resize).toHaveBeenCalledWith(500);
    });

    it('leaves a column that is already where it belongs alone', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle(500, 1400);
      result.current.panelRef.current = handle;

      act(() => result.current.onLayoutChanged({}, BY_LIBRARY));

      expect(handle.resize).not.toHaveBeenCalled();
    });

    it('leaves a sub-pixel difference alone, so restoring does not loop', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle(500.4, 1400);
      result.current.panelRef.current = handle;

      act(() => result.current.onLayoutChanged({}, BY_LIBRARY));

      expect(handle.resize).not.toHaveBeenCalled();
    });

    it('squeezes the column when the window cannot hold the set width', () => {
      window.localStorage.setItem(KEY, '640');
      const { result } = renderHook(() => useAgentColumnWidth());
      // 900 wide row: the space region keeps 420, so the column gets 480.
      const handle = fakeHandle(640, 900);
      result.current.panelRef.current = handle;

      act(() => result.current.onLayoutChanged({}, BY_LIBRARY));

      expect(handle.resize).toHaveBeenCalledWith(480);
    });

    it('never writes the width the library arrived at', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      result.current.panelRef.current = fakeHandle(579, 1400);

      act(() => result.current.onLayoutChanged({}, BY_LIBRARY));

      expect(window.localStorage.getItem(KEY)).toBe('500');
    });
  });

  describe('when the panel is not there to ask', () => {
    it('does nothing without a handle', () => {
      const { result } = renderHook(() => useAgentColumnWidth());
      result.current.panelRef.current = null;

      act(() => result.current.onLayoutChanged({}, BY_USER));

      expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it('does nothing while the panel reports no width', () => {
      window.localStorage.setItem(KEY, '500');
      const { result } = renderHook(() => useAgentColumnWidth());
      const handle = fakeHandle(0, 1400);
      result.current.panelRef.current = handle;

      act(() => result.current.onLayoutChanged({}, BY_LIBRARY));

      expect(handle.resize).not.toHaveBeenCalled();
    });
  });
});
