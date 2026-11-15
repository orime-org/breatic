// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { readFollowField } from '@web/data/yjs/follow-presence';
import { PRESENCE_WRITE_INTERVAL_MS, createPublishThrottle } from '@web/lib/publish-throttle';
import { topBlockId } from '@web/spaces/document/block-scroll';

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
  /** The leader block while following drives the scroll, published unchanged; else null. */
  followTopBlockId: string | null;
}

/**
 * Publish the block at the top of this body as `topBlockId`, for members
 * following this user (#920 design 4.1): on mount, on scroll and on a size
 * change, through the presence write limiter. While following drives the
 * scroll it publishes the leader's block unchanged, so a chain of followers
 * passes it on. Hidden behind the snapshot panel or unmounted, the field is
 * withdrawn at once (`packages/web/AGENTS.md#writes-that-must-land-skip-frame-scheduling`).
 * @param input - The awareness, the body, whether it is paused and the followed block.
 */
export function usePublishTopBlock(input: PublishTopBlockInput): void {
  const { awareness, viewport, root, paused, followTopBlockId } = input;
  const latest = React.useRef({ paused, followTopBlockId });
  latest.current = { paused, followTopBlockId };

  const publish = React.useCallback((): void => {
    if (!awareness || !viewport || !root || latest.current.paused) return;
    const id = latest.current.followTopBlockId ?? topBlockId(viewport, root);
    const state = awareness.getLocalState() ?? {};
    if ((readFollowField(state, 'topBlockId')?.id ?? null) === id) return;
    awareness.setLocalState({ ...state, topBlockId: id === null ? null : { id, at: Date.now() } });
  }, [awareness, viewport, root]);

  const throttle = React.useMemo(
    () => createPublishThrottle(() => publish(), PRESENCE_WRITE_INTERVAL_MS),
    [publish],
  );

  React.useEffect(() => {
    if (!awareness || !viewport || !root || paused) return undefined;
    throttle.schedule();
    /** Ask for a write; the throttle folds a burst of these together. */
    const onMove = (): void => {
      throttle.schedule();
    };
    viewport.addEventListener('scroll', onMove, { passive: true });
    const resize = new ResizeObserver(onMove);
    resize.observe(viewport);
    resize.observe(root);
    return (): void => {
      throttle.cancel();
      viewport.removeEventListener('scroll', onMove);
      resize.disconnect();
      awareness.setLocalState({ ...awareness.getLocalState(), topBlockId: null });
    };
  }, [awareness, viewport, root, paused, throttle]);

  React.useEffect(() => {
    throttle.schedule();
  }, [followTopBlockId, throttle]);
}
