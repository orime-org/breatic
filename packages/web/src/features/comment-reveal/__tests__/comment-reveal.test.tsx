// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Opening a comment from a link (#1488 §11.6, §11.7): the project page reads
 * which Space and thread to show, opens the Space, and the Space shows the
 * thread or says it is gone.
 */

import * as React from 'react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommentLinkRouting } from '@web/features/comment-reveal/use-comment-link-routing';
import { useCommentRevealReceiver } from '@web/features/comment-reveal/use-comment-reveal-receiver';
import { useCommentRevealStore } from '@web/stores/comment-reveal';

const toastMock = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: toastMock }));

const SPACES = [
  { id: 's-canvas', type: 'canvas' },
  { id: 's-doc', type: 'document' },
  { id: 's-3d', type: '3d' },
] as never;

/**
 * Run the routing hook at a URL and report where the page ends up.
 * @param url - The address the page opened at.
 * @param ready - Whether the project's Spaces have loaded.
 * @returns The open spy and the location the hook left behind.
 */
function route(url: string, ready = true): { open: ReturnType<typeof vi.fn>; location: () => string } {
  const open = vi.fn();
  let where = '';
  renderHook(
    () => {
      useCommentLinkRouting(SPACES, null, open, ready);
      const location = useLocation();
      where = location.pathname + location.search;
    },
    { wrapper: ({ children }: { children: React.ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter> },
  );
  return { open, location: () => where };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCommentRevealStore.setState({ request: null });
});

describe('a link to a comment', () => {
  it('opens its Space, asks it to show the thread, and leaves the address clean', () => {
    const { open, location } = route('/project/p?space=s-doc&comment=t1');
    expect(open).toHaveBeenCalledWith('s-doc');
    expect(useCommentRevealStore.getState().request).toEqual({ spaceId: 's-doc', threadId: 't1' });
    expect(location()).toBe('/project/p');
  });

  it('waits for the project to load', () => {
    const { open } = route('/project/p?space=s-doc&comment=t1', false);
    expect(open).not.toHaveBeenCalled();
    expect(useCommentRevealStore.getState().request).toBeNull();
  });

  it('says the comment is gone when its Space is', () => {
    const { open, location } = route('/project/p?space=s-gone&comment=t1');
    expect(open).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledWith('This comment is no longer here');
    expect(location()).toBe('/project/p');
  });

  it('says the comment is gone when its Space holds no comments', () => {
    route('/project/p?space=s-3d&comment=t1');
    expect(toastMock.warning).toHaveBeenCalled();
    expect(useCommentRevealStore.getState().request).toBeNull();
  });

  it('does nothing on an address without one', () => {
    const { open } = route('/project/p');
    expect(open).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });
});

describe('the Space a comment is shown in', () => {
  it('shows a thread it holds, once', () => {
    useCommentRevealStore.getState().reveal('s-canvas', 't1');
    const show = vi.fn();
    renderHook(() => useCommentRevealReceiver('s-canvas', true, (id) => (id === 't1' ? 'here' : 'gone'), show));
    expect(show).toHaveBeenCalledWith('t1');
    expect(useCommentRevealStore.getState().request).toBeNull();
  });

  it('says a thread it does not hold is gone', () => {
    useCommentRevealStore.getState().reveal('s-canvas', 't9');
    const show = vi.fn();
    renderHook(() => useCommentRevealReceiver('s-canvas', true, () => 'gone', show));
    expect(show).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledWith('This comment is no longer here');
    expect(useCommentRevealStore.getState().request).toBeNull();
  });

  it('leaves a request for another Space, and waits until its own content is in', () => {
    useCommentRevealStore.getState().reveal('s-doc', 't1');
    const show = vi.fn();
    renderHook(() => useCommentRevealReceiver('s-canvas', true, () => 'here', show));
    renderHook(() => useCommentRevealReceiver('s-doc', false, () => 'here', show));
    expect(show).not.toHaveBeenCalled();
    expect(useCommentRevealStore.getState().request).toEqual({ spaceId: 's-doc', threadId: 't1' });
  });

  it('keeps the request while the Space is still reading its content in, and shows it once in', () => {
    useCommentRevealStore.getState().reveal('s-doc', 't1');
    const show = vi.fn();
    let state: 'here' | 'wait' = 'wait';
    const { rerender } = renderHook(({ find }) => useCommentRevealReceiver('s-doc', true, find, show), {
      initialProps: { find: (): 'here' | 'wait' => state },
    });
    expect(show).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(useCommentRevealStore.getState().request).toEqual({ spaceId: 's-doc', threadId: 't1' });
    state = 'here';
    rerender({ find: (): 'here' | 'wait' => state });
    expect(show).toHaveBeenCalledWith('t1');
  });
});
