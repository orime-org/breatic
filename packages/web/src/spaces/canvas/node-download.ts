// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which asset a node's Download menu item hands over.
 *
 * The rule is what the reader sees (user 2026-09-18): a node showing content
 * can be downloaded, an empty frame cannot. A node shows no task state
 * (inner#888 §7.8), so what its tasks did changes nothing. It answers with the
 * address itself: the item's presence and its target then cannot disagree.
 */

import { asContentView, type NodeView } from '@web/data/yjs/node-view';

/**
 * The asset a node is showing right now, as an address to download.
 * @param data - The node's view, or nothing when the canvas holds no such node.
 * @returns The asset URL, or null when the node is showing none.
 */
export function downloadableAsset(
  data: NodeView | undefined,
): string | null {
  const view = asContentView(data);
  if (view === undefined) return null;
  // The three modalities the node menu offers this on (#2108). Text is not a
  // stored file, and 3d / web are outside what that task asked for.
  if (view.kind !== 'image' && view.kind !== 'video' && view.kind !== 'audio') {
    return null;
  }
  const url = view.content ?? '';
  return url === '' ? null : url;
}
