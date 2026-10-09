// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { docName, getDoc } from '@web/data/yjs/manager';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { pastedCanvas } from '@web/pages/project/chat/paste-canvas';
import type { ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { handToAgent } from '@web/spaces/canvas/pick-for-agent';
import { attachToChat } from '@web/stores/attach-to-chat';

/**
 * Attaches canvas nodes pasted into the chat box. They become the card "Add
 * to Agent" makes on the same nodes (inner#1349); a picture copied from a
 * reply becomes an image attachment.
 * @param projectId - The project.
 * @param canvasSpaceId - The canvas on screen, when the open Space is one.
 * @returns The paste handler.
 */
export function usePasteCanvas(
  projectId: string,
  canvasSpaceId: string | undefined,
): (payload: ClipboardPayload) => void {
  const queryClient = useQueryClient();
  const t = useTranslation();
  return React.useCallback(
    (payload: ClipboardPayload): void => {
      const canvasDoc = canvasSpaceId === undefined ? undefined : getDoc(docName.canvasSpace(projectId, canvasSpaceId));
      const pasted = pastedCanvas(payload, canvasDoc);
      if (pasted === null) return;
      if (pasted.kind === 'item') {
        void attachToChat(projectId, [pasted.item]);
        return;
      }
      void handToAgent(queryClient, projectId, pasted.doc, pasted.ids).then((read) => {
        if (read) return;
        // Said as the canvas says it when "Add to Agent" cannot read it.
        toast.error(t('canvas.generatePanel.catalogUnavailable'), { id: 'generate-catalog-unavailable' });
      });
    },
    [projectId, canvasSpaceId, queryClient, t],
  );
}
