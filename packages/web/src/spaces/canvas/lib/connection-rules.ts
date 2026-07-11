// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Node-type connection rules (user-ratified 2026-07-10, batch spec §9.1).
 *
 * "A connection IS a reference" — so what may wire into a node's input is a
 * PRODUCT rule, not a graph nicety. Sources that can't feed a target's
 * generation are rejected at the wire level (drag preview, drop commit, and
 * pick-mode click all consult this), instead of being accepted and then
 * silently dropped at execute time — the contradictory dead-end the
 * adversarial pass surfaced. User-ratified whitelists:
 *
 *   image input ← image (i2i source) + text (prompt content)
 *   video input ← text + video + audio + image (all content modalities)
 *   text  input ← text + video + audio + image
 *   audio input ← text only
 *
 * 3d / web have no ratified input rule yet and keep the current
 * anything-connects behavior (extend INPUT_WHITELIST when theirs land).
 */

import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/** Per-target input whitelists; a target absent here accepts any source. */
const INPUT_WHITELIST: Partial<Record<NodeKind, ReadonlySet<string>>> = {
  image: new Set<string>(['image', 'text']),
  video: new Set<string>(['text', 'video', 'audio', 'image']),
  text: new Set<string>(['text', 'video', 'audio', 'image']),
  audio: new Set<string>(['text']),
};

/**
 * Decides whether a source node's output may wire into a target node's input.
 *
 * Kinds are read from Yjs-synced node data, so both arguments are treated as
 * untrusted strings: an unknown source kind fails CLOSED against a whitelisted
 * target (it is not on the list) and open against an unrestricted one.
 * @param sourceKind - The source (upstream) node's modality.
 * @param targetKind - The target (downstream) node's modality.
 * @returns Whether the connection is allowed.
 */
export function canConnect(
  sourceKind: NodeKind | string,
  targetKind: NodeKind | string,
): boolean {
  const whitelist = Object.hasOwn(INPUT_WHITELIST, targetKind)
    ? INPUT_WHITELIST[targetKind as NodeKind]
    : undefined;
  return whitelist === undefined || whitelist.has(sourceKind);
}
