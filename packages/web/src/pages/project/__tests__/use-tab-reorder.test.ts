// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useTabReorder } from '@web/pages/project/use-tab-reorder';

const A = 'a';
const B = 'b';
const C = 'c';

/**
 * A promise whose settlement a test controls, standing in for one RPC.
 * @returns The promise plus its resolve and reject.
 */
function deferred(): {
  promise: Promise<boolean>;
  resolve: (orderChanged: boolean) => void;
  reject: (err: Error) => void;
  } {
  let resolve!: (orderChanged: boolean) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useTabReorder — what the tab bar renders while a move is in flight', () => {
  it('renders the stored order when nothing is pending', () => {
    const { result } = renderHook(() =>
      useTabReorder([A, B, C], vi.fn(async () => true)),
    );
    expect(result.current.order).toEqual([A, B, C]);
  });

  it('shows the move the moment the user lets go', () => {
    const send = vi.fn(async () => true);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });

    expect(result.current.order).toEqual([C, A, B]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(C, A);
  });

  it('sends one request per drag under StrictMode', async () => {
    // StrictMode runs a state updater twice to check it is pure (measured
    // here: two calls under vitest). Queuing the move from inside one would
    // enqueue it twice, and the copy would go out as soon as the first reply
    // freed the wire — a repeat of a move the server already applied.
    //
    // The await matters: the copy leaves on a microtask behind the first
    // reply, so a synchronous assertion reads the spy before it happens.
    const send = vi.fn(async () => true);
    const { result } = renderHook(() => useTabReorder([A, B, C], send), {
      wrapper: StrictMode,
    });

    await act(async () => {
      result.current.reorder(C, A);
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.order).toEqual([C, A, B]);
  });

  it('sends nothing when the tab lands where it already is', () => {
    const send = vi.fn(async () => true);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(A, B);
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.order).toEqual([A, B, C]);
  });
});

describe('useTabReorder — a second move while the first is still out', () => {
  it('shows both moves but holds the second request back', () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    // On [C, A, B] this really moves something — a second drag that landed
    // where the first one already put the tab would send nothing at all,
    // and would say nothing about whether requests are held back.
    act(() => {
      result.current.reorder(A, null);
    });

    expect(result.current.order).toEqual([C, B, A]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends the second one once the first has answered', async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    act(() => {
      result.current.reorder(A, null);
    });

    await act(async () => {
      first.resolve(true);
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send).toHaveBeenLastCalledWith(A, null);
  });
});

describe('useTabReorder — a broadcast while moves are still owed', () => {
  // collab broadcasts the document update inside the transaction and answers
  // the request afterwards, so the update for move 1 reaches the client before
  // move 1's own reply. Everything here is about that arriving while the layer
  // still owes something.

  it('keeps a queued move when the first one broadcasts', async () => {
    const first = deferred();
    const second = deferred();
    const send = vi
      .fn<(spaceId: string, before: string | null) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    act(() => {
      result.current.reorder(A, null);
    });
    expect(result.current.order).toEqual([C, B, A]);

    rerender({ ids: [C, A, B] });
    expect(result.current.order).toEqual([C, B, A]);

    await act(async () => {
      first.resolve(true);
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send).toHaveBeenLastCalledWith(A, null);
  });

  it('keeps the wire busy until the reply for what is on it arrives', async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    // Somebody else's tab:open lands while the reorder is still out.
    rerender({ ids: [A, B, C, 'd'] });
    act(() => {
      result.current.reorder(A, null);
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a queued move that lands the strip back where it started', async () => {
    // Drag out and drag back: the layer now reads exactly like the document,
    // so comparing the two says "done" while two moves are still owed.
    const first = deferred();
    const second = deferred();
    const send = vi
      .fn<(spaceId: string, before: string | null) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    act(() => {
      result.current.reorder(C, null);
    });
    expect(result.current.order).toEqual([A, B, C]);
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(true);
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send).toHaveBeenLastCalledWith(C, null);
  });

  it('holds the wire when the broadcast beats its own reply', async () => {
    // The ordinary case: collab broadcasts inside the transaction and answers
    // afterwards. The document matches the layer while the reply is still out,
    // and treating that as done would hand the wire to the next drag.
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    rerender({ ids: [C, A, B] });
    act(() => {
      result.current.reorder(A, null);
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends the queued move when the first came back idempotent', async () => {
    const first = deferred();
    const second = deferred();
    const send = vi
      .fn<(spaceId: string, before: string | null) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    act(() => {
      result.current.reorder(A, null);
    });

    await act(async () => {
      first.resolve(false);
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    // The server wrote nothing for the first move, so the document will never
    // show it and the strip stops showing it either. The second is still owed
    // and stays laid over what the document does say.
    expect(result.current.order).toEqual([B, C, A]);
  });
});

describe('useTabReorder — the document changing under a move', () => {
  // The document is shared: a collaborator deleting a Space strips its id from
  // every tab list, and this account's other machine opens and closes tabs.
  // Any of those can merge into the arrival that carries this move.

  it('shows a tab somebody else opened while the move is out', async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    // The move lands in the document alongside somebody else's tab:open.
    rerender({ ids: [C, A, B, 'd'] });
    await act(async () => {
      first.resolve(true);
    });

    expect(result.current.order).toEqual([C, A, B, 'd']);
  });

  it('lets a tab go the moment the document drops it', async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    // A collaborator deletes B before this move has been answered.
    rerender({ ids: [A, C] });

    expect(result.current.order).toEqual([C, A]);
  });

  it('keeps showing a move the document has not caught up with', () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    rerender({ ids: [A, B, C, 'd'] });

    // The move is still owed, so it is still laid over whatever arrived.
    expect(result.current.order).toEqual([C, A, B, 'd']);
  });
});

describe('useTabReorder — when the pending order is let go of', () => {
  it('holds the move on screen until the broadcast lands', async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    await act(async () => {
      first.resolve(true);
    });

    // The reply is in but the document has not caught up. Dropping the
    // layer here would flash the old order back.
    expect(result.current.order).toEqual([C, A, B]);

    rerender({ ids: [C, A, B] });
    await waitFor(() => {
      expect(result.current.order).toEqual([C, A, B]);
    });
  });

  it('ignores a fresh array carrying the same ids', async () => {
    // Presence heartbeats rerun the projection, handing back a new array
    // with identical contents. That is not the broadcast being waited on.
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as readonly string[] } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    await act(async () => {
      first.resolve(true);
    });

    rerender({ ids: [A, B, C] });

    expect(result.current.order).toEqual([C, A, B]);
  });

  it('drops it at once when the server changed nothing', async () => {
    // An idempotent reorder writes nothing, so no broadcast is coming and
    // waiting for one would strand the layer on screen for good.
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    await act(async () => {
      first.resolve(false);
    });

    await waitFor(() => {
      expect(result.current.order).toEqual([A, B, C]);
    });
  });

  it('drops it at once when the request failed', async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    await act(async () => {
      first.reject(new Error('unreachable'));
    });

    await waitFor(() => {
      expect(result.current.order).toEqual([A, B, C]);
    });
  });

  it('drops the whole layer when one of several requests failed', async () => {
    const first = deferred();
    const second = deferred();
    const send = vi
      .fn<(spaceId: string, before: string | null) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    act(() => {
      result.current.reorder(A, null);
    });
    await act(async () => {
      first.resolve(true);
    });
    await act(async () => {
      second.reject(new Error('unreachable'));
    });

    await waitFor(() => {
      expect(result.current.order).toEqual([A, B, C]);
    });
  });

  it('carries the next drag after a request failed', async () => {
    // A failure puts the strip back and empties the run. It does not end the
    // strip's ability to reorder — the user drags again and that one goes out.
    const first = deferred();
    const second = deferred();
    const send = vi
      .fn<(spaceId: string, before: string | null) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useTabReorder([A, B, C], send));

    act(() => {
      result.current.reorder(C, A);
    });
    await act(async () => {
      first.reject(new Error('unreachable'));
    });
    act(() => {
      result.current.reorder(C, A);
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it('carries the next drag after a move settled by both routes at once', async () => {
    // The other connection made this same move: its broadcast settles the one
    // on the wire, and then that request's own reply says the server found
    // nothing left to write. Both routes retire the same move, and the strip
    // still sends what the user drags next.
    const first = deferred();
    const second = deferred();
    const send = vi
      .fn<(spaceId: string, before: string | null) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ ids }) => useTabReorder(ids, send),
      { initialProps: { ids: [A, B, C] as ReadonlyArray<string> } },
    );

    act(() => {
      result.current.reorder(C, A);
    });
    rerender({ ids: [C, A, B] });
    await act(async () => {
      first.resolve(false);
    });
    act(() => {
      result.current.reorder(A, null);
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
