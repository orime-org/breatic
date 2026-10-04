// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { readCanvasGraph } from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { pastedCanvas } from '@web/pages/project/chat/paste-canvas';
import type { ClipboardNode } from '@web/spaces/canvas/node-clipboard';
import { handToAgent } from '@web/spaces/canvas/pick-for-agent';
import { attachToChat } from '@web/stores/attach-to-chat';

/**
 * Attaches canvas nodes pasted into the chat box. Nodes the open canvas has
 * go over the way "Add to Agent" sends them; anything else is attached as
 * the clipboard carried it.
 * @param projectId - The project.
 * @param canvasSpaceId - The canvas on screen, when the open Space is one.
 * @returns The paste handler.
 */
export function usePasteCanvas(
  projectId: string,
  canvasSpaceId: string | undefined,
): (nodes: ClipboardNode[]) => void {
  const queryClient = useQueryClient();
  const t = useTranslation();
  return React.useCallback(
    (nodes: ClipboardNode[]): void => {
      const there = new Set(
        canvasSpaceId === undefined ? [] : readCanvasGraph(projectId, canvasSpaceId).nodes.map((n) => n.id),
      );
      const pasted = pastedCanvas(nodes, (id) => there.has(id));
      if (pasted === null) return;
      if (pasted.kind === 'item') {
        void attachToChat(projectId, [pasted.item]);
        return;
      }
      // Nodes found on a canvas mean a canvas is open.
      if (canvasSpaceId === undefined) return;
      void handToAgent(queryClient, projectId, canvasSpaceId, pasted.ids).then((read) => {
        if (read) return;
        // Said as the canvas says it when "Add to Agent" cannot read it.
        toast.error(t('canvas.generatePanel.catalogUnavailable'), { id: 'generate-catalog-unavailable' });
      });
    },
    [projectId, canvasSpaceId, queryClient, t],
  );
}
