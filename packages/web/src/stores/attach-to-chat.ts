// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { chatApi } from '@web/data/api/chat';
import { chatAttachments, type TrayItem } from '@web/stores/chat-attachments';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { useUIStore } from '@web/stores/ui';

/**
 * Hand items from the canvas to the agent.
 *
 * They go above the box of the conversation on screen -- opened first, the
 * way a first message opens one, when there is none -- and the agent column
 * is brought back into view so the reader sees them arrive. The batch goes in
 * whole or not at all, and what stopped it is said above the box.
 * @param projectId - The project the canvas is in.
 * @param items - The items, ready, in order.
 */
export async function attachToChat(projectId: string, items: readonly TrayItem[]): Promise<void> {
  if (items.length === 0) return;
  useUIStore.getState().setChatPanelCollapsed(false);
  const conversationId = await conversationRuntime.conversationForSending(projectId);
  if (conversationId === undefined) return;

  let limits;
  try {
    const config = await chatApi.streamConfig();
    limits = { maxItems: config.attachmentMaxItems, maxChars: config.attachmentMaxChars };
  } catch {
    chatAttachments.say(conversationId, { key: 'unavailable' });
    return;
  }

  const outcome = chatAttachments.add(conversationId, items, limits);
  if (outcome === 'full') chatAttachments.say(conversationId, { key: 'full', limit: limits.maxItems });
  else if (outcome === 'too_long') chatAttachments.say(conversationId, { key: 'tooLong' });
  else chatAttachments.say(conversationId, null);
}
