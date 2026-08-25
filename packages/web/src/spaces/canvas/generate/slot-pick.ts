// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The predicate every slot pick shares.
 *
 * A slot holds ONE pick copied off a canvas node at pick time — the image
 * panel's style reference (#1664), the video panel's first and end frames
 * (#1896 / #1904), its character image, its driving video (#1918) and its
 * driving audio (#1935). Asking the question in one place is what stops them
 * from drifting into different answers to "can I pick this", which is the
 * failure a second slot invites.
 *
 * The pick is one asset URL for most slots; a slot taking something an
 * `<img>` cannot paint copies the node's poster alongside it, which is what
 * {@link pickedSlotCover} is for.
 *
 * WHICH node type a slot takes is the caller's to state: a video slot reads it
 * off `VIDEO_SLOTS`, so the registry stays the one place a slot's accepted
 * type is written and the click path agrees with the candidate highlighting by
 * construction. Deliberately not imported here — the style slot uses this
 * predicate too and has nothing to do with the video registry.
 *
 * What it does NOT decide is what happens next: style and the frame slots
 * write different fields and mean different things to the model, so each pick
 * branch keeps its own write.
 */

import type { NodeType } from '@breatic/shared';

/** The parts of a clicked canvas node a slot pick judges. */
export interface ClickedNode {
  /** The node's modality (`image` / `video` / `audio` / …). */
  type?: string;
  /**
   * The node's live data map; `content` is its asset URL when filled and
   * `coverUrl` the poster a video node carries alongside it.
   */
  data?: { content?: unknown; coverUrl?: unknown };
}

/**
 * The asset URL a slot pick should copy from the clicked node.
 *
 * Judges the CLICKED NODE's own type, never the reference rail: the rail only
 * holds nodes already wired to the target, while a slot pick roams the whole
 * canvas — testing against the rail would reject every candidate.
 *
 * `content` is read defensively even though the node view is typed: node data
 * is a CRDT map any client may write, and a non-string coerced into the slot
 * would put `[object Object]` in the panel and on the wire.
 * @param node - The node the user clicked during a slot pick.
 * @param accepts - The node type this slot takes.
 * @returns The URL to copy, or null when this node cannot fill the slot.
 */
export function pickedSlotUrl(
  node: ClickedNode,
  accepts: NodeType,
): string | null {
  if (node.type !== accepts) return null;
  const content = node.data?.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/**
 * The poster a slot should copy alongside the asset, when it needs one.
 *
 * A slot shows its pick with an `<img>`, which paints nothing for a video URL
 * — and with `alt=''` not even a broken-image marker, just a blank square. A
 * slot taking something other than an image therefore copies the node's poster
 * too, inside the slot's one field (`VideoSlotSpec.storesCover`).
 *
 * Read as defensively as the asset itself: node data is a CRDT map any client
 * may write. A node with no poster yet gives null, and the slot falls back to
 * the asset node's icon rather than showing an empty frame (#1946).
 * @param node - The node the user clicked during a slot pick.
 * @returns The poster URL to copy, or null when the node has none.
 */
export function pickedSlotCover(node: ClickedNode): string | null {
  const cover = node.data?.coverUrl;
  return typeof cover === 'string' && cover.length > 0 ? cover : null;
}
