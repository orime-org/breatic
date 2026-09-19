// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the browser can settle about Understand before it builds anything.
 *
 * Two questions, both answerable from what the node already carries: is this a
 * format the endpoint reads, and is it small enough. A "no" here is a toast
 * and nothing else — no node, no edge, no request — because there is no run
 * yet for the refusal to land on (downstream-node-creation decision, stage 1).
 *
 * Everything else about whether a run succeeds belongs to that run, and shows
 * up in its row beside the node.
 */

import {
  AUDIO_FORMAT_NAMES,
  IMAGE_FORMAT_NAMES,
  IMAGE_TYPES,
  VIDEO_FORMAT_NAMES,
  audioFormatOf,
  videoFormatOf,
} from '@breatic/shared';

import { NODE_STEP } from '@web/spaces/canvas/drop-layout';

/** The three modalities a node offers Understand on. */
export type UnderstandableKind = 'image' | 'video' | 'audio';

/** What a node says about the file it is showing. */
export interface UnderstandableMedia {
  kind: UnderstandableKind;
  /** As the ledger judged it, or undefined for a node stored before it did. */
  mimeType: string | undefined;
  /** As the ledger counted it, or undefined for such a node. */
  sizeBytes: number | undefined;
}

/** Why the browser will not start this run. */
export type UnderstandRefusal =
  | {
      kind: 'format';
      /** The formats this modality does take, read off the tables themselves. */
      formats: string;
    }
  | { kind: 'size'; limitBytes: number; sizeBytes: number };

/** The formats each modality takes, as a phrase for the reader. */
const FORMATS_OF: Readonly<Record<UnderstandableKind, string>> = {
  image: IMAGE_FORMAT_NAMES,
  video: VIDEO_FORMAT_NAMES,
  audio: AUDIO_FORMAT_NAMES,
};

/**
 * Whether the endpoint reads this type at all.
 * @param media - What the node says it is showing.
 * @returns True when the tables name this type.
 */
function readsFormat(media: UnderstandableMedia): boolean {
  const mimeType = media.mimeType;
  if (mimeType === undefined) return true;
  switch (media.kind) {
    case 'image':
      return IMAGE_TYPES.has(mimeType);
    case 'video':
      return videoFormatOf(mimeType) !== undefined;
    case 'audio':
      return audioFormatOf(mimeType) !== undefined;
  }
}

/**
 * Why this node cannot be understood, when the browser can already tell.
 *
 * Silent about anything it was not told: a node stored before the ledger
 * reported its type or its size carries neither, and refusing those would
 * refuse every node that predates those fields. The run answers instead.
 * Missing knowledge switches off the one judgement that needed it, never
 * the other — which is why the ceiling is allowed to be absent here rather
 * than the caller skipping the whole call.
 * @param media - What the node says it is showing.
 * @param limitBytes - The largest file a run will take, or null before the
 *   knobs carrying it have arrived.
 * @returns The refusal, or null when nothing here rules the run out.
 */
export function understandRefusal(
  media: UnderstandableMedia,
  limitBytes: number | null,
): UnderstandRefusal | null {
  // Format first: a file that is both too large and in a format the endpoint
  // cannot read is not fixed by shrinking it.
  if (!readsFormat(media)) {
    return { kind: 'format', formats: FORMATS_OF[media.kind] };
  }
  const sizeBytes = media.sizeBytes;
  if (limitBytes !== null && sizeBytes !== undefined && sizeBytes > limitBytes) {
    return { kind: 'size', limitBytes, sizeBytes };
  }
  return null;
}

/**
 * Where the text node this run writes to goes.
 *
 * One neighbour-step to the right of the node it reads, level with it, with
 * no search for a free spot: a second run lands on the first, and the reader
 * sorts out the stack (user 2026-09-19). One press produces one node, and
 * nothing here knows which press this is.
 * @param source - The read node's stored position.
 * @param source.x - Its stored x.
 * @param source.y - Its stored y.
 * @param groupOrigin - The origin of the group holding it, or null when it is top-level.
 * @returns The absolute position for the new node.
 */
export function understandNodePosition(
  source: { x: number; y: number },
  groupOrigin: { x: number; y: number } | null,
): { x: number; y: number } {
  // A node inside a group stores its position relative to that group's
  // origin; the new node is top-level, so it needs the absolute one.
  const originX = groupOrigin?.x ?? 0;
  const originY = groupOrigin?.y ?? 0;
  return { x: source.x + originX + NODE_STEP.x, y: source.y + originY };
}
