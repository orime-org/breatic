// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';

import { getTextBody } from '@web/data/yjs/canvas-space';

/**
 * What a text node says, read live.
 *
 * Every other modality's content is a plain field the node view carries, so a
 * reader of the node already has it. A text node's words are not there: they
 * live in the shared body the editor binds to, kept out of the view on
 * purpose (#1774) so a keystroke does not re-render the whole canvas. This is
 * the way in for the one place that needs them without being the editor — the
 * history panel, which marks the row the node currently holds.
 *
 * It has to stay live rather than read once: the reader edits the node with
 * the panel open, and the marked row must stop being marked.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space holding the node.
 * @param nodeId - The node to read.
 * @param enabled - False for a host that has no body to read; the hook then
 *   answers null and subscribes to nothing.
 * @returns The body as plain text, or null when disabled / bodyless.
 */
export function useNodeBodyText(
  projectId: string,
  spaceId: string,
  nodeId: string,
  enabled: boolean,
): string | null {
  const body = enabled ? getTextBody(projectId, spaceId, nodeId) : null;
  // Recomputed only when the body reports a change, not on every render:
  // `useSyncExternalStore` calls the snapshot getter each pass, and walking a
  // fragment for its text on every canvas render is work nothing asked for.
  const cache = React.useRef<string | null>(null);

  const subscribe = React.useCallback(
    (onChange: () => void): (() => void) => {
      // A fresh body is a different node's words; the previous one's reading
      // must not survive into it.
      cache.current = null;
      if (!body) return () => {};
      /** Drop the reading and tell React: the words have changed. */
      const handler = (): void => {
        cache.current = null;
        onChange();
      };
      body.observeDeep(handler);
      return () => {
        body.unobserveDeep(handler);
      };
    },
    [body],
  );

  const snapshot = React.useCallback((): string | null => {
    if (!body) return null;
    cache.current ??= bodyToPlainText(body);
    return cache.current;
  }, [body]);

  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}
