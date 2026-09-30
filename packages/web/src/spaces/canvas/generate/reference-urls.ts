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
import { usableDuration } from '@web/spaces/canvas/generate/slot-pick';

/** The part of a rail row this needs: which node it points at. */
interface MentionableRow {
  /** The pool id — a source node id, or a `focus:`-namespaced crop id. */
  sourceNodeId: string;
}

/** One list of URLs per kind the pool carries, each in rail order. */
export type ReferenceUrls = Readonly<Record<ReferenceKind, readonly string[]>>;

/** A pool that takes no kind at all — every mode of a model without one. */
export const NO_REFERENCE_KINDS: readonly ReferenceKind[] = [];

/** Each media chip's words in the prompt, by pool id. */
export type MentionTokens = Readonly<Record<string, string>>;

/** No chip has words: the model names no way to point at a file. */
export const NO_MENTION_TOKENS: MentionTokens = {};

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
function assetOf(
  data: NodeView | undefined,
): { kind: ReferenceKind; url: string; duration?: number } | undefined {
  if (data?.kind !== 'image' && data?.kind !== 'video' && data?.kind !== 'audio') return undefined;
  // The source node's content is collaborative Yjs data — untrusted, and NOT
  // covered by the catalog boundary. `typeof`, not Boolean: a malformed
  // source whose content is a non-string object is truthy and would slip a
  // non-URL into the task payload.
  const url: unknown = data.content;
  if (typeof url !== 'string' || url.length === 0) return undefined;
  const duration = data.kind === 'image' ? undefined : usableDuration(data.duration);
  return duration === undefined ? { kind: data.kind, url } : { kind: data.kind, url, duration };
}

/** The part of a focus crop this needs: its id and the asset it points at. */
interface MentionableCrop {
  /** The crop id; its pool id is this namespaced by {@link focusRefId}. */
  id: string;
  /** The crop asset's URL — an image by construction. */
  url: string;
}

/** What a submit reads to decide which references travel. */
interface MentionInput {
  /** Edge-derived rail rows, in rail order. */
  references: ReadonlyArray<MentionableRow>;
  /** The panel node's crops, in stored order. */
  focusImages: ReadonlyArray<MentionableCrop>;
  /** The pool ids the prompt mentions right now. */
  atMentioned: ReadonlySet<string>;
  /** Current canvas node views, for looking a row's source up. */
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
}

/** One mentioned reference, as it is sent. */
interface SentReference {
  /** Its pool id — what the prompt's chip carries. */
  id: string;
  kind: ReferenceKind;
  url: string;
  /** How long it runs, when its node knows. */
  duration?: number;
}

/**
 * The mentioned references in the order they are sent: the edge-derived rows
 * first, then the crops, which are pictures.
 *
 * Rail order, not mention order: the payload should read the way the panel
 * does, and the rail shows crops after node rows. Crops need no node lookup —
 * a crop IS its asset, and its pool id is namespaced (`focus:<id>`), so a node
 * whose id happens to equal a crop id cannot pull that crop along.
 * @param input - The two row sources plus what the prompt mentions.
 * @returns Each mentioned reference that lends an asset, in send order.
 */
function sentReferences(input: MentionInput): SentReference[] {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const sent: SentReference[] = [];
  for (const row of input.references) {
    if (!input.atMentioned.has(row.sourceNodeId)) continue;
    const asset = assetOf(byId.get(row.sourceNodeId)?.data);
    if (asset) sent.push({ id: row.sourceNodeId, ...asset });
  }
  for (const crop of input.focusImages) {
    const id = focusRefId(crop.id);
    if (input.atMentioned.has(id)) sent.push({ id, kind: 'image', url: crop.url });
  }
  return sent;
}

/**
 * Every reference URL a submit sends, sorted by kind, each list in send order.
 * @param input - The two row sources plus what the prompt mentions.
 * @returns The URLs to send, one list per kind.
 */
export function mentionedReferenceUrls(input: MentionInput): ReferenceUrls {
  const urls: Record<ReferenceKind, string[]> = { image: [], video: [], audio: [] };
  for (const ref of sentReferences(input)) urls[ref.kind].push(ref.url);
  return urls;
}

/**
 * How each mentioned chip is written into the prompt the model reads (#2156,
 * design §13.2): its kind's `mention`, with `{n}` its place in that kind's sent
 * list counted from 1 and `{i}` counted from 0, so the words point at the same
 * file the list carries there.
 * @param pool - The model's pool in this mode.
 * @param input - The two row sources plus what the prompt mentions.
 * @returns Pool id to its words; a chip whose kind the model takes nothing of,
 *   or names no spelling for, is absent and adds nothing to the text.
 */
export function mentionTokens(pool: ReferencePool, input: MentionInput): MentionTokens {
  const tokens: Record<string, string> = {};
  const counts: Record<ReferenceKind, number> = { image: 0, video: 0, audio: 0 };
  for (const ref of sentReferences(input)) {
    const index = counts[ref.kind]++;
    const mention = pool[ref.kind]?.mention;
    if (mention === undefined) continue;
    tokens[ref.id] = mention.replace('{n}', String(index + 1)).replace('{i}', String(index));
  }
  return tokens;
}

/**
 * How long each kind's sent clips or tracks run, in the order they are sent
 * (#2156, design §14) — what a price by the second reads. A kind is left out
 * while any of its files has no known length: a partial list would price the
 * unknown one as free.
 * @param pool - The model's pool in this mode.
 * @param input - The two row sources plus what the prompt mentions.
 * @returns Seconds per file under each pool param whose lengths are all known.
 */
export function mentionDurations(
  pool: ReferencePool,
  input: MentionInput,
): Record<string, number[]> {
  const byKind: Record<ReferenceKind, Array<number | undefined>> = { image: [], video: [], audio: [] };
  for (const ref of sentReferences(input)) byKind[ref.kind].push(ref.duration);
  const durations: Record<string, number[]> = {};
  for (const kind of referenceKinds(pool)) {
    const known = byKind[kind].filter((d): d is number => d !== undefined);
    if (known.length > 0 && known.length === byKind[kind].length) durations[pool[kind]!.param] = known;
  }
  return durations;
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
