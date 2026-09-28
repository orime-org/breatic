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

const { attachToChat } = await import('@web/stores/attach-to-chat');
const { chatAttachments } = await import('@web/stores/chat-attachments');
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

beforeEach(() => {
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
    expect(chatAttachments.noticeOf('c1')).toEqual({ key: 'full', limit: 2 });
  });

  it('adds nothing when no conversation could be opened', async () => {
    runtime.conversation = undefined;

    await attachToChat('p1', [node('a')]);

    expect(chatAttachments.trayOf('c1')).toEqual([]);
  });

  it('adds nothing when there is nothing attachable', async () => {
    await attachToChat('p1', []);

    expect(chatAttachments.trayOf('c1')).toEqual([]);
    expect(chatAttachments.noticeOf('c1')).toBeNull();
  });
});
