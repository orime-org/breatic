// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useItemSlugCheck } from '@web/pages/studio/container/dialogs/use-item-slug-check';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useItemSlugCheck', () => {
  it('is empty while nothing has been typed', () => {
    const { result } = renderHook(() => useItemSlugCheck(''));
    expect(result.current).toEqual({ state: 'empty' });
  });

  it('is empty for whitespace only', () => {
    const { result } = renderHook(() => useItemSlugCheck('   '));
    expect(result.current).toEqual({ state: 'empty' });
  });

  it('is checking until typing pauses, then valid for a well-formed slug', () => {
    const { result, rerender } = renderHook(({ v }) => useItemSlugCheck(v), {
      initialProps: { v: '' },
    });
    rerender({ v: 'my-project' });
    expect(result.current).toEqual({ state: 'checking' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ state: 'valid' });
  });

  it('reports the length reason for a slug that is too short', () => {
    const { result, rerender } = renderHook(({ v }) => useItemSlugCheck(v), {
      initialProps: { v: '' },
    });
    rerender({ v: 'abc' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ state: 'invalid', reason: 'length' });
  });

  it('reports the format reason for a slug starting with a digit', () => {
    const { result, rerender } = renderHook(({ v }) => useItemSlugCheck(v), {
      initialProps: { v: '' },
    });
    rerender({ v: '1-project' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ state: 'invalid', reason: 'format' });
  });

  it('checks the trimmed value, the same one the dialog submits', () => {
    const { result, rerender } = renderHook(({ v }) => useItemSlugCheck(v), {
      initialProps: { v: '' },
    });
    rerender({ v: '  my-project  ' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ state: 'valid' });
  });
});
