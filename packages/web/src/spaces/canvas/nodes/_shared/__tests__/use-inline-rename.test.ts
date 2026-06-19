// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useInlineRename } from '@web/spaces/canvas/nodes/_shared/use-inline-rename';

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
