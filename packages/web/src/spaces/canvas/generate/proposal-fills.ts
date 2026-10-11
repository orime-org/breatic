// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Filling a placed generation's slots from the proposal's material nodes
 * (inner#1315).
 *
 * A fill names a slot by the param it travels as, and two slots can share a
 * param (a video's first frame and a talking head's portrait both send
 * `image`); the generation's mode row is what says which one it is, the way
 * the panel only ever draws one of them. What lands in the slot is what a
 * pick in the panel copies off the clicked node, through the same writes.
 */

import type { ProposalNode } from '@breatic/shared';

import { appendNodeSlotItem } from '@web/data/yjs/canvas-space';
import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { audioModeOption } from '@web/spaces/canvas/generate/audio-mode-options';
import { fillSlot } from '@web/spaces/canvas/generate/slot-write';
import type { SlotSpec } from '@web/spaces/canvas/generate/slots';
import { STYLE_SLOT } from '@web/spaces/canvas/generate/style-slot';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { slotsForMode } from '@web/spaces/canvas/generate/video-mode-options';

/**
 * The slot a generation of this kind and mode fills under this param.
 * @param type - The generation node's modality.
 * @param mode - The mode it is set to.
 * @param param - The param the fill names.
 * @returns The slot, or undefined when this generation draws none under it.
 * @throws {never} Never.
 */
export function slotForParam(type: string, mode: string, param: string): SlotSpec | undefined {
  const row: SlotSpec[] =
    type === 'video'
      ? [...slotsForMode(mode).map((slot) => VIDEO_SLOTS[slot]), STYLE_SLOT]
      : type === 'audio'
        ? audioModeOption(mode).slots.map((slot) => AUDIO_SLOTS[slot])
        : type === 'image'
          ? [STYLE_SLOT]
          : [];
  return row.find((spec) => spec.param === param);
}

/**
 * Write a placed generation's fills into its slots.
 *
 * Runs inside the placement's undo batch, after every node holds its
 * material. A fill the check let through always finds its slot and its
 * material; one that does not is skipped, so a single stale index cannot roll
 * the rest of the flow back.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space being placed into.
 * @param nodeId - The placed generation node.
 * @param node - Its proposal entry.
 * @param sources - Every proposal node, in the proposal's order.
 * @throws {never} Never.
 */
export function writeProposalFills(
  projectId: string,
  spaceId: string,
  nodeId: string,
  node: ProposalNode,
  sources: readonly ProposalNode[],
): void {
  if (!node.fills || !node.mode) return;
  for (const [param, indices] of Object.entries(node.fills)) {
    const spec = slotForParam(node.type, node.mode, param);
    if (!spec) continue;
    const picked = indices.flatMap((at) => {
      const source = sources[at];
      return source?.material ? [{ source, material: source.material }] : [];
    });
    if (spec.multiple) {
      // The node was created a moment ago, so its list starts empty; the check
      // already held the count to the model's cap.
      for (const { material } of picked) {
        appendNodeSlotItem(projectId, spaceId, nodeId, spec.field, material, picked.length);
      }
      continue;
    }
    const [first] = picked;
    if (!first) continue;
    const { source, material } = first;
    fillSlot(projectId, spaceId, nodeId, spec, {
      type: source.type,
      data: {
        content: material,
        coverUrl: source.materialMedia?.coverUrl,
        duration: source.materialMedia?.duration,
      },
    });
  }
}
