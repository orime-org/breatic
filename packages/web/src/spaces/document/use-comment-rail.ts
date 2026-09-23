// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The live reading behind the panel and the dot (#18, A4 · A5).
 *
 * {@link commentRail} decides the order and the groups; this is where its two
 * inputs come from. They sit apart, and both are needed to say what a card is:
 * the threads in the store, the marks' reach in the extension's own state.
 * Neither store is React's, so both are subscribed to.
 *
 * IDENTITY IS PART OF THE CONTRACT. The position table is recomputed on every
 * document change (`comments/extension.ts:197-211`), so a reading that built a
 * fresh object each time would re-render the panel on every keystroke —
 * `useSyncExternalStore` compares snapshots by identity. The cache hands back
 * the previous reading whenever the cards and their states are unchanged,
 * which is nearly always: typing moves offsets, and offsets only matter here
 * through the order they produce.
 *
 * An editor built without comments reads as an empty rail rather than
 * throwing. Only the document Space registers the extension, and the same
 * chrome is mounted over editors that do not.
 */

import * as React from 'react';

import {
  commentRail,
  type CommentRail,
  type RailCard,
} from '@web/spaces/document/document-comment-rail';
import { commentsOn } from '@web/spaces/document/document-comment-extension';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/** What an editor with no comments reads as, one object for every such read. */
const EMPTY_RAIL: CommentRail = {
  unresolved: [],
  resolved: [],
};


/**
 * Whether two readings draw the same panel.
 *
 * Only what is drawn is compared: which cards, in which order, in which
 * state. Offsets are deliberately left out — they move on every keystroke and
 * reach the panel only through the order they already produced.
 * @param a - The previous reading.
 * @param b - The one just taken.
 * @returns True when the panel would look the same.
 */
function sameRail(a: CommentRail, b: CommentRail): boolean {
  return (
    sameCards(a.unresolved, b.unresolved) && sameCards(a.resolved, b.resolved)
  );
}

/**
 * Whether two groups hold the same cards in the same order.
 * @param a - One group.
 * @param b - The other.
 * @returns True when they match card for card.
 */
function sameCards(a: readonly RailCard[], b: readonly RailCard[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (card, index) =>
        card.id === b[index]?.id && card.settled === b[index]?.settled,
    )
  );
}

/**
 * Reads what the panel and the `⋯` button draw, and keeps it current.
 * @param editor - The document editor.
 * @returns The two groups, each in body order.
 */
export function useCommentRail(editor: ToolEditor): CommentRail {
  const comments = commentsOn(editor);
  const cached = React.useRef<CommentRail>(EMPTY_RAIL);

  const subscribe = React.useCallback(
    (onChange: () => void): (() => void) => {
      if (comments === undefined) return () => undefined;
      // Both, because either can change what a card says without the other
      // moving: resolving touches only the store, deleting the text only the
      // positions.
      const stopThreads = comments.threadStore.subscribe(onChange);
      const stopPositions = comments.store.subscribe(onChange);
      return () => {
        stopThreads();
        stopPositions();
      };
    },
    [comments],
  );

  const read = React.useCallback((): CommentRail => {
    if (comments === undefined) return EMPTY_RAIL;
    const threads = [...comments.threadStore.getThreads().values()];
    const next = commentRail(threads, comments.store.state.threadPositions);
    if (sameRail(cached.current, next)) return cached.current;
    cached.current = next;
    return next;
  }, [comments]);

  return React.useSyncExternalStore(subscribe, read, read);
}
