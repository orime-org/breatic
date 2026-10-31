// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * After an update reload, the Agent panel comes back to the conversation the
 * user was in, with what they had typed still in the box.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200 })),
    openChat: vi.fn(),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    listConversations: vi.fn(),
  },
}));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const KEY = 'breatic.reloadDrafts';

/**
 * Load the store as the page after an update would, with `saved` stored.
 * @param saved - What the page before saved for conversations.
 * @returns The store module and the mocked chat API.
 */
async function pageAfterUpdate(saved: unknown): Promise<{
  runtime: typeof import('@web/stores/conversation-runtime');
  chatApi: typeof ChatApiModule.chatApi;
}> {
  sessionStorage.setItem(KEY, JSON.stringify({ conversations: saved }));
  vi.resetModules();
  const runtime = await import('@web/stores/conversation-runtime');
  const { chatApi } = await import('@web/data/api/chat');
  return { runtime, chatApi };
}

/**
 * A conversation as the chat API answers with it.
 * @param id - Its id.
 * @returns The answer.
 */
function conversation(id: string): unknown {
  return { conversation: { id }, messages: [], hasMore: false };
}

beforeEach(() => {
  sessionStorage.clear();
  // The mocked chat API outlives `vi.resetModules`; its calls must not.
  vi.clearAllMocks();
});

describe('the Agent panel after an update reload', () => {
  it('still has the draft that was in each box', async () => {
    const { runtime } = await pageAfterUpdate({ drafts: { 'c-2': 'half a sentence' }, current: {} });
    expect(runtime.conversationRuntime.draftOf('c-2')).toBe('half a sentence');
  });

  it('goes back to the conversation that was open, not the most recently used one', async () => {
    const { runtime, chatApi } = await pageAfterUpdate({ drafts: {}, current: { 'p-1': 'c-2' } });
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1' }, { id: 'c-2' }],
      current: conversation('c-1'),
      hasMoreConversations: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    vi.mocked(chatApi.readConversation).mockResolvedValue(
      conversation('c-2') as Awaited<ReturnType<typeof chatApi.readConversation>>,
    );
    await runtime.conversationRuntime.ensureLoaded('p-1');
    await vi.waitFor(() => {
      expect(runtime.useConversationRuntime.getState().currentByProject['p-1']).toBe('c-2');
    });
    expect(chatApi.readConversation).toHaveBeenCalledWith('c-2');
  });

  it('reads nothing more when the open one is already it', async () => {
    const { runtime, chatApi } = await pageAfterUpdate({ drafts: {}, current: { 'p-1': 'c-1' } });
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1' }],
      current: conversation('c-1'),
      hasMoreConversations: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    await runtime.conversationRuntime.ensureLoaded('p-1');
    expect(chatApi.readConversation).not.toHaveBeenCalled();
    expect(runtime.useConversationRuntime.getState().currentByProject['p-1']).toBe('c-1');
  });

  it('offers what it holds to be saved before the next update', async () => {
    const { runtime } = await pageAfterUpdate({ drafts: {}, current: {} });
    const { reloadForUpdate } = await import('@web/stores/reload-for-update');
    runtime.conversationRuntime.setDraft('c-9', 'kept');
    runtime.conversationRuntime.setDraft('c-8', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reloadForUpdate();
    window.dispatchEvent(new Event('pagehide'));
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { conversations: { drafts: Record<string, string> } };
    expect(saved.conversations.drafts).toEqual({ 'c-9': 'kept' });
  });
});
