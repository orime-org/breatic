// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The model picker in the composer (#1363).
 *
 * It shows the model of the conversation on screen and lists the models the
 * reader can pick, the current one checked. A pick is shown at once and
 * saved; a save that fails puts the old pick back, unless a later pick has
 * replaced it, says so and asks for the list again. While the list is loading,
 * or failed to load, the picker shows the conversation's model and cannot be
 * opened; asked for again, it keeps the list it has. A conversation whose model the deployment no longer lists
 * shows the model a new conversation would start on, which is what the next
 * message is sent with.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/chat')>()),
  chatApi: { models: vi.fn(), setModel: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { chatApi } from '@web/data/api/chat';
import { toast } from '@web/lib/toast';
import { useConversationRuntime } from '@web/stores/conversation-runtime';
import { ModelPicker } from '@web/pages/project/chat/ModelPicker';

const DEEPSEEK = { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' };
const SONNET = { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' };
const OPUS = { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' };

/**
 * Put conversations in the runtime store, each answered by a model.
 * @param models - The model of each conversation, by id.
 */
function conversations(models: Record<string, { id: string; name: string }>): void {
  useConversationRuntime.setState((s) => ({
    conversations: Object.fromEntries(
      Object.entries(models).map(([id, agentModel]) => [
        id,
        { projectId: 'p-1', messages: [], hasMore: false, oldestLoadedTurn: null, title: null, agentModel },
      ]),
    ),
    refusals: s.refusals,
  }));
}

/**
 * Render the picker for one conversation.
 * @param conversationId - Which conversation.
 * @returns The rendered picker and a way to show another conversation.
 */
function renderPicker(conversationId: string): { rerenderFor: (id: string) => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (id: string): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <ModelPicker conversationId={id} projectId='p-1' />
    </QueryClientProvider>
  );
  const { rerender } = render(view(conversationId));
  return { rerenderFor: (id) => rerender(view(id)) };
}

/**
 * The picker's button.
 * @returns It.
 */
function trigger(): HTMLElement {
  return screen.getByTestId('chat-model-picker');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatApi.models).mockResolvedValue({ models: [DEEPSEEK, SONNET, OPUS], lastUsed: DEEPSEEK.id });
  vi.mocked(chatApi.setModel).mockResolvedValue(undefined);
});

afterEach(() => {
  useConversationRuntime.setState({ conversations: {} });
});

describe('the model picker', () => {
  it('shows the model of the conversation on screen, and follows a switch to another one', async () => {
    conversations({ 'c-1': SONNET, 'c-2': OPUS });

    const { rerenderFor } = renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());
    expect(trigger()).toHaveTextContent('Claude Sonnet 5.5');

    rerenderFor('c-2');
    expect(trigger()).toHaveTextContent('Claude Opus 5.5');
  });

  it('lists every model the reader can pick, the current one filled the way the language menu fills it', async () => {
    conversations({ 'c-1': SONNET });
    const user = userEvent.setup();
    renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());

    await user.click(trigger());
    const menu = await screen.findByTestId('chat-model-menu');
    const items = Array.from(menu.querySelectorAll('button'));

    expect(items.map((item) => item.textContent)).toEqual(['DeepSeek V4.1 Flash', 'Claude Sonnet 5.5', 'Claude Opus 5.5']);
    expect(items.map((item) => item.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(items.map((item) => item.className.includes('bg-accent-strong'))).toEqual([false, true, false]);
  });

  it('opens with focus on the menu, not on its first row', async () => {
    conversations({ 'c-1': SONNET });
    const user = userEvent.setup();
    renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());

    await user.click(trigger());
    const menu = await screen.findByTestId('chat-model-menu');

    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it('shows a pick at once and saves it for the conversation', async () => {
    conversations({ 'c-1': DEEPSEEK });
    const user = userEvent.setup();
    renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());

    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Claude Opus 5.5' }));

    expect(trigger()).toHaveTextContent('Claude Opus 5.5');
    expect(chatApi.setModel).toHaveBeenCalledWith('c-1', 'p-1', OPUS.id);
    expect(useConversationRuntime.getState().conversations['c-1']?.agentModel).toEqual(OPUS);
  });

  it('puts the old pick back and says so when the save fails', async () => {
    conversations({ 'c-1': DEEPSEEK });
    vi.mocked(chatApi.setModel).mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());

    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Claude Opus 5.5' }));

    await waitFor(() => expect(trigger()).toHaveTextContent('DeepSeek V4.1 Flash'));
    expect(useConversationRuntime.getState().conversations['c-1']?.agentModel).toEqual(DEEPSEEK);
    expect(toast.error).toHaveBeenCalledWith('Could not save the model choice');
  });

  it('keeps a later pick when an earlier save fails after it', async () => {
    conversations({ 'c-1': DEEPSEEK });
    let failFirst: (why: Error) => void = () => undefined;
    vi.mocked(chatApi.setModel)
      .mockReturnValueOnce(new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());

    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Claude Opus 5.5' }));
    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Claude Sonnet 5.5' }));
    failFirst(new Error('network'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the model choice'));
    expect(trigger()).toHaveTextContent('Claude Sonnet 5.5');
    expect(useConversationRuntime.getState().conversations['c-1']?.agentModel).toEqual(SONNET);
  });

  it('asks for the list again when a save fails', async () => {
    conversations({ 'c-1': DEEPSEEK });
    vi.mocked(chatApi.setModel).mockRejectedValue(new Error('gone'));
    const user = userEvent.setup();
    renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());
    expect(chatApi.models).toHaveBeenCalledTimes(1);

    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Claude Opus 5.5' }));

    await waitFor(() => expect(chatApi.models).toHaveBeenCalledTimes(2));
  });

  it('shows the conversation model and cannot be opened while the list is loading', () => {
    conversations({ 'c-1': SONNET });
    vi.mocked(chatApi.models).mockReturnValue(new Promise(() => undefined));

    renderPicker('c-1');

    expect(trigger()).toHaveTextContent('Claude Sonnet 5.5');
    expect(trigger()).toBeDisabled();
  });

  it('shows the conversation model, cannot be opened and says so once when the list failed', async () => {
    conversations({ 'c-1': SONNET });
    vi.mocked(chatApi.models).mockRejectedValue(new Error('network'));

    renderPicker('c-1');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load the model list'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(trigger()).toHaveTextContent('Claude Sonnet 5.5');
    expect(trigger()).toBeDisabled();
  });

  it('shows the model a new conversation starts on when the stored one is no longer listed, and sends with it', async () => {
    conversations({ 'c-1': { id: 'retired/model', name: 'Retired' } });
    vi.mocked(chatApi.models).mockResolvedValue({ models: [DEEPSEEK, SONNET], lastUsed: SONNET.id });

    renderPicker('c-1');

    await waitFor(() => expect(trigger()).toHaveTextContent('Claude Sonnet 5.5'));
    expect(useConversationRuntime.getState().conversations['c-1']?.agentModel).toEqual(SONNET);
    expect(chatApi.setModel).not.toHaveBeenCalled();
  });

  it('asks for the list again after the server refused a send', async () => {
    conversations({ 'c-1': SONNET });
    renderPicker('c-1');
    await waitFor(() => expect(chatApi.models).toHaveBeenCalledTimes(1));

    useConversationRuntime.setState((s) => ({ refusals: s.refusals + 1 }));

    await waitFor(() => expect(chatApi.models).toHaveBeenCalledTimes(2));
  });

  it('can still be opened, with the list it has, while the list is asked for again', async () => {
    conversations({ 'c-1': SONNET });
    renderPicker('c-1');
    await waitFor(() => expect(trigger()).toBeEnabled());
    vi.mocked(chatApi.models).mockReturnValue(new Promise(() => undefined));

    useConversationRuntime.setState((s) => ({ refusals: s.refusals + 1 }));
    await waitFor(() => expect(chatApi.models).toHaveBeenCalledTimes(2));

    expect(trigger()).toBeEnabled();
    expect(trigger()).toHaveTextContent('Claude Sonnet 5.5');
  });
});
