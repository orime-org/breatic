// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { readFollowField } from '@web/data/yjs/follow-presence';
import { PRESENCE_WRITE_INTERVAL_MS, createPublishThrottle } from '@web/lib/publish-throttle';
import { topBlockId } from '@web/spaces/document/block-scroll';
import { useFollowStore } from '@web/stores/follow';

/** What publishing the body's top block needs (#920 design 4.1). */
export interface PublishTopBlockInput {
  /** This document Space's awareness, or null before it is attached. */
  awareness: Awareness | null;
  /** The body's scrolling viewport. */
  viewport: HTMLElement | null;
  /** The body element (`.doc-body-editor`). */
  root: HTMLElement | null;
  /** True while the snapshot panel covers the body: nothing is published. */
  paused: boolean;
}

/**
 * Publish the block at the top of this body as `topBlockId`, for members
 * following this user (#920 design 4.1): on mount, on scroll and on a size
 * change, through the presence write limiter. A restore from the bfcache,
 * which empties the local state, publishes again. Hidden behind the snapshot
 * panel, unmounted or while this tab follows a member (whose view it shows,
 * not one of its own), the field is withdrawn at once
 * (`packages/web/AGENTS.md#writes-that-must-land-skip-frame-scheduling`).
 * @param input - The awareness, the body and whether it is paused.
 */
export function usePublishTopBlock(input: PublishTopBlockInput): void {
  const following = useFollowStore((s) => s.targetUserId !== null);
  const off = input.paused || following;
  const { awareness, viewport, root } = input;
  const latest = React.useRef(off);
  latest.current = off;

  const publish = React.useCallback((): void => {
    if (!awareness || !viewport || !root || latest.current) return;
    const id = topBlockId(viewport, root);
    const state = awareness.getLocalState() ?? {};
    if ((readFollowField(state, 'topBlockId')?.id ?? null) === id) return;
    awareness.setLocalState({ ...state, topBlockId: id === null ? null : { id, at: Date.now() } });
  }, [awareness, viewport, root]);

  const throttle = React.useMemo(
    () => createPublishThrottle(() => publish(), PRESENCE_WRITE_INTERVAL_MS),
    [publish],
  );

  React.useEffect(() => {
    if (!awareness || !viewport || !root || off) return undefined;
    throttle.schedule();
    /** Ask for a write; the throttle folds a burst of these together. */
    const onMove = (): void => {
      throttle.schedule();
    };
    /**
     * Publish again after a restore from the bfcache.
     * @param event - The pageshow event; `persisted` is true only on a restore.
     */
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) throttle.schedule();
    };
    viewport.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('pageshow', onPageShow);
    const resize = new ResizeObserver(onMove);
    resize.observe(viewport);
    resize.observe(root);
    return (): void => {
      throttle.cancel();
      viewport.removeEventListener('scroll', onMove);
      window.removeEventListener('pageshow', onPageShow);
      resize.disconnect();
      awareness.setLocalState({ ...awareness.getLocalState(), topBlockId: null });
    };
  }, [awareness, viewport, root, off, throttle]);
}
