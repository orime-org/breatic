import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentColHeader } from '@/pages/project/chrome/agent-header/AgentColHeader';
import { expectNoA11yViolations } from '@/test-utils/a11y';

function setup(overrides: Partial<Parameters<typeof AgentColHeader>[0]> = {}) {
  const onOpenHistory = vi.fn();
  const onNewConversation = vi.fn();
  const onRenameConversation = vi.fn();
  render(
    <AgentColHeader
      conversationName='Onboarding'
      messageCount={3}
      onOpenHistory={onOpenHistory}
      onNewConversation={onNewConversation}
      onRenameConversation={onRenameConversation}
      {...overrides}
    />,
  );
  return { onOpenHistory, onNewConversation, onRenameConversation };
}

describe('AgentColHeader', () => {
  it('renders the agent column header landmark', () => {
    setup();
    expect(screen.getByTestId('agent-col-header')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    setup();
    await expectNoA11yViolations(document.body);
  });

  it('renders the conversation name', () => {
    setup({ conversationName: 'Bug triage' });
    expect(screen.getByText('Bug triage')).toBeInTheDocument();
  });

  it('renders the count chip immediately right of the history icon', () => {
    setup({ messageCount: 12 });
    expect(screen.getByTestId('conversation-count-chip')).toHaveTextContent(
      '12',
    );
  });

  it('clicking history opens it', async () => {
    const user = userEvent.setup();
    const { onOpenHistory } = setup();
    await user.click(screen.getByLabelText('Open conversation history'));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it('clicking + new conversation invokes the handler', async () => {
    const user = userEvent.setup();
    const { onNewConversation } = setup();
    await user.click(screen.getByTestId('new-conversation'));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('renames the conversation when the title is edited and Enter is pressed', async () => {
    const user = userEvent.setup();
    const { onRenameConversation } = setup({ conversationName: 'Old name' });
    await user.click(screen.getByTestId('title-display'));
    const input = screen.getByTestId('title-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'New name{Enter}');
    expect(onRenameConversation).toHaveBeenCalledWith('New name');
  });
});
