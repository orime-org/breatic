// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { pickLeaderField } from '@web/data/yjs/follow-presence';
import { FOLLOW_BAR_HEIGHT } from '@web/features/follow/FollowBar';
import {
  LANDING,
  markAlignment,
  rebaseMark,
  scrollTopForBlock,
  stillAligned,
  type AlignmentMark,
} from '@web/spaces/document/block-scroll';
import { stopFollowing, useFollowStore } from '@web/stores/follow';

/** What following a member in a document body needs (#920 design 4.2). */
export interface DocumentFollowInput {
  /** This document Space's awareness, or null before it is attached. */
  awareness: Awareness | null;
  /** The member being followed, or null while not following. */
  leaderUserId: string | null;
  /** The body's scrolling viewport. */
  viewport: HTMLElement | null;
  /** The body element (`.doc-body-editor`) the blocks are looked up in. */
  root: HTMLElement | null;
  /** True while the snapshot panel shows in the same viewport: no aligning and no exit check. */
  paused: boolean;
}

/**
 * Keep the followed member's top block at the top of this body (#920 design
 * 4.2) and stop following once the user scrolls the body themselves.
 *
 * Each alignment scrolls the block's line to the landing below the follow
 * bar, which covers the top of the body, and records where that left the
 * body; a later scroll that still matches the record (the body got shorter,
 * or scroll anchoring kept the block in place) is accepted and the record
 * moves with it, any other is the user's and stops following. A block not yet
 * on the page is aligned once it appears. A change of the body's size aligns
 * again, because a reflowed column moves the block away from the landing in
 * a way anchoring does not undo. Until the leader's block first aligns, the
 * record is where the body stood when following started here, so a scroll
 * by any route (wheel, keys, scrollbar, an outline or comment jump) is judged
 * the same way before and after. While paused, both the aligning and the
 * check rest, and resuming aligns to the leader's latest block.
 * @param input - The awareness, the leader, the body and whether it is paused.
 */
export function useDocumentFollow(input: DocumentFollowInput): void {
  const { awareness, leaderUserId, viewport, root, paused } = input;

  React.useEffect(() => {
    if (!awareness || leaderUserId === null || !viewport || !root || paused) return undefined;
    let mark: AlignmentMark | null = null;
    // The leader value last aligned to, so a peer's unrelated awareness write
    // does not scroll the body again.
    let lastAt: number | null = null;
    // The block waited for while it is not on the page yet.
    let pending: string | null = null;

    /**
     * Whether this hook still follows the leader it was set up for.
     * @returns True while the store says so.
     */
    const following = (): boolean => useFollowStore.getState().targetUserId === leaderUserId;

    /**
     * The leader's current top block on this Space.
     * @returns The block id and its stamp, or null.
     */
    const leaderBlock = (): { id: string; at: number } | null =>
      pickLeaderField(
        awareness.getStates() as ReadonlyMap<number, Record<string, unknown>>,
        leaderUserId,
        'topBlockId',
        awareness.clientID,
      );

    /**
     * Scroll a block to the landing and record the result.
     * @param id - The block to align to.
     */
    const alignTo = (id: string): void => {
      const top = scrollTopForBlock(viewport, root, id, { landing: LANDING + FOLLOW_BAR_HEIGHT });
      if (top === null) {
        pending = id;
        return;
      }
      pending = null;
      viewport.scrollTo({ top, behavior: 'auto' });
      mark = markAlignment(viewport, root, id);
    };

    /**
     * Align to the leader's block when it is new, or always when forced.
     * @param force - Align even when the leader's value has not changed.
     */
    const align = (force: boolean): void => {
      if (!following()) return;
      const block = leaderBlock();
      if (block === null || (!force && block.at === lastAt && pending === null)) return;
      lastAt = block.at;
      alignTo(block.id);
    };

    /** A leader write arrived. */
    const onChange = (): void => {
      align(false);
    };

    /** Tell the user's scroll from one that keeps the alignment. */
    const onScroll = (): void => {
      if (mark === null || !following()) return;
      if (stillAligned(viewport, root, mark)) {
        mark = rebaseMark(viewport, root, mark);
        return;
      }
      mark = null;
      stopFollowing();
    };

    align(true);
    // No leader block aligned yet: judge scrolls against where the body stands now.
    if (mark === null) mark = markAlignment(viewport, root);
    awareness.on('change', onChange);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    // The block may arrive after the leader names it (sync, a peer's insert).
    const arrivals = new MutationObserver(() => {
      if (pending !== null && following()) alignTo(pending);
    });
    arrivals.observe(root, { childList: true, subtree: true });
    const resize = new ResizeObserver(() => {
      if (mark !== null) align(true);
    });
    resize.observe(root);
    return (): void => {
      awareness.off('change', onChange);
      viewport.removeEventListener('scroll', onScroll);
      arrivals.disconnect();
      resize.disconnect();
    };
  }, [awareness, leaderUserId, viewport, root, paused]);
}
