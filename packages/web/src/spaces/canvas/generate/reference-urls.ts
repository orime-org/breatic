// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which of a node's references actually travel with a submit.
 *
 * Both Generate panels answer this the same way and have to: connecting a
 * picture, clip or track offers it, `@`-mentioning it uses it, and what
 * reaches the provider is the second set, under the param the model reads
 * that kind from (#2156). Stated once here rather than in each view model — the video
 * panel's copy was character-for-character the image panel's, down to the
 * sanitiser and its reason (#1927).
 *
 * A panel's rail has TWO row sources, and both follow that one rule: rows
 * derived from incoming edges, and focus crops stored on the panel's own node.
 * `mentionedReferenceUrls` sorts them by kind, each list in rail order. That used to
 * be the image panel's alone and was written there; the video panel gained
 * crops in #1978 and the branch was copied over verbatim, which is the same
 * duplication this module was created to end — so it moved here too.
 */

import { referenceKinds, type ReferenceKind, type ReferencePool } from '@breatic/shared';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { focusRefId } from '@web/spaces/canvas/generate/derive-references';
import type { NodeView } from '@web/data/yjs/node-view';

/** The part of a rail row this needs: which node it points at. */
interface MentionableRow {
  /** The pool id — a source node id, or a `focus:`-namespaced crop id. */
  sourceNodeId: string;
}

/** One list of URLs per kind the pool carries, each in rail order. */
export type ReferenceUrls = Readonly<Record<ReferenceKind, readonly string[]>>;

/** A pool that takes no kind at all — every mode of a model without one. */
export const NO_REFERENCE_KINDS: readonly ReferenceKind[] = [];

/** A pool that holds nothing. */
export const NO_REFERENCE_URLS: ReferenceUrls = { image: [], video: [], audio: [] };

/**
 * Reads the asset behind a source node, and which kind of reference it is.
 *
 * Only a picture, a clip or a track has something to lend the pool; text is a
 * body rather than a URL (adversarial 2026-07-10). The check is unconditional
 * because the pool is derived from collaborative edges and a chip can outlive
 * the model it was picked under: whatever the picker did, a row's URL rides
 * only in the list of its own kind.
 * @param data - The source node view.
 * @returns The kind and URL, or undefined when the source lends nothing.
 */
function assetOf(data: NodeView | undefined): { kind: ReferenceKind; url: string } | undefined {
  if (data?.kind !== 'image' && data?.kind !== 'video' && data?.kind !== 'audio') return undefined;
  // The source node's content is collaborative Yjs data — untrusted, and NOT
  // covered by the catalog boundary. `typeof`, not Boolean: a malformed
  // source whose content is a non-string object is truthy and would slip a
  // non-URL into the task payload.
  const url: unknown = data.content;
  return typeof url === 'string' && url.length > 0 ? { kind: data.kind, url } : undefined;
}

/** The part of a focus crop this needs: its id and the asset it points at. */
interface MentionableCrop {
  /** The crop id; its pool id is this namespaced by {@link focusRefId}. */
  id: string;
  /** The crop asset's URL — an image by construction. */
  url: string;
}

/**
 * Every reference URL a submit sends, sorted by kind: the mentioned
 * edge-derived rows first, then the mentioned crops, which are pictures.
 *
 * Rail order, not mention order: the payload should read the way the panel
 * does, and the rail shows crops after node rows. Crops need no node lookup —
 * a crop IS its asset, and its pool id is namespaced (`focus:<id>`), so a node
 * whose id happens to equal a crop id cannot pull that crop along.
 * @param input - The two row sources plus what the prompt mentions.
 * @param input.references - Edge-derived rail rows, in rail order.
 * @param input.focusImages - The panel node's crops, in stored order.
 * @param input.atMentioned - The pool ids the prompt mentions right now.
 * @param input.nodes - Current canvas node views, for looking a row's source up.
 * @returns The URLs to send, one list per kind, each in rail order.
 */
export function mentionedReferenceUrls(input: {
  references: ReadonlyArray<MentionableRow>;
  focusImages: ReadonlyArray<MentionableCrop>;
  atMentioned: ReadonlySet<string>;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
}): ReferenceUrls {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const urls: Record<ReferenceKind, string[]> = { image: [], video: [], audio: [] };
  for (const row of input.references) {
    if (!input.atMentioned.has(row.sourceNodeId)) continue;
    const asset = assetOf(byId.get(row.sourceNodeId)?.data);
    if (asset) urls[asset.kind].push(asset.url);
  }
  for (const crop of input.focusImages) {
    if (input.atMentioned.has(focusRefId(crop.id))) urls.image.push(crop.url);
  }
  return urls;
}

/**
 * The pool's share of a task's params: each kind's URLs under the param the
 * model reads that kind from.
 *
 * A kind the model takes nothing of is left behind, and so is an empty list —
 * an absent field is what "none picked" looks like upstream.
 * @param pool - The model's pool in this mode.
 * @param urls - What the prompt mentions, by kind.
 * @returns Params to merge into the task.
 */
export function poolParams(pool: ReferencePool, urls: ReferenceUrls): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const kind of referenceKinds(pool)) {
    if (urls[kind].length > 0) params[pool[kind]!.param] = [...urls[kind]];
  }
  return params;
}

/**
 * Which kind a pool carries under a param, if any.
 * @param pool - The model's pool in this mode.
 * @param param - A param a refusal names.
 * @returns The kind that travels under it, or undefined when it is no pool param.
 */
export function poolKindOf(pool: ReferencePool, param: string | undefined): ReferenceKind | undefined {
  return referenceKinds(pool).find((kind) => pool[kind]!.param === param);
}

/**
 * What the execute gate weighs for the pool: how many of each kind are
 * mentioned against the most the model takes of it.
 * @param pool - The model's pool in this mode.
 * @param urls - What the prompt mentions, by kind.
 * @returns One entry per kind the model takes.
 */
export function poolCounts(
  pool: ReferencePool,
  urls: ReferenceUrls,
): Array<{ kind: ReferenceKind; count: number; cap: number | undefined }> {
  return referenceKinds(pool).map((kind) => ({
    kind,
    count: urls[kind].length,
    cap: pool[kind]!.cap,
  }));
}
