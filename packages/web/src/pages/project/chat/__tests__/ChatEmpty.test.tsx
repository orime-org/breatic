// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { useCurrentUserStore } from '@web/stores';

describe('ChatEmpty', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
  });

  it('renders a generic greeting when no user is signed in', () => {
    render(<ChatEmpty />);
    expect(screen.getByTestId('chat-empty')).toHaveTextContent('Hi!');
  });

  it('personalizes the greeting with the current user name', () => {
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Songxiulei',
      email: 'sx@example.com',
      personalStudio: { name: 'Songxiulei', slug: 'songxiulei', avatarUrl: null },
      membershipTier: 'base',
    });
    render(<ChatEmpty />);
    expect(screen.getByTestId('chat-empty')).toHaveTextContent(
      'Hi, Songxiulei!',
    );
  });

  it('says in one line what the agent can do', () => {
    render(<ChatEmpty />);
    expect(screen.getByTestId('chat-empty')).toHaveTextContent(
      'I can find material, write articles and scripts, build generation flows on the canvas, and edit Documents',
    );
  });

  it('offers one suggestion for each thing the agent can do', () => {
    render(<ChatEmpty />);
    const offered = screen
      .getAllByTestId(/^chat-empty-qa-/)
      .map((button) => [button.dataset.testid, button.textContent]);
    expect(offered).toEqual([
      ['chat-empty-qa-find-reference', 'Find cyberpunk-style reference images'],
      ['chat-empty-qa-write-script', 'Write a script for a three-minute short film'],
      ['chat-empty-qa-build-workflow', 'Build a flow on the canvas that makes a character turnaround'],
      ['chat-empty-qa-annotate-document', 'Comment on this Document and point out what could be better'],
      ['chat-empty-qa-write-prompt', 'Write a prompt for an illustration'],
    ]);
  });

  it('clicking a quick action fires onQuickAction with the label', async () => {
    const user = userEvent.setup();
    const onQuickAction = vi.fn();
    render(<ChatEmpty onQuickAction={onQuickAction} />);
    await user.click(screen.getByTestId('chat-empty-qa-find-reference'));
    expect(onQuickAction).toHaveBeenCalledWith(
      'Find cyberpunk-style reference images',
    );
  });
});

describe('the quick actions while the panel is on its way elsewhere', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
  });

  it('do nothing, because the composer they write into is frozen', async () => {
    // Besides typing, these are the only way words get into the composer. The
    // composer is held still during a switch, so a click here would put its
    // sentence into the conversation being left, which vanishes when the new
    // one lands.
    const picked = vi.fn();
    render(<ChatEmpty onQuickAction={picked} frozen />);

    await userEvent.click(screen.getByTestId('chat-empty-qa-find-reference'));

    expect(picked).not.toHaveBeenCalled();
  });

  it('work as usual when it is not', async () => {
    const picked = vi.fn();
    render(<ChatEmpty onQuickAction={picked} />);

    await userEvent.click(screen.getByTestId('chat-empty-qa-find-reference'));

    expect(picked).toHaveBeenCalledTimes(1);
  });
});
