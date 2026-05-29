import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { useChatStore } from '@web/stores';
import type { ChatMessage } from '@web/pages/project/chat/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

const MESSAGES: ChatMessage[] = [
  { id: 'm1', role: 'user', content: 'Plan a launch' },
  { id: 'm2', role: 'assistant', content: 'Sure, here is the plan…' },
];

describe('ChatPanel', () => {
  beforeEach(() => {
    useChatStore.getState().clearComposerDraft();
    useChatStore.getState().setStreaming(false);
    useChatStore.getState().setActiveConversationId(null);
  });

  it('has no a11y violations', async () => {
    const { container } = render(<ChatPanel projectId='p1' />);
    await expectNoA11yViolations(container);
  });

  it('renders the panel landmark with the projectId attribute', () => {
    render(<ChatPanel projectId='p1' />);
    expect(
      screen.getByTestId('chat-panel').getAttribute('data-project-id'),
    ).toBe('p1');
  });

  it('renders one bubble per initial message', () => {
    render(<ChatPanel projectId='p1' initialMessages={MESSAGES} />);
    expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
  });

  it('typing in the composer writes to the chat store draft', async () => {
    const user = userEvent.setup();
    render(<ChatPanel projectId='p1' />);
    await user.type(screen.getByTestId('chat-composer-textarea'), 'Hi!');
    expect(useChatStore.getState().composerDraft).toBe('Hi!');
  });

  it('clicking Send fires onSend with the trimmed draft + clears it', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    useChatStore.getState().setComposerDraft('  test  ');
    render(<ChatPanel projectId='p1' onSend={onSend} />);
    await user.click(screen.getByTestId('chat-composer-send'));
    expect(onSend).toHaveBeenCalledWith('test');
    expect(useChatStore.getState().composerDraft).toBe('');
  });
});
