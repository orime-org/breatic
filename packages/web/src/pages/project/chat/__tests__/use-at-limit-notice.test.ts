// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTICE_LINGERS_MS } from '@web/pages/project/chat/notice-timing';
import { useAtLimitNotice } from '@web/pages/project/chat/use-at-limit-notice';

const LIMIT = 10;

describe('the word about a full box is a thing that happened', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says nothing while there is still room', () => {
    const { result } = renderHook(() => useAtLimitNotice(LIMIT - 1, LIMIT));
    expect(result.current.showing).toBe(false);
  });

  it('says it the moment the text reaches the limit', () => {
    const { result, rerender } = renderHook(({ n }) => useAtLimitNotice(n, LIMIT), {
      initialProps: { n: LIMIT - 1 },
    });
    expect(result.current.showing).toBe(false);

    rerender({ n: LIMIT });
    expect(result.current.showing).toBe(true);
  });

  it('stops saying it on its own, with the text still at the limit', () => {
    const { result, rerender } = renderHook(({ n }) => useAtLimitNotice(n, LIMIT), {
      initialProps: { n: LIMIT - 1 },
    });
    rerender({ n: LIMIT });
    expect(result.current.showing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(NOTICE_LINGERS_MS);
    });
    expect(result.current.showing).toBe(false);
  });

  it('says it again for a keystroke the box refused after it went quiet', () => {
    const { result, rerender } = renderHook(({ n }) => useAtLimitNotice(n, LIMIT), {
      initialProps: { n: LIMIT - 1 },
    });
    rerender({ n: LIMIT });
    act(() => {
      vi.advanceTimersByTime(NOTICE_LINGERS_MS);
    });
    expect(result.current.showing).toBe(false);

    act(() => {
      result.current.sayAgain();
    });
    expect(result.current.showing).toBe(true);
  });

  it('starts the wait over on every refused keystroke', () => {
    const { result, rerender } = renderHook(({ n }) => useAtLimitNotice(n, LIMIT), {
      initialProps: { n: LIMIT - 1 },
    });
    rerender({ n: LIMIT });

    act(() => {
      vi.advanceTimersByTime(NOTICE_LINGERS_MS - 1);
      result.current.sayAgain();
    });
    act(() => {
      vi.advanceTimersByTime(NOTICE_LINGERS_MS - 1);
    });
    expect(result.current.showing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.showing).toBe(false);
  });

  it('goes quiet at once when a character is deleted', () => {
    const { result, rerender } = renderHook(({ n }) => useAtLimitNotice(n, LIMIT), {
      initialProps: { n: LIMIT - 1 },
    });
    rerender({ n: LIMIT });
    expect(result.current.showing).toBe(true);

    rerender({ n: LIMIT - 1 });
    expect(result.current.showing).toBe(false);
  });

  it('says nothing about a draft that was already full when it opened', () => {
    const { result } = renderHook(() => useAtLimitNotice(LIMIT, LIMIT));
    expect(result.current.showing).toBe(false);
  });

  it('says it again when the text comes back to the limit', () => {
    const { result, rerender } = renderHook(({ n }) => useAtLimitNotice(n, LIMIT), {
      initialProps: { n: LIMIT },
    });
    act(() => {
      vi.advanceTimersByTime(NOTICE_LINGERS_MS);
    });
    rerender({ n: LIMIT - 1 });
    rerender({ n: LIMIT });
    expect(result.current.showing).toBe(true);
  });
});
