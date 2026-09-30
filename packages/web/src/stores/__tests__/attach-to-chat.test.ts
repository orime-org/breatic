// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Nodes added to the agent from the canvas.
 *
 * They land in the list above the box of the conversation on screen, which is
 * opened first when there is none, with the agent column brought back into
 * view so the reader sees them arrive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ conversation: 'c1' as string | undefined }));

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    streamConfig: vi.fn(async () => ({
      heartbeatIntervalMs: 5000,
      attachmentMaxChars: 200_000,
      attachmentMaxItems: 2,
    })),
  },
}));

vi.mock('@web/stores/conversation-runtime', () => ({
  conversationRuntime: {
    conversationForSending: vi.fn(async () => runtime.conversation),
  },
}));

const { attachToChat, openTray } = await import('@web/stores/attach-to-chat');
const { chatAttachments, useChatAttachments } = await import('@web/stores/chat-attachments');
const { conversationRuntime } = await import('@web/stores/conversation-runtime');
const { chatApi } = await import('@web/data/api/chat');
const { useUIStore } = await import('@web/stores/ui');
import type { TrayItem } from '@web/stores/chat-attachments';

/**
 * A canvas node, ready.
 * @param id - Its id.
 * @returns The item.
 */
function node(id: string): TrayItem {
  return {
    id,
    name: id,
    type: 'text',
    status: 'ready',
    chip: { id, type: 'text', name: id, data_snapshot: {} },
  };
}

/**
 * What is said above the box.
 * @returns The notice, or null.
 */
function notice(): unknown {
  return useChatAttachments.getState().noticeByConversation.c1 ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  chatAttachments.forget(['c1']);
  runtime.conversation = 'c1';
  useUIStore.getState().setChatPanelCollapsed(true);
});

describe('adding canvas nodes to the agent', () => {
  it('puts them above the box of the conversation on screen', async () => {
    await attachToChat('p1', [node('a'), node('b')]);

    expect(chatAttachments.trayOf('c1').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('brings the agent column back into view', async () => {
    await attachToChat('p1', [node('a')]);

    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
  });

  it('says so when they would pass the item limit, and adds none', async () => {
    await attachToChat('p1', [node('a'), node('b'), node('c')]);

    expect(chatAttachments.trayOf('c1')).toEqual([]);
    expect(notice()).toEqual({ key: 'full', limit: 2 });
  });

  it('adds nothing when no conversation could be opened', async () => {
    runtime.conversation = undefined;

    await attachToChat('p1', [node('a')]);

    expect(chatAttachments.trayOf('c1')).toEqual([]);
  });

  it('does nothing at all when there is nothing attachable', async () => {
    await attachToChat('p1', []);

    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
    expect(conversationRuntime.conversationForSending).not.toHaveBeenCalled();
  });
});

describe('opening the list above the box for an attempt', () => {
  it('opens the conversation and answers the limits', async () => {
    expect(await openTray('p1')).toEqual({
      conversationId: 'c1',
      limits: { maxItems: 2, maxChars: 200_000 },
    });
  });

  it('clears what was said about the last attempt', async () => {
    chatAttachments.say('c1', { key: 'tooLong' });

    await openTray('p1');

    expect(notice()).toBeNull();
  });

  it('says so when the limits cannot be read', async () => {
    vi.mocked(chatApi.streamConfig).mockRejectedValueOnce(new Error('offline'));

    expect(await openTray('p1')).toBeUndefined();
    expect(notice()).toEqual({ key: 'unavailable' });
  });

  it('answers nothing when no conversation could be opened', async () => {
    runtime.conversation = undefined;

    expect(await openTray('p1')).toBeUndefined();
  });
});
