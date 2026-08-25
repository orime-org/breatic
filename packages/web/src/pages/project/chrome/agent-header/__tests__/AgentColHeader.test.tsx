// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import {
  render as rtlRender,
  screen,
  type RenderOptions,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';

import { AgentColHeader } from '@web/pages/project/chrome/agent-header/AgentColHeader';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import { unexpectedTextIn } from '@web/test-utils/visible-text';

// Chrome buttons now use shadcn `Tooltip`, which throws without a
// `TooltipProvider` somewhere up the tree. App.tsx supplies one at
// runtime — tests need to add it explicitly. Alias `render` so each
// call site auto-wraps without per-site edits.
const render = (ui: React.ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: TooltipProvider, ...options });

function setup(overrides: Partial<Parameters<typeof AgentColHeader>[0]> = {}) {
  const onToggleHistory = vi.fn();
  const onNewConversation = vi.fn();
  const onRenameConversation = vi.fn();
  render(
    <AgentColHeader
      conversationName='Onboarding'
      conversationNamePlaceholder='Untitled conversation'
      onToggleHistory={onToggleHistory}
      onNewConversation={onNewConversation}
      onRenameConversation={onRenameConversation}
      {...overrides}
    />,
  );
  return { onToggleHistory, onNewConversation, onRenameConversation };
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

  it('does not say how many conversations there are', () => {
    // 会话总数对读者没有用处：他要知道的是自己现在在哪一条里。
    // 列表一分页，手上这份数组的长度也不再是总数了。
    // 判据跟 AgentColumn 那条同一个：说清顶栏允许显示哪些字符串，多出来的都报
    // 出来。换个 testid、或者把计数写成 `(7)` 挂在名字旁边，都绕不过去。
    setup({ conversationName: 'Onboarding' });
    const header = screen.getByTestId('agent-col-header');
    expect(unexpectedTextIn(header, ['Onboarding'])).toEqual([]);
  });

  it('clicking history asks for it to be shown or hidden', async () => {
    const user = userEvent.setup();
    const { onToggleHistory } = setup();
    await user.click(screen.getByLabelText('Conversation history'));
    expect(onToggleHistory).toHaveBeenCalledTimes(1);
  });

  it('clicking + new conversation invokes the handler', async () => {
    const user = userEvent.setup();
    const { onNewConversation } = setup();
    await user.click(screen.getByTestId('new-conversation'));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('renames the conversation when the title is double-clicked + Enter pressed', async () => {
    const user = userEvent.setup();
    const { onRenameConversation } = setup({ conversationName: 'Old name' });
    // PR #140: edit trigger is double-click, not single-click.
    await user.dblClick(screen.getByTestId('title-display'));
    const input = screen.getByTestId('title-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'New name{Enter}');
    expect(onRenameConversation).toHaveBeenCalledWith('New name');
  });
});
