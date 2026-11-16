// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Filling and clearing a slot, and filling a placed proposal's slots from its
 * material nodes (inner#1315) — the bodies collab and web both write them
 * with (breatic#1488 §8.1).
 *
 * A slot owns exactly one node field, and the whole pick lives inside it: a
 * slot taking something an `<img>` cannot paint stores `{url, cover}` rather
 * than putting the poster in a field of its own (#1918). Two fields would be
 * two independent last-writer-wins registers, and two clients picking at once
 * would converge per-field — one client's video wearing the other's poster.
 *
 * A fill names a slot by the param it travels as, and two slots can share a
 * param (a video's first frame and a talking head's portrait both send
 * `image`); the generation's mode row is what says which one it is, the way
 * the panel only ever draws one of them.
 */

import type * as Y from 'yjs';

import type { ProposalNode } from '@shared/types/canvas-proposal.js';
import { AUDIO_SLOTS } from '@shared/canvas/model/audio-slots.js';
import { audioModeOption } from '@shared/canvas/model/audio-mode-options.js';
import { pickedSlotCover, pickedSlotDuration, pickedSlotUrl, type ClickedNode } from '@shared/canvas/model/slot-pick.js';
import type { SlotSpec } from '@shared/canvas/model/slots.js';
import { STYLE_SLOT } from '@shared/canvas/model/style-slot.js';
import { VIDEO_SLOTS } from '@shared/canvas/model/video-slots.js';
import { slotsForMode } from '@shared/canvas/model/video-mode-options.js';
import { appendNodeSlotItemInDoc, setNodeSlotValueInDoc } from '@shared/canvas/model/canvas-write.js';

/**
 * What a slot stores when this node is clicked into it.
 *
 * Null when the node cannot fill the slot — the candidate dimming already
 * says so, and this backstops an insisting click. A node with no poster
 * stores no poster key rather than leaving the previous pick's frame under
 * the new asset.
 * @param spec - The slot being filled.
 * @param clicked - The node the user clicked.
 * @returns The value for the slot's field, or null to refuse.
 */
export function slotFillValue(spec: SlotSpec, clicked: ClickedNode): string | Record<string, string | number> | null {
  const url = pickedSlotUrl(clicked, spec.accepts);
  if (url === null) return null;
  const cover = spec.storesCover ? pickedSlotCover(clicked) : null;
  const duration = spec.storesCover ? pickedSlotDuration(clicked) : null;
  return spec.storesCover
    ? { url, ...(cover ? { cover } : {}), ...(duration !== null ? { duration } : {}) }
    : url;
}

/**
 * Copies a clicked node into a slot.
 * @param doc - The canvas document.
 * @param nodeId - The generative node whose slot is being filled.
 * @param spec - The slot being filled.
 * @param clicked - The node the user clicked.
 * @returns True when the slot was filled, false when the click was refused.
 */
export function fillSlotInDoc(doc: Y.Doc, nodeId: string, spec: SlotSpec, clicked: ClickedNode): boolean {
  const value = slotFillValue(spec, clicked);
  if (value === null) return false;
  setNodeSlotValueInDoc(doc, nodeId, spec.field, value);
  return true;
}

/**
 * Empties a slot. One key holds the whole pick, so clearing it takes the
 * poster with it.
 * @param doc - The canvas document.
 * @param nodeId - The generative node whose slot is being cleared.
 * @param spec - The slot to empty.
 */
export function clearSlotInDoc(doc: Y.Doc, nodeId: string, spec: SlotSpec): void {
  setNodeSlotValueInDoc(doc, nodeId, spec.field, null);
}

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
 * Runs inside the placement's batch, after every node holds its material. A
 * fill the check let through always finds its slot and its material; one
 * that does not is skipped, so a single stale index cannot roll the rest of
 * the flow back.
 * @param doc - The canvas document.
 * @param nodeId - The placed generation node.
 * @param node - Its proposal entry.
 * @param sources - Every proposal node, in the proposal's order.
 * @throws {never} Never.
 */
export function writeProposalFillsInDoc(
  doc: Y.Doc,
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
        appendNodeSlotItemInDoc(doc, nodeId, spec.field, material, picked.length);
      }
      continue;
    }
    const [first] = picked;
    if (!first) continue;
    const { source, material } = first;
    fillSlotInDoc(doc, nodeId, spec, {
      type: source.type,
      data: {
        content: material,
        coverUrl: source.materialMedia?.coverUrl,
        duration: source.materialMedia?.duration,
      },
    });
  }
}
