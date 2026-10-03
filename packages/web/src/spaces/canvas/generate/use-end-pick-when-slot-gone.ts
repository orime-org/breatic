// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { pickEndToastKey } from '@web/spaces/canvas/generate/pick-end-notice';
import { slotForPurpose } from '@web/spaces/canvas/generate/slots';
import { useCanvasStore } from '@web/stores';

/**
 * Ends a running slot pick on this node once its slot is no longer drawn.
 *
 * The slot list follows the mode and the model, and either can change under a
 * running pick, locally or by a collaborator. The slot then stops rendering
 * while the canvas keeps offering candidates for it, so the pick ends and the
 * reader is told, worded by who made the change.
 * @param nodeId - The node whose panel is open.
 * @param slots - The slots the panel draws now.
 * @param getLastWriteWasLocal - Reads whether this client made the newest write.
 */
export function useEndPickWhenSlotGone(
  nodeId: string,
  slots: readonly string[],
  getLastWriteWasLocal: () => boolean,
): void {
  const t = useTranslation();
  const endPick = useCanvasStore((s) => s.endPick);
  const slotsKey = slots.join(',');
  React.useEffect(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId !== nodeId) return;
    const running = slotForPurpose(session.purpose);
    if (running === undefined || slotsKey.split(',').includes(running)) return;
    endPick();
    toast.warning(t(pickEndToastKey(getLastWriteWasLocal())));
  }, [slotsKey, nodeId, endPick, t, getLastWriteWasLocal]);
}
