// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { removeNodeSlotItem } from '@web/data/yjs/canvas-space';
import { STYLE_SLOT } from '@web/spaces/canvas/generate/style-slot';
import { useCanvasStore } from '@web/stores';

/** The style area's live state and handlers, as a Generate panel wires them. */
export interface StyleSlotWiring {
  /** Whether this node's style pick is running. */
  stylePicking: boolean;
  /** Enter / exit the style pick. */
  onStylePick: () => void;
  /** Take one style image out of the node. */
  onRemoveStyle: (url: string) => void;
}

/**
 * Wires a Generate panel's style area to the canvas pick and the node
 * (inner#826, inner#828).
 *
 * Each click on the canvas adds one style image; the cap rides the session so
 * the canvas knows when the slot is full. A full slot opens no pick: every
 * click would add nothing.
 * @param projectId - The project the node lives in.
 * @param spaceId - The space the node lives in.
 * @param nodeId - The node whose panel is open.
 * @param styleCap - How many style images the model takes, or undefined for none.
 * @param styleHeld - How many the node holds now.
 * @returns The pick state and the two handlers.
 */
export function useStyleSlot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  styleCap: number | undefined,
  styleHeld: number,
): StyleSlotWiring {
  const endPick = useCanvasStore((s) => s.endPick);
  const startStylePick = useCanvasStore((s) => s.startStylePick);
  const stylePicking = useCanvasStore(
    (s) => s.pickSession?.nodeId === nodeId && s.pickSession?.purpose === STYLE_SLOT.purpose,
  );
  const onStylePick = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === STYLE_SLOT.purpose) {
      endPick();
    } else if (styleCap !== undefined && styleHeld < styleCap) {
      startStylePick(nodeId, styleCap);
    }
  }, [startStylePick, endPick, nodeId, styleCap, styleHeld]);
  const onRemoveStyle = React.useCallback(
    (url: string) => {
      removeNodeSlotItem(projectId, spaceId, nodeId, STYLE_SLOT.field, url);
    },
    [projectId, spaceId, nodeId],
  );
  return { stylePicking, onStylePick, onRemoveStyle };
}
