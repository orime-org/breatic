// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as React from 'react';

import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { useInlineRename } from '@web/spaces/canvas/nodes/_shared/use-inline-rename';
import { useCanvasStore } from '@web/stores';

/**
 * Wrap the hook in a {@link NodeIdContext} provider so it can match the store's
 * rename mailbox against a known node id (the node wrapper does this in prod).
 * @param nodeId - The node id this rendered hook should answer to.
 * @returns A renderHook `wrapper` component supplying the node id.
 */
function nodeIdWrapper(
  nodeId: string,
): (props: { children: React.ReactNode }) => React.ReactElement {
  return ({ children }) =>
    React.createElement(NodeIdContext.Provider, { value: nodeId }, children);
}

describe('useInlineRename — inline name-edit state machine', () => {
  it('starts not editing with a blank draft', () => {
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30 }),
    );
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBe('');
  });

  it('startEdit opens the editor seeded with the current value', () => {
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30 }),
    );
    act(() => result.current.startEdit());
    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toBe('Group');
  });

  it('startEdit is a no-op in read-only mode', () => {
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30, readOnly: true }),
    );
    act(() => result.current.startEdit());
    expect(result.current.editing).toBe(false);
  });

  it('startEdit is a no-op when locked (lock gates rename)', () => {
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30, locked: true }),
    );
    act(() => result.current.startEdit());
    expect(result.current.editing).toBe(false);
  });

  it('commit reports the trimmed draft and closes the editor', () => {
    const onRename = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30, onRename }),
    );
    act(() => result.current.startEdit());
    act(() => result.current.setDraft('  Scenes  '));
    act(() => result.current.commit());
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Scenes');
    expect(result.current.editing).toBe(false);
  });

  it('commit clips the draft to maxLength', () => {
    const onRename = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({ current: 'x', maxLength: 5, onRename }),
    );
    act(() => result.current.startEdit());
    act(() => result.current.setDraft('abcdefghij'));
    act(() => result.current.commit());
    expect(onRename).toHaveBeenCalledExactlyOnceWith('abcde');
  });

  it('commit leaves the name unchanged when the draft is blank', () => {
    const onRename = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30, onRename }),
    );
    act(() => result.current.startEdit());
    act(() => result.current.setDraft('   '));
    act(() => result.current.commit());
    expect(onRename).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
  });

  it('commit fires at most once (Enter then a trailing blur)', () => {
    const onRename = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30, onRename }),
    );
    act(() => result.current.startEdit());
    act(() => result.current.setDraft('Scenes'));
    act(() => result.current.commit());
    act(() => result.current.commit());
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('enters edit when the rename mailbox targets this node id, then clears it', () => {
    useCanvasStore.setState({ pendingRename: null });
    const { result } = renderHook(
      () => useInlineRename({ current: 'Group', maxLength: 30 }),
      { wrapper: nodeIdWrapper('n-7') },
    );
    expect(result.current.editing).toBe(false);
    act(() => {
      useCanvasStore.getState().requestRename('n-7');
    });
    expect(result.current.editing).toBe(true);
    expect(useCanvasStore.getState().pendingRename).toBeNull();
  });

  it('ignores a rename mailbox targeting a different node id', () => {
    useCanvasStore.setState({ pendingRename: null });
    const { result } = renderHook(
      () => useInlineRename({ current: 'Group', maxLength: 30 }),
      { wrapper: nodeIdWrapper('n-7') },
    );
    act(() => {
      useCanvasStore.getState().requestRename('other');
    });
    expect(result.current.editing).toBe(false);
    expect(useCanvasStore.getState().pendingRename).toBe('other');
  });

  it('does not enter edit when the targeted node is locked (rename frozen), but still clears the mailbox', () => {
    useCanvasStore.setState({ pendingRename: null });
    const { result } = renderHook(
      () => useInlineRename({ current: 'Group', maxLength: 30, locked: true }),
      { wrapper: nodeIdWrapper('n-7') },
    );
    act(() => {
      useCanvasStore.getState().requestRename('n-7');
    });
    expect(result.current.editing).toBe(false);
    expect(useCanvasStore.getState().pendingRename).toBeNull();
  });

  it('displayName bridges the commit→prop gap so the name never flashes the old value (R2-G)', () => {
    const onRename = vi.fn();
    const { result, rerender } = renderHook(
      ({ current }) => useInlineRename({ current, maxLength: 30, onRename }),
      { initialProps: { current: 'Old' } },
    );
    // Before editing, displayName is just the current value.
    expect(result.current.displayName).toBe('Old');
    act(() => result.current.startEdit());
    act(() => result.current.setDraft('New'));
    act(() => result.current.commit());
    // Commit wrote 'New' to Yjs, but the `current` prop is still the stale 'Old'
    // (the Yjs observe hasn't round-tripped yet). displayName already shows the
    // committed 'New', so the editor closing does NOT flash the old name.
    expect(onRename).toHaveBeenCalledWith('New');
    expect(result.current.displayName).toBe('New');
    // Once the Yjs update flows back (current === committed), the bridge clears.
    rerender({ current: 'New' });
    expect(result.current.displayName).toBe('New');
  });

  it('displayName drops the bridge when a concurrent remote rename wins (not stuck on the local name)', () => {
    const onRename = vi.fn();
    const { result, rerender } = renderHook(
      ({ current }) => useInlineRename({ current, maxLength: 30, onRename }),
      { initialProps: { current: 'Old' } },
    );
    act(() => result.current.startEdit());
    act(() => result.current.setDraft('Mine'));
    act(() => result.current.commit());
    expect(result.current.displayName).toBe('Mine');
    // A collaborator renamed it to a DIFFERENT value during the round-trip
    // window. The live value must show — not our stale committed 'Mine'.
    rerender({ current: 'Theirs' });
    expect(result.current.displayName).toBe('Theirs');
  });

  it('cancel closes the editor without reporting a rename', () => {
    const onRename = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({ current: 'Group', maxLength: 30, onRename }),
    );
    act(() => result.current.startEdit());
    act(() => result.current.setDraft('Scenes'));
    act(() => result.current.cancel());
    expect(onRename).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
  });
});
