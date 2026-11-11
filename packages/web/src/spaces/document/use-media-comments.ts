// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the body draws on each picture, video and audio block about its
 * comments (inner#1316 §5.4): how many open comments stand on it, and whether
 * it is the one being read — a comment on it is selected, or a draft is
 * aimed at it.
 *
 * Read once for every media block in the body, so a block re-renders only
 * when what it shows moves.
 */

import * as React from 'react';

import { commentsOn } from '@web/spaces/document/document-comment-extension';
import { mediaDraftIn, onDraftChange } from '@web/spaces/document/document-comment-draft-range';
import { mediaBlockIdOf } from '@web/spaces/document/document-comment-media';
import { onSelectedThreadsChange, selectedThreadsIn } from '@web/spaces/document/document-comment-selection';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import { useCachedSnapshot } from '@web/spaces/document/use-editor-snapshot';

/** The comments the body shows on media blocks. */
export interface MediaComments {
  /** Each media block's open comments, by block id; absent for none. */
  readonly open: ReadonlyMap<string, readonly string[]>;
  /** The media blocks being read. */
  readonly reading: ReadonlySet<string>;
}

/** No comments on any media, one object for every such read. */
const NONE: MediaComments = { open: new Map(), reading: new Set() };

/**
 * Whether two readings draw the same.
 * @param a - One.
 * @param b - The other.
 * @returns True when every block shows the same.
 */
function sameMediaComments(a: MediaComments, b: MediaComments): boolean {
  if (a.open.size !== b.open.size || a.reading.size !== b.reading.size) return false;
  for (const [blockId, ids] of a.open) {
    const other = b.open.get(blockId);
    if (other === undefined || other.length !== ids.length || ids.some((id, i) => other[i] !== id)) return false;
  }
  for (const blockId of a.reading) if (!b.reading.has(blockId)) return false;
  return true;
}

/**
 * Reads what each media block shows of its comments, and keeps it current.
 * @param editor - The document editor; one without comments reads as none.
 * @returns The reading.
 */
export function useMediaComments(editor: ToolEditor): MediaComments {
  const comments = commentsOn(editor);

  const subscribe = React.useCallback(
    (onChange: () => void): (() => void) => {
      if (comments === undefined) return () => undefined;
      // The store for comments written, resolved and deleted; the body for
      // blocks coming and going; the two plugins for what is being read.
      const stops = [
        comments.threadStore.subscribe(onChange),
        editor.onChange(onChange),
        onSelectedThreadsChange(onChange),
        onDraftChange(onChange),
      ];
      return () => {
        stops.forEach((stop) => {
          stop();
        });
      };
    },
    [comments, editor],
  );

  const read = React.useCallback((): MediaComments => {
    if (comments === undefined) return NONE;
    const state = editor.prosemirrorState;
    const open = new Map<string, string[]>();
    const owner = new Map<string, string>();
    for (const thread of comments.threadStore.getThreads().values()) {
      const blockId = mediaBlockIdOf(thread.metadata);
      if (blockId === null) continue;
      owner.set(thread.id, blockId);
      if (thread.resolved === true) continue;
      open.set(blockId, [...(open.get(blockId) ?? []), thread.id]);
    }
    const reading = new Set<string>();
    for (const id of selectedThreadsIn(state)) {
      const blockId = owner.get(id);
      if (blockId !== undefined) reading.add(blockId);
    }
    const drafted = mediaDraftIn(state);
    if (drafted !== null) reading.add(drafted);
    return open.size === 0 && reading.size === 0 ? NONE : { open, reading };
  }, [comments, editor]);

  return useCachedSnapshot(subscribe, read, sameMediaComments);
}
