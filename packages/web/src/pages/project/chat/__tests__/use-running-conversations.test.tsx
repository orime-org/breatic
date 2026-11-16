// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which rows of the conversation list are marked running (#1394).
 *
 * Two sources: turns running on this page, held in `stores/running-turns`,
 * and what the server says is running anywhere for this user in this project.
 * The server's answer only counts when it was fetched during the current open
 * of the list and the last fetch did not fail; a cached answer from an earlier
 * open can name turns that ended long ago.
 *
 * The client here carries the app's own defaults (30 s stale time, no refetch
 * on focus, retries) so every case shows the hook overriding them rather than
 * leaning on a test-only client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

const POLL_MS = 7000;

const { running } = vi.hoisted(() => ({
  running: vi.fn<(projectId: string) => Promise<string[]>>(),
}));

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    running: (projectId: string) => running(projectId),
    streamConfig: async () => ({
      heartbeatIntervalMs: 5000,
      attachmentMaxChars: 200_000,
      attachmentMaxItems: 10,
      currentSpaceMaxChars: 100_000,
      spaceListMaxItems: 200,
      spaceReadTimeoutMs: 10_000,
      runningPollIntervalMs: POLL_MS, syncIntervalMs: 3_000,
    }),
  },
}));

import { useRunningConversations } from '@web/pages/project/chat/use-running-conversations';
import { clearRunningTurns, noteTurnRunning, noteTurnSettled } from '@web/stores/running-turns';

/** A promise the case settles when it chooses. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Make a promise the case settles itself.
 * @returns It, with its two settlers.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What the tab's visibility reads as; jsdom's own is not ours to steer. */
let visibility: DocumentVisibilityState = 'visible';

let client: QueryClient;
let unmount: (() => void) | undefined;

/**
 * Mount the hook for project p-1.
 * @param open - Whether the list starts open.
 * @returns The hook's latest answer and a way to open or close the list.
 */
function mount(open: boolean): {
  marked: () => ReadonlySet<string>;
  setOpen: (next: boolean) => void;
} {
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(({ isOpen }: { isOpen: boolean }) => useRunningConversations('p-1', isOpen), {
    initialProps: { isOpen: open },
    wrapper,
  });
  unmount = view.unmount;
  return {
    marked: () => view.result.current,
    setOpen: (next) => view.rerender({ isOpen: next }),
  };
}

/**
 * Run the timers due now and the promises they release.
 *
 * One millisecond a step rather than zero: React Query hands its updates to
 * React through a `setTimeout(0)` queued while the clock is being advanced,
 * and an advance of zero leaves that one waiting -- the hook then still
 * returns the answer before last.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

/**
 * Move the fake clock on, inside act.
 * @param ms - How far.
 */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

/** The window gets focus back, the tab having stayed visible. */
async function windowFocus(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await flush();
}

/**
 * The tab's visibility changes, which is what React Query itself listens to.
 * @param state - What it changes to.
 */
function becomes(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
  running.mockReset();
  client = new QueryClient({
    defaultOptions: {
      // As `app/providers/QueryClientProvider.tsx` sets them.
      queries: { staleTime: 30_000, retry: 3, refetchOnWindowFocus: false },
    },
  });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  client.clear();
  clearRunningTurns();
  // Own properties over the prototype's getters; deleting them restores jsdom's.
  delete (document as { visibilityState?: unknown }).visibilityState;
  delete (document as { hidden?: unknown }).hidden;
  vi.useRealTimers();
});

describe('asking the server', () => {
  it('asks for this project when the list opens and marks what comes back, under the shared key', async () => {
    running.mockResolvedValueOnce(['c-1']);
    const { marked } = mount(true);
    await flush();

    expect(running).toHaveBeenCalledTimes(1);
    expect(running).toHaveBeenCalledWith('p-1');
    expect(marked().has('c-1')).toBe(true);
    expect(client.getQueryData(['chat', 'running', 'p-1'])).toEqual(['c-1']);
  });

  it('asks again every time the list opens, even with an answer cached from the last open', async () => {
    running.mockResolvedValue(['c-1']);
    const { setOpen } = mount(true);
    await flush();
    expect(running).toHaveBeenCalledTimes(1);

    act(() => setOpen(false));
    await wait(1000);
    act(() => setOpen(true));
    await flush();

    expect(running).toHaveBeenCalledTimes(2);
  });

  it('does not mark what the last open was told until this open has its own answer', async () => {
    running.mockResolvedValueOnce(['c-1']);
    const { marked, setOpen } = mount(true);
    await flush();
    expect(marked().has('c-1')).toBe(true);

    act(() => setOpen(false));
    await wait(1000);
    const now = deferred<string[]>();
    running.mockReturnValueOnce(now.promise);
    act(() => setOpen(true));
    await flush();

    // The cached answer is handed back first and may name a turn long over.
    expect(running).toHaveBeenCalledTimes(2);
    expect(marked().has('c-1')).toBe(false);

    await act(async () => now.resolve(['c-2']));
    await flush();

    expect(marked().has('c-2')).toBe(true);
    expect(marked().has('c-1')).toBe(false);
  });
});

describe('coming back to the window', () => {
  it('asks again when the window regains focus while the tab stayed visible', async () => {
    running.mockResolvedValue([]);
    mount(true);
    await flush();
    expect(running).toHaveBeenCalledTimes(1);

    await windowFocus();

    expect(running).toHaveBeenCalledTimes(2);
  });

  it('asks again when the tab becomes visible', async () => {
    running.mockResolvedValue([]);
    mount(true);
    await flush();
    act(() => becomes('hidden'));
    await flush();
    expect(running).toHaveBeenCalledTimes(1);

    act(() => becomes('visible'));
    await flush();

    expect(running).toHaveBeenCalledTimes(2);
  });

  it('asks once when the tab becomes visible and the window takes focus in the same moment', async () => {
    running.mockResolvedValue([]);
    mount(true);
    await flush();
    act(() => becomes('hidden'));
    await flush();
    const back = deferred<string[]>();
    running.mockReturnValueOnce(back.promise);

    // In the order a browser delivers them: React Query's refetch for the
    // visibility change starts a few microtasks after the event (its focus
    // listener awaits paused mutations first), and the window's focus follows.
    await act(async () => {
      becomes('visible');
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    expect(running).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    // The focus joins the ask already out instead of cancelling and resending it.
    expect(running).toHaveBeenCalledTimes(2);
  });

  it('does not ask on focus while the list is closed', async () => {
    running.mockResolvedValue([]);
    const { setOpen } = mount(true);
    await flush();
    act(() => setOpen(false));
    await flush();

    await windowFocus();

    expect(running).toHaveBeenCalledTimes(1);
  });
});

describe('polling', () => {
  it('asks again every configured interval while the last answer names a running conversation, and stops once it names none', async () => {
    running
      .mockResolvedValueOnce(['c-1'])
      .mockResolvedValueOnce(['c-1'])
      .mockResolvedValueOnce([]);
    const { marked } = mount(true);
    await flush();
    expect(running).toHaveBeenCalledTimes(1);

    await wait(POLL_MS - 100);
    expect(running).toHaveBeenCalledTimes(1);
    await wait(100);
    expect(running).toHaveBeenCalledTimes(2);

    await wait(POLL_MS);
    expect(running).toHaveBeenCalledTimes(3);
    expect(marked().has('c-1')).toBe(false);

    await wait(POLL_MS * 3);
    expect(running).toHaveBeenCalledTimes(3);
  });

  it('does not poll when the answer names nothing', async () => {
    running.mockResolvedValue([]);
    mount(true);
    await flush();

    await wait(POLL_MS * 3);

    expect(running).toHaveBeenCalledTimes(1);
  });
});

describe('a failed ask', () => {
  it('stops marking what the last good answer named, and marks it again once an ask succeeds', async () => {
    running.mockResolvedValueOnce(['c-1']);
    const { marked } = mount(true);
    await flush();
    expect(marked().has('c-1')).toBe(true);

    running.mockRejectedValueOnce(new Error('server unavailable'));
    await windowFocus();
    expect(running).toHaveBeenCalledTimes(2);
    expect(marked().has('c-1')).toBe(false);

    running.mockResolvedValueOnce(['c-1']);
    await windowFocus();
    expect(running).toHaveBeenCalledTimes(3);
    expect(marked().has('c-1')).toBe(true);
  });
});

describe('turns of this page', () => {
  it('marks a conversation running on this page whatever the server says', async () => {
    running.mockResolvedValue([]);
    const { marked } = mount(true);
    await flush();

    act(() => noteTurnRunning('c-9'));
    await flush();

    expect(marked().has('c-9')).toBe(true);
  });

  it('asks again the moment a turn of this page ends, after this open already has its answer', async () => {
    running.mockResolvedValueOnce(['c-1']);
    const { marked } = mount(true);
    await flush();
    act(() => noteTurnRunning('c-1'));
    await flush();
    const before = running.mock.calls.length;

    running.mockResolvedValueOnce([]);
    act(() => noteTurnSettled('c-1'));
    await flush();

    expect(running).toHaveBeenCalledTimes(before + 1);
    expect(marked().has('c-1')).toBe(false);
  });

  it('drops the ask in flight and asks again when a turn ends before this open has its first answer', async () => {
    running.mockResolvedValueOnce(['c-1']);
    const { marked, setOpen } = mount(true);
    await flush();
    act(() => setOpen(false));
    await wait(1000);

    // Reopened with the last open's answer cached; this open's first ask is out.
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    running.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    act(() => setOpen(true));
    await flush();
    act(() => noteTurnRunning('c-1'));
    act(() => noteTurnSettled('c-1'));
    await flush();

    // The ask that went out before the turn ended can still name it.
    expect(running).toHaveBeenCalledTimes(3);

    await act(async () => {
      first.resolve(['c-1']);
      second.resolve([]);
    });
    await flush();

    expect(marked().has('c-1')).toBe(false);
  });
});

describe('what the list is handed', () => {
  it('keeps the same set when a poll brings back the same ids, so the memoized list does not redraw', async () => {
    running.mockResolvedValue(['c-1']);
    const { marked } = mount(true);
    await flush();
    const first = marked();
    expect(first.has('c-1')).toBe(true);

    await wait(POLL_MS);
    expect(running).toHaveBeenCalledTimes(2);
    expect(marked()).toBe(first);
  });
});
