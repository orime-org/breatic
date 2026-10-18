// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { chatApi } from '@web/data/api/chat';
import {
  chatAttachments,
  type AttachmentLimits,
  type TrayItem,
} from '@web/stores/chat-attachments';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { useUIStore } from '@web/stores/ui';

/** Where an attempt to attach lands, and what it is held to. */
export interface Tray {
  conversationId: string;
  limits: AttachmentLimits;
}

/**
 * Open the list above the box for one attempt to attach.
 *
 * The conversation on screen is used, opened first the way a first message
 * opens one when there is none.
 * @param projectId - The project the chat is in.
 * @returns Where to attach, or undefined when no conversation could be opened
 *   or the limits could not be read -- the latter told in a toast.
 */
export async function openTray(projectId: string): Promise<Tray | undefined> {
  const conversationId = await conversationRuntime.conversationForSending(projectId);
  if (conversationId === undefined) return undefined;
  try {
    const config = await chatApi.streamConfig();
    return {
      conversationId,
      limits: { maxItems: config.attachmentMaxItems, maxChars: config.attachmentMaxChars },
    };
  } catch {
    chatAttachments.say({ key: 'unavailable' });
    return undefined;
  }
}

/**
 * Hand items to the agent: from the canvas, a document or a paste.
 *
 * The agent column is brought back into view so the reader sees them arrive.
 * The batch goes in whole or not at all, and what stopped it is told in a
 * toast.
 * @param projectId - The project the items come from.
 * @param items - The items, ready, in order.
 */
export async function attachToChat(projectId: string, items: readonly TrayItem[]): Promise<void> {
  if (items.length === 0) return;
  useUIStore.getState().setChatPanelCollapsed(false);
  const tray = await openTray(projectId);
  if (tray) chatAttachments.add(tray.conversationId, items, tray.limits);
}
