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

import type { TypedNodeView } from '@web/data/yjs/node-view';

/**
 * The asset a node is showing right now, as an address to download.
 * @param node - The node's type and view, or nothing when the canvas holds no such node.
 * @returns The asset URL, or null when the node is showing none.
 */
export function downloadableAsset(
  node: TypedNodeView | undefined,
): string | null {
  // The three modalities the node menu offers this on (#2108). Text is not a
  // stored file, and 3d / web are outside what that task asked for.
  if (node?.type !== 'image' && node?.type !== 'video' && node?.type !== 'audio') {
    return null;
  }
  const url = node.data.content ?? '';
  return url === '' ? null : url;
}
