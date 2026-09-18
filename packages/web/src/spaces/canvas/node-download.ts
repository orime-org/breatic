// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which asset a node's Download menu item hands over.
 *
 * The rule is what the reader sees (user 2026-09-13): a node showing content
 * can be downloaded, a node showing an error box or an empty frame cannot —
 * a task running beside it changes nothing, because the body keeps showing
 * whatever it already holds. So this asks exactly what `NodeContent` asks
 * before it renders the body, and answers with the address itself: the
 * item's presence and its target then cannot disagree.
 */

import { asContentView, type NodeView } from '@web/data/yjs/node-view';

/**
 * The asset a node is showing right now, as an address to download.
 * @param data - The node's view, or nothing when the canvas holds no such node.
 * @param tasksPanelOpen - Whether this node's task list is open beside it, which is what puts a failed node's body back on its content (`NodeContent.tsx:59`).
 * @returns The asset URL, or null when the node is showing none.
 */
export function downloadableAsset(
  data: NodeView | undefined,
  tasksPanelOpen: boolean,
): string | null {
  const view = asContentView(data);
  if (view === undefined) return null;
  // The three modalities the node menu offers this on (#2108). Text is not a
  // stored file, and 3d / web are outside what that task asked for.
  if (view.kind !== 'image' && view.kind !== 'video' && view.kind !== 'audio') {
    return null;
  }
  if (view.status === 'error' && !tasksPanelOpen) return null;
  const url = view.content ?? '';
  return url === '' ? null : url;
}
