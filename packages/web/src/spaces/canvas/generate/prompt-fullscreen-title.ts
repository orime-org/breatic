// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Modality } from '@web/data/yjs/node-view';
import { MODALITY_LABEL } from '@web/spaces/canvas/nodes/_shared/modality';

/**
 * A prompt box's full-screen title (inner#2115): the node's name as its
 * header shows it, and the box's name when the panel has several.
 * @param nodeName - The node's name; the modality's label when blank.
 * @param modality - The node's modality.
 * @param boxName - The box's name in the panel, when it has one.
 * @returns The title.
 */
export function promptFullscreenTitle(nodeName: string | undefined, modality: Modality, boxName?: string): string {
  const node = nodeName && nodeName.length > 0 ? nodeName : MODALITY_LABEL[modality];
  return boxName ? `${node} · ${boxName}` : node;
}
