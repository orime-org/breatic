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

  it('offers the three things the agent is actually for', () => {
    render(<ChatEmpty />);
    // Gathering material, and writing the prompts that use it. Generating
    // the image is not one of them: that happens on the canvas.
    expect(screen.getByTestId('chat-empty-qa-find-reference')).toBeInTheDocument();
    expect(screen.getByTestId('chat-empty-qa-write-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('chat-empty-qa-refine-prompt')).toBeInTheDocument();
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
    // 它们是除输入框之外唯一往输入框里写字的路径。切换途中输入框是静止的,
    // 而这三个按钮照旧能按 —— 按下去那段文案会落进正在离开的那条会话,新会话
    // 一到手就从眼前消失。
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
