// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which of a node's references actually travel with a submit.
 *
 * Both Generate panels answer this the same way and have to: connecting an
 * image offers it, `@`-mentioning it uses it, and what reaches the provider is
 * the second set. Stated once here rather than in each view model — the video
 * panel's copy was character-for-character the image panel's, down to the
 * sanitiser and its reason (#1927).
 *
 * The image panel appends its focus crops to the result; those live only on
 * that side, so they stay there.
 */

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';

/** The part of a rail row this needs: which node it points at. */
interface MentionableRow {
  /** The pool id — a source node id, or a `focus:`-namespaced crop id. */
  sourceNodeId: string;
}

/**
 * Reads an IMAGE node's asset URL — the only kind that can be a source image.
 * Every non-image kind yields undefined: a source image is definitionally an
 * image, and text content is a body rather than a URL (adversarial
 * 2026-07-10).
 *
 * This is the LAST line, not the only one. The `@` picker stopped offering
 * REFERENCE MATERIAL rows the active mode cannot consume — first for legacy
 * edges (2026-07-11), then per mode and modality (#1945). Text rows are not
 * reference material, so the picker still offers them under every mode and
 * they arrive here on every submit that mentions one; this is the ordinary
 * case, not a rare one. The check stays unconditional anyway, because the
 * pool is derived from collaborative edges and a chip can outlive the mode it
 * was picked under: whatever the picker did, nothing but an image URL may
 * ride into `params.images`.
 * @param data - The source node view.
 * @returns The image URL, or undefined when the source is not an image node.
 */
function imageUrlOf(data: NodeView | undefined): string | undefined {
  return data?.kind === 'image' ? data.content : undefined;
}

/**
 * The image URLs behind the rail rows the prompt currently `@`-mentions.
 *
 * Rail order, not mention order: the payload should read the way the panel
 * does. A mentioned row whose source is not an image contributes nothing —
 * the rail carries text, audio and video rows too, and none of them has an
 * image to lend.
 * @param references - The rail's rows, in the order the rail shows them.
 * @param atMentioned - The pool ids the prompt mentions right now.
 * @param nodes - Current canvas node views, for looking a row's source up.
 * @returns The URLs to send, in rail order.
 */
export function mentionedImageUrls(
  references: ReadonlyArray<MentionableRow>,
  atMentioned: ReadonlySet<string>,
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    references
      .filter((r) => atMentioned.has(r.sourceNodeId))
      .map((r) => imageUrlOf(byId.get(r.sourceNodeId)?.data))
      // The source node's content is collaborative Yjs data — untrusted, and
      // NOT covered by the catalog boundary. `typeof`, not Boolean: a
      // malformed source whose content is a non-string object is truthy and
      // would slip a non-URL into the task payload.
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
  );
}
