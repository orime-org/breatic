// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { LANDING } from '@web/spaces/document/block-scroll';
import { useDocumentFollow, type DocumentFollowInput } from '@web/spaces/document/use-document-follow';
import { usePublishTopBlock, type PublishTopBlockInput } from '@web/spaces/document/use-publish-top-block';
import { useFollowStore } from '@web/stores/follow';

const CLIENT_HEIGHT = 500;
const docs: Y.Doc[] = [];
const resizeCallbacks = new Map<Element,() => void>();
const realResizeObserver = globalThis.ResizeObserver;

class TriggerableResizeObserver {
  private readonly targets: Element[] = [];
  constructor(private readonly callback: () => void) {}
  observe(target: Element): void {
    this.targets.push(target);
    resizeCallbacks.set(target, this.callback);
  }
  unobserve(target: Element): void {
    resizeCallbacks.delete(target);
  }
  disconnect(): void {
    for (const target of this.targets) resizeCallbacks.delete(target);
  }
}

interface Body {
  viewport: HTMLElement;
  root: HTMLElement;
  lines: Map<string, number>;
  add: (id: string, top: number) => void;
  scrollBy: (dy: number) => void;
}

/**
 * A body whose rects come from the viewport's scrollTop and each block's
 * content top, standing in for layout jsdom does not have.
 * @param blocks - Block id and content top, in document order.
 * @returns The body.
 */
function body(blocks: Array<[string, number]>): Body {
  const viewport = document.createElement('div');
  const root = document.createElement('div');
  root.className = 'doc-body-editor';
  viewport.appendChild(root);
  document.body.appendChild(viewport);
  let scrollTop = 0;
  const scrollHeight = 5000;
  Object.defineProperty(viewport, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => { scrollTop = Math.max(0, Math.min(scrollHeight - CLIENT_HEIGHT, Math.round(v))); },
    configurable: true,
  });
  Object.defineProperty(viewport, 'clientHeight', { get: () => CLIENT_HEIGHT, configurable: true });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => scrollHeight, configurable: true });
  viewport.scrollTo = vi.fn((options: ScrollToOptions) => { viewport.scrollTop = options.top ?? scrollTop; }) as typeof viewport.scrollTo;
  viewport.getBoundingClientRect = (): DOMRect => ({ top: 0, bottom: CLIENT_HEIGHT, left: 0, right: 800, width: 800, height: CLIENT_HEIGHT, x: 0, y: 0, toJSON: () => ({}) });
  const lines = new Map<string, number>();
  const add = (id: string, top: number): void => {
    const outer = document.createElement('div');
    outer.className = 'bn-block-outer';
    outer.dataset.id = id;
    const inner = document.createElement('div');
    inner.className = 'bn-block';
    const content = document.createElement('div');
    content.className = 'bn-block-content';
    inner.appendChild(content);
    outer.appendChild(inner);
    lines.set(id, top);
    const rect = (): DOMRect => {
      const t = (lines.get(id) ?? 0) - scrollTop;
      return { top: t, bottom: t + 24, left: 0, right: 800, width: 800, height: 24, x: 0, y: t, toJSON: () => ({}) };
    };
    content.getBoundingClientRect = rect;
    outer.getBoundingClientRect = rect;
    root.appendChild(outer);
  };
  for (const [id, top] of blocks) add(id, top);
  const scrollBy = (dy: number): void => {
    viewport.scrollTop = scrollTop + dy;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });
  };
  return { viewport, root, lines, add, scrollBy };
}

/**
 * An awareness over a throwaway document.
 * @returns The awareness.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  docs.push(doc);
  return new Awareness(doc);
}

/**
 * Make a peer's state arrive locally.
 * @param local - This client's awareness.
 * @param peer - The peer.
 * @param state - The peer's state.
 */
function arrive(local: Awareness, peer: Awareness, state: Record<string, unknown>): void {
  peer.setLocalState(state);
  act(() => {
    applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote');
  });
}

beforeEach(() => {
  globalThis.ResizeObserver = TriggerableResizeObserver as unknown as typeof ResizeObserver;
  useFollowStore.getState().reset();
  useFollowStore.getState().start('leader');
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  resizeCallbacks.clear();
  for (const doc of docs.splice(0)) doc.destroy();
  document.body.innerHTML = '';
});

describe('useDocumentFollow', () => {
  /**
   * Inputs for one render.
   * @param b - The body.
   * @param awareness - The awareness.
   * @param over - What the case sets.
   * @returns The input.
   */
  function input(b: Body, awareness: Awareness, over: Partial<DocumentFollowInput> = {}): DocumentFollowInput {
    return { awareness, leaderUserId: 'leader', viewport: b.viewport, root: b.root, paused: false, ...over };
  }

  it('scrolls the leader top block to the landing line', () => {
    const b = body([['a', 0], ['b', 1000]]);
    const local = makeAwareness();
    const peer = makeAwareness();
    renderHook(() => useDocumentFollow(input(b, local)));
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'b', at: 1 } });
    expect(b.viewport.scrollTop).toBe(1000 - LANDING);
  });

  it('keeps following through its own alignment and through anchoring', () => {
    const b = body([['a', 0], ['b', 1000]]);
    const local = makeAwareness();
    const peer = makeAwareness();
    renderHook(() => useDocumentFollow(input(b, local)));
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'b', at: 1 } });
    act(() => {
      b.viewport.dispatchEvent(new Event('scroll'));
    });
    b.lines.set('b', 1080);
    b.scrollBy(80);
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('stops when the user scrolls away', () => {
    const b = body([['a', 0], ['b', 1000]]);
    const local = makeAwareness();
    const peer = makeAwareness();
    renderHook(() => useDocumentFollow(input(b, local)));
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'b', at: 1 } });
    b.scrollBy(120);
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
  });

  it('aligns once the leader block appears in the body', async () => {
    const b = body([['a', 0]]);
    const local = makeAwareness();
    const peer = makeAwareness();
    renderHook(() => useDocumentFollow(input(b, local)));
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'late', at: 1 } });
    expect(b.viewport.scrollTop).toBe(0);
    b.add('late', 2000);
    await vi.waitFor(() => expect(b.viewport.scrollTop).toBe(2000 - LANDING));
  });

  it('realigns without stopping when the body column changes width', () => {
    const b = body([['a', 0], ['b', 1000]]);
    const local = makeAwareness();
    const peer = makeAwareness();
    renderHook(() => useDocumentFollow(input(b, local)));
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'b', at: 1 } });
    b.lines.set('b', 1300);
    act(() => resizeCallbacks.get(b.root)?.());
    act(() => {
      b.viewport.dispatchEvent(new Event('scroll'));
    });
    expect(b.viewport.scrollTop).toBe(1300 - LANDING);
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('neither aligns nor stops while paused, and aligns to the latest leader block when resumed', () => {
    const b = body([['a', 0], ['b', 1000], ['c', 2000]]);
    const local = makeAwareness();
    const peer = makeAwareness();
    const { rerender } = renderHook((p: DocumentFollowInput) => useDocumentFollow(p), { initialProps: input(b, local) });
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'b', at: 1 } });
    rerender(input(b, local, { paused: true }));
    b.scrollBy(300);
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'c', at: 2 } });
    expect(useFollowStore.getState().targetUserId).toBe('leader');
    expect(b.viewport.scrollTop).toBe(1000 - LANDING + 300);
    rerender(input(b, local, { paused: false }));
    expect(b.viewport.scrollTop).toBe(2000 - LANDING);
  });

  it('does nothing while not following', () => {
    const b = body([['a', 0], ['b', 1000]]);
    const local = makeAwareness();
    const peer = makeAwareness();
    renderHook(() => useDocumentFollow(input(b, local, { leaderUserId: null })));
    arrive(local, peer, { user: { id: 'leader' }, topBlockId: { id: 'b', at: 1 } });
    expect(b.viewport.scrollTop).toBe(0);
  });
});

describe('usePublishTopBlock', () => {
  /**
   * Read the published field.
   * @param awareness - The awareness.
   * @returns The field, or null.
   */
  function published(awareness: Awareness): { id: string; at: number } | null {
    const state = awareness.getLocalState() as { topBlockId?: { id: string; at: number } | null } | null;
    return state?.topBlockId ?? null;
  }

  /**
   * Inputs for one render.
   * @param b - The body.
   * @param awareness - The awareness.
   * @param over - What the case sets.
   * @returns The input.
   */
  function input(b: Body, awareness: Awareness, over: Partial<PublishTopBlockInput> = {}): PublishTopBlockInput {
    return { awareness, viewport: b.viewport, root: b.root, paused: false, followTopBlockId: null, ...over };
  }

  it('publishes the top block on mount and after a scroll', async () => {
    const b = body([['a', 0], ['b', 1000]]);
    const awareness = makeAwareness();
    renderHook(() => usePublishTopBlock(input(b, awareness)));
    await vi.waitFor(() => expect(published(awareness)?.id).toBe('a'));
    b.scrollBy(1010);
    await vi.waitFor(() => expect(published(awareness)?.id).toBe('b'));
  });

  it('publishes the leader block while follow drives the scroll', async () => {
    const b = body([['a', 0], ['b', 1000]]);
    const awareness = makeAwareness();
    renderHook(() => usePublishTopBlock(input(b, awareness, { followTopBlockId: 'b' })));
    await vi.waitFor(() => expect(published(awareness)?.id).toBe('b'));
  });

  it('withdraws at once while the snapshot panel is open and on unmount', async () => {
    const b = body([['a', 0], ['b', 1000]]);
    const awareness = makeAwareness();
    const { rerender, unmount } = renderHook((p: PublishTopBlockInput) => usePublishTopBlock(p), { initialProps: input(b, awareness) });
    await vi.waitFor(() => expect(published(awareness)).not.toBeNull());
    rerender(input(b, awareness, { paused: true }));
    expect(published(awareness)).toBeNull();
    rerender(input(b, awareness, { paused: false }));
    await vi.waitFor(() => expect(published(awareness)).not.toBeNull());
    unmount();
    expect(published(awareness)).toBeNull();
    expect(awareness.getLocalState()).not.toBeNull();
  });
});
