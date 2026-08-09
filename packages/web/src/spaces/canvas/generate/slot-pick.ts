// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The predicate every image-slot pick shares.
 *
 * A slot holds ONE image copied off a canvas node at pick time — the image
 * panel's style reference (#1664) and the video panel's first frame (#1896)
 * are both of this shape, and both accept exactly the same thing. Asking the
 * question in one place is what stops them from drifting into two different
 * answers to "can I pick this", which is the failure a second slot invites.
 *
 * What it does NOT decide is what happens next: style and first frame write
 * different fields and mean different things to the model, so each pick
 * branch keeps its own write.
 */

/** The parts of a clicked canvas node a slot pick judges. */
interface ClickedNode {
  /** The node's modality (`image` / `video` / `audio` / …). */
  type?: string;
  /** The node's live data map; `content` is its asset URL when filled. */
  data?: { content?: unknown };
}

/**
 * The image URL a slot pick should copy from the clicked node.
 *
 * Judges the CLICKED NODE's own type, never the reference rail: the rail only
 * holds nodes already wired to the target, while a slot pick roams the whole
 * canvas — testing against the rail would reject every candidate.
 *
 * `content` is read defensively even though the node view is typed: node data
 * is a CRDT map any client may write, and a non-string coerced into the slot
 * would put `[object Object]` in the panel and on the wire.
 * @param node - The node the user clicked during a slot pick.
 * @returns The URL to copy, or null when this node cannot fill a slot.
 */
export function pickedSlotImageUrl(node: ClickedNode): string | null {
  if (node.type !== 'image') return null;
  const content = node.data?.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}
