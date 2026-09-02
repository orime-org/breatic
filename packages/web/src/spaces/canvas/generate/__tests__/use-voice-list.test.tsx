// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as React from 'react';
import type { VoicePage } from '@breatic/shared';

const list = vi.fn();
vi.mock('@web/data/api/voices', () => ({
  voicesApi: {
    list: (...args: unknown[]) => list(...args),
  },
}));

import { useVoiceList } from '@web/spaces/canvas/generate/use-voice-list';

/**
 * A page of voices.
 * @param ids - The voice ids on this page.
 * @param cursor - The next page's token, when there is one.
 * @returns A voice page.
 */
function page(ids: string[], nextCursor?: string): VoicePage {
  return {
    voices: ids.map((id) => ({ id, name: id })),
    hasMore: nextCursor !== undefined,
    nextCursor,
  };
}

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue(page([]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useVoiceList — asks upstream only when the list is open', () => {
  it('asks for nothing until the picker is opened', () => {
    renderHook(() => useVoiceList('elevenlabs-v3'));
    expect(list).not.toHaveBeenCalled();
  });

  it('fetches the model\'s voices when the picker opens', async () => {
    list.mockResolvedValue(page(['Alice', 'Aria']));
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(list).toHaveBeenCalledWith(
      'elevenlabs-v3',
      expect.objectContaining({ query: '' }),
    );
    expect(result.current.state.voices.map((v) => v.id)).toEqual(['Alice', 'Aria']);
  });

  it('lands on empty when the model has no voices to offer', async () => {
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.status).toBe('empty'));
  });

  it('lands on failed when upstream does not answer', async () => {
    list.mockRejectedValue(new Error('upstream down'));
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
  });

  it('asks again after a failure when the picker is reopened', async () => {
    list.mockRejectedValueOnce(new Error('upstream down'));
    list.mockResolvedValue(page(['Alice']));
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    act(() => result.current.onOpenChange(false));
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
  });

  it('does not ask twice for one open', async () => {
    // The effect runs again whenever anything else in the hook changes; only a
    // new request id is a new request.
    list.mockResolvedValue(page(['Alice']));
    const { result, rerender } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    rerender();
    rerender();
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('useVoiceList — searching', () => {
  it('waits for typing to settle before asking upstream', async () => {
    // Each keystroke empties the list and reloads it; asking per character
    // would flash the list five times for one five-letter search.
    vi.useFakeTimers();
    list.mockResolvedValue(page(['Alice']));
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    list.mockClear();

    act(() => result.current.onQueryChange('A'));
    act(() => result.current.onQueryChange('Al'));
    act(() => result.current.onQueryChange('Ali'));
    // Past the point a zero wait would have fired, still short of the settle
    // window — this is what tells a real wait from no wait at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(list).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      'elevenlabs-v3',
      expect.objectContaining({ query: 'Ali' }),
    );
  });

  it('shows the loading state from the first keystroke', () => {
    // The wait is about which request to send, not about telling the user
    // something is happening.
    vi.useFakeTimers();
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    act(() => result.current.onQueryChange('A'));
    expect(result.current.state.status).toBe('loading');
    expect(result.current.state.query).toBe('A');
  });
});

describe('useVoiceList — paging and model changes', () => {
  it('asks for the next page with the cursor the last one returned', async () => {
    list.mockResolvedValueOnce(page(['Alice'], 'c1'));
    list.mockResolvedValueOnce(page(['Aria']));
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'));
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.hasMore).toBe(true));

    act(() => result.current.onLoadMore());
    await waitFor(() => expect(result.current.state.loadingMore).toBe(false));
    expect(list).toHaveBeenLastCalledWith(
      'elevenlabs-v3',
      expect.objectContaining({ cursor: 'c1' }),
    );
    expect(result.current.state.voices.map((v) => v.id)).toEqual(['Alice', 'Aria']);
  });

  it('drops a page that arrives after the model changed', async () => {
    // The answer is for a model the picker is no longer showing; taking it
    // would offer voices the current model cannot speak with.
    let settle: ((p: VoicePage) => void) | undefined;
    list.mockImplementationOnce(
      () => new Promise<VoicePage>((resolve) => { settle = resolve; }),
    );
    list.mockResolvedValue(page(['Fish voice']));
    const { result, rerender } = renderHook(
      ({ model }: { model: string }) => useVoiceList(model),
      { initialProps: { model: 'elevenlabs-v3' } },
    );
    act(() => result.current.onOpenChange(true));
    // The request has to be IN FLIGHT before the model changes; without this
    // wait the settle window has not elapsed, nothing was ever sent, and the
    // assertion below passes for the wrong reason.
    await waitFor(() => expect(settle).toBeDefined());

    rerender({ model: 'fish-s2-pro' });
    await act(async () => {
      settle?.(page(['Alice', 'Aria']));
    });
    expect(result.current.state.voices.map((v) => v.id)).not.toContain('Alice');
  });

  it('sends exactly one request under StrictMode\'s double effect', async () => {
    // Dev mounts every effect twice. A first page must still be asked for
    // (a guard that skips the second run after the first was torn down asks
    // for none at all), and a next page must be asked for once (two answers
    // for one id append the same voices twice).
    list.mockResolvedValueOnce(page(['Alice'], 'c1'));
    list.mockResolvedValue(page(['Aria']));
    const { result } = renderHook(() => useVoiceList('elevenlabs-v3'), {
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(list).toHaveBeenCalledTimes(1);

    act(() => result.current.onLoadMore());
    await waitFor(() => expect(result.current.state.loadingMore).toBe(false));
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.state.voices.map((v) => v.id)).toEqual(['Alice', 'Aria']);
  });
});
